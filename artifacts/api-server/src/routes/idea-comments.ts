import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { notifyPublicComment, notifyTraderTelegram, notifyUser } from "../lib/notifyUtils";
import { notifLinks } from "../lib/notificationCore";
import { inBackground } from "../lib/notifyEvents";
import { preview as textPreview } from "../lib/notifyEventsCore";
import { isGuest, requireMember } from "../lib/auth";
import { can } from "../lib/permissions";
import { AppError, badRequest, notFound, unauthorized } from "../lib/http";
import { localeOfUser } from "../i18n";
import { telegramT } from "../i18n/ns";
import { personNameFor } from "../lib/people/latinNames";
import { escHtml } from "../lib/telegramBot";

const router: IRouter = Router();

router.get("/trade-ideas/:id/comments", asyncHandler(async (req, res): Promise<void> => {
  const ideaId = Number(req.params.id);
  if (!Number.isInteger(ideaId) || ideaId <= 0) throw badRequest("INVALID_ID");
  if (!req.authUser) throw unauthorized();
  const viewer = isGuest(req) ? null : req.authUser.name;
  const isCuratorOrAdmin = await can(req, "ideas.review");

  const { rows: ideaRows } = await pool.query(
    `SELECT trader, status FROM trade_ideas WHERE id = $1 AND deleted_at IS NULL`,
    [ideaId],
  );
  if (!ideaRows[0]) throw notFound("IDEA_NOT_FOUND");
  const ideaAuthor = (ideaRows[0] as { trader: string | null }).trader;
  // Comments on another trader's draft are as invisible as the draft itself.
  if ((ideaRows[0] as { status: string }).status === "draft" && !isCuratorOrAdmin && (!viewer || viewer !== ideaAuthor)) {
    throw notFound("IDEA_NOT_FOUND");
  }

  const { rows } = await pool.query(
    `SELECT id, idea_id, author_name, text, is_private, source, created_at
     FROM trade_idea_comments
     WHERE idea_id = $1
     ORDER BY created_at ASC`,
    [ideaId],
  );

  type CommentRow = { id: number; idea_id: number; author_name: string; text: string; is_private: boolean; source: string; created_at: string };
  const filtered = (rows as CommentRow[]).filter((c) => {
    if (!c.is_private) return true;
    if (isCuratorOrAdmin) return true;
    if (viewer && (viewer === c.author_name || viewer === ideaAuthor)) return true;
    return false;
  });

  res.json(filtered);
}));

router.post("/trade-ideas/:id/comments", asyncHandler(async (req, res): Promise<void> => {
  const ideaId = Number(req.params.id);
  if (!Number.isInteger(ideaId) || ideaId <= 0) throw badRequest("INVALID_ID");
  if (!requireMember(req, res)) return;
  const author = req.authUser!.name;
  const { text, is_private } = req.body as { text?: string; is_private?: boolean };

  if (!text || !String(text).trim()) throw new AppError("COMMENT_EMPTY");
  if (String(text).length > 5000) throw new AppError("TEXT_TOO_LONG", 400, { field: "text", max: 5000 });

  const { rows: ideaRows } = await pool.query(
    `SELECT id, ticker, trader, status FROM trade_ideas WHERE id = $1 AND deleted_at IS NULL`,
    [ideaId],
  );
  if (!ideaRows[0]) throw notFound("IDEA_NOT_FOUND");
  const idea = ideaRows[0] as { id: number; ticker: string; trader: string | null; status: string };
  if (idea.status === "draft" && idea.trader !== author && !(await can(req, "ideas.review", idea.trader ? { trader: idea.trader } : undefined))) {
    throw notFound("IDEA_NOT_FOUND");
  }

  const isPrivate = Boolean(is_private);
  const { rows } = await pool.query(
    `INSERT INTO trade_idea_comments (idea_id, author_name, text, is_private, source)
     VALUES ($1, $2, $3, $4, 'website')
     RETURNING id, idea_id, author_name, text, is_private, source, created_at`,
    [ideaId, author, String(text).trim(), isPrivate],
  );

  if (isPrivate) {
    // Private reply — only the idea creator is notified
    if (idea.trader && idea.trader !== author) {
      const preview = String(text).trim().slice(0, 100);
      const recipient = idea.trader;
      inBackground("idea-comments.private", () => notifyUser({
        userName: recipient, type: "idea_comment", ideaId, actor: author, source: "website",
        params: { variant: "private", ticker: idea.ticker, actor: author, ideaId, preview: textPreview(String(text), 100) },
        link: notifLinks.idea(ideaId), entityType: "idea", entityId: ideaId,
      }));
      const lang = await localeOfUser(idea.trader);
      await notifyTraderTelegram(idea.trader,
        telegramT.tFor(lang)("privateReply", { id: ideaId, ticker: escHtml(idea.ticker), author: escHtml(personNameFor(author, lang)), text: escHtml(preview) }));
    }
  } else {
    // Public comment — fan-out to creator + curator + risk manager + prior commenters
    notifyPublicComment({
      ideaId, ticker: idea.ticker, traderName: idea.trader,
      authorName: author, commentText: String(text).trim(), source: "website",
    }).catch(() => {});
  }

  res.status(201).json(rows[0]);
}));

/** Delete a comment: its author (within 24h) or a curator/admin. */
router.delete("/trade-ideas/:id/comments/:commentId", asyncHandler(async (req, res): Promise<void> => {
  const ideaId = Number(req.params.id);
  const commentId = Number(req.params.commentId);
  if (!Number.isInteger(ideaId) || ideaId <= 0 || !Number.isInteger(commentId) || commentId <= 0) {
    throw badRequest("INVALID_ID");
  }
  if (!requireMember(req, res)) return;
  const actor = req.authUser!;
  const { rows } = await pool.query(
    `SELECT author_name, created_at FROM trade_idea_comments WHERE id = $1 AND idea_id = $2`,
    [commentId, ideaId],
  );
  const c = rows[0] as { author_name: string; created_at: string } | undefined;
  if (!c) throw notFound("COMMENT_NOT_FOUND");
  const isReviewer = await can(req, "ideas.review");
  const isFreshOwn = c.author_name === actor.name && Date.now() - new Date(c.created_at).getTime() < 24 * 60 * 60 * 1000;
  if (!isReviewer && !isFreshOwn) {
    throw new AppError("IDEA_COMMENT_DELETE_FORBIDDEN");
  }
  await pool.query(`DELETE FROM trade_idea_comments WHERE id = $1`, [commentId]);
  res.json({ success: true });
}));

export default router;
