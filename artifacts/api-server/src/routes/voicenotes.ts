import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, voiceNotesTable } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { config } from "../config";
import { audioExtension, transcribeAudio } from "../lib/transcribe";
import { objectStorageClient, ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import multer from "multer";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { isGuest } from "../lib/auth";
import { transcribeLimiter, voiceNoteLimiter } from "../lib/rateLimits";
import { AppError, badRequest, forbidden, sendError, unauthorized } from "../lib/http";

function isStaff(req: Request): boolean {
  const role = req.authUser?.role;
  return role === "curator" || role === "admin";
}

/** Traders may only act on their own notes; curators/admins on anyone's. */
function canActAs(req: Request, userId: string): boolean {
  const auth = req.authUser;
  if (!auth) return true; // read-only anonymous access keeps previous behaviour (mutations are gated in app.ts)
  if (isGuest(req)) return false;
  if (isStaff(req)) return true;
  return auth.name === userId;
}

// ─── short-lived media tokens ───────────────────────────────────────────────
// <audio src> cannot carry an Authorization header. The session token never goes into a URL (the API no longer
// accepts ?access_token=); the player asks
// GET /voice-notes/:id/audio-url and receives a URL with a 5-minute HMAC token bound to that one note.
// Token = "<expUnixSec>.<hex hmac-sha256(secret, "voice-note:<id>:<exp>")>"; nothing about the user leaks.

const MEDIA_TOKEN_TTL_SEC = 300;
// Separate secret in production (config.ts); derived from JWT_SECRET only in development.
const mediaSecret = (): string => config.mediaTokenSecret;

function mediaSignature(id: number, exp: number): string {
  return createHmac("sha256", mediaSecret()).update(`voice-note:${id}:${exp}`).digest("hex");
}

export function signMediaToken(id: number, nowMs = Date.now()): { token: string; expiresAt: string } {
  const exp = Math.floor(nowMs / 1000) + MEDIA_TOKEN_TTL_SEC;
  return { token: `${exp}.${mediaSignature(id, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyMediaToken(id: number, raw: unknown, nowMs = Date.now()): boolean {
  if (!mediaSecret() || typeof raw !== "string") return false;
  const dot = raw.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(raw.slice(0, dot));
  const sig = raw.slice(dot + 1);
  if (!Number.isInteger(exp) || exp * 1000 < nowMs || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = Buffer.from(mediaSignature(id, exp), "hex");
  const given = Buffer.from(sig, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const storage = multer.memoryStorage();
const ALLOWED_AUDIO_MIME = new Set([
  "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg",
  "audio/wav", "audio/x-wav", "audio/wave",
]);
const uploader = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || "").toLowerCase().split(";")[0].trim();
    if (ALLOWED_AUDIO_MIME.has(mime)) cb(null, true);
    else cb(new Error("REJECTED_MIME"));
  },
});

const upload = {
  single: (field: string): RequestHandler => (req: Request, res: Response, next: NextFunction) => {
    uploader.single(field)(req, res, (err: unknown) => {
      if (!err) return next();
      // REJECTED_MIME → 415; multer errors (size, field…) → the error middleware (413 TOO_LARGE / 400 UPLOAD_ERROR).
      if (err instanceof Error && err.message === "REJECTED_MIME") { sendError(res, new AppError("AUDIO_TYPE", 415)); return; }
      next(err);
    });
  },
};

const router: IRouter = Router();

const bucketId = (): string => config.storage.bucketId;
const privateDir = (): string => config.storage.privateDir || "objects";

async function uploadAudioToStorage(buffer: Buffer, mimeType: string): Promise<string> {
  const ext = audioExtension(mimeType);
  const objectName = `${privateDir()}/voice-notes/${randomUUID()}.${ext}`;
  const bucket = objectStorageClient.bucket(bucketId());
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType: mimeType, resumable: false });
  return `/objects/${objectName.replace(privateDir() + "/", "")}`;
}

router.post("/voice-notes/transcribe", transcribeLimiter, upload.single("audio"), asyncHandler(async (req, res): Promise<void> => {
  if (!req.file) throw new AppError("AUDIO_REQUIRED");
  const mimeType = req.file.mimetype || "audio/webm";
  let transcript = "";
  try {
    transcript = await transcribeAudio(req.file.buffer, mimeType);
  } catch {
    transcript = "";
  }
  res.json({ transcript });
}));

router.post("/voice-notes", voiceNoteLimiter, upload.single("audio"), asyncHandler(async (req, res): Promise<void> => {
  if (!req.file) throw new AppError("AUDIO_REQUIRED");

  const { userId, tradeId, dailyFeedId, durationSec } = req.body;
  if (!userId || typeof userId !== "string" || !userId.trim()) throw new AppError("TRADER_REQUIRED");
  if (!canActAs(req, userId.trim())) throw new AppError("OWN_DATA_ONLY");
  if (durationSec != null && durationSec !== "" && (!Number.isFinite(Number(durationSec)) || Number(durationSec) < 0 || Number(durationSec) > 3600)) throw new AppError("INVALID_FIELD", undefined, { field: "durationSec" });
  const mimeType = req.file.mimetype || "audio/webm";
  const buffer = req.file.buffer;

  const parsedTradeId = tradeId ? Number(tradeId) : null;
  const parsedDailyFeedId = dailyFeedId ? Number(dailyFeedId) : null;
  if (!parsedTradeId && !parsedDailyFeedId) throw new AppError("FIELD_REQUIRED", undefined, { field: "tradeId / dailyFeedId" });

  let audioUrl: string;
  try {
    audioUrl = await uploadAudioToStorage(buffer, mimeType);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AppError("STORAGE_FAILED", 500);
  }

  let transcript = "";
  try {
    transcript = await transcribeAudio(buffer, mimeType);
  } catch {
    transcript = "";
  }

  const [note] = await db.insert(voiceNotesTable).values({
    userId,
    tradeId: parsedTradeId,
    dailyFeedId: parsedDailyFeedId,
    audioUrl,
    transcript,
    durationSec: durationSec ? Number(durationSec) : null,
  }).returning();

  res.status(201).json({ ...note, createdAt: note.createdAt.toISOString() });
}));

router.get("/voice-notes", asyncHandler(async (req, res): Promise<void> => {
  const { userId, tradeId, dailyFeedId } = req.query as Record<string, string>;

  if (!userId) throw new AppError("TRADER_REQUIRED");

  if ((tradeId && !Number.isInteger(Number(tradeId))) || (dailyFeedId && !Number.isInteger(Number(dailyFeedId)))) throw new AppError("INVALID_FIELD", undefined, { field: "tradeId" });
  // Voice notes are personal: a trader lists only their own, staff anyone's, guests nothing.
  if (req.authUser && !canActAs(req, userId)) { res.json([]); return; }

  const conditions = [eq(voiceNotesTable.userId, userId)];
  if (tradeId) conditions.push(eq(voiceNotesTable.tradeId, Number(tradeId)));
  if (dailyFeedId) conditions.push(eq(voiceNotesTable.dailyFeedId, Number(dailyFeedId)));

  const rows = await db.select().from(voiceNotesTable).where(and(...conditions)).orderBy(desc(voiceNotesTable.createdAt));
  res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
}));

router.delete("/voice-notes/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) throw badRequest("INVALID_ID");

  const { userId } = req.query as Record<string, string>;
  if (!userId) throw new AppError("TRADER_REQUIRED");

  const [existing] = await db.select().from(voiceNotesTable).where(eq(voiceNotesTable.id, id));
  if (!existing) throw new AppError("VOICE_NOTE_NOT_FOUND");
  if (existing.userId !== userId || !canActAs(req, existing.userId)) throw new AppError("AUTHOR_OR_STAFF_ONLY");

  await db.delete(voiceNotesTable).where(eq(voiceNotesTable.id, id));
  res.sendStatus(204);
}));

const objectStorageService = new ObjectStorageService();

/**
 * Short-lived playback URL for one note (owner or staff). The returned `path` is relative to the API
 * origin ("/api/voice-notes/12/audio?media_token=…") and valid for `ttlSec` seconds.
 */
router.get("/voice-notes/:id/audio-url", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  if (!req.authUser) throw unauthorized();
  if (!mediaSecret()) throw new AppError("NOT_CONFIGURED", undefined, { what: "JWT_SECRET" });
  const [note] = await db.select({ id: voiceNotesTable.id, userId: voiceNotesTable.userId }).from(voiceNotesTable).where(eq(voiceNotesTable.id, id));
  if (!note) throw new AppError("VOICE_NOTE_NOT_FOUND");
  if (!canActAs(req, note.userId)) throw forbidden();
  const { token, expiresAt } = signMediaToken(id);
  res.setHeader("Cache-Control", "no-store");
  res.json({ path: `/api/voice-notes/${id}/audio?media_token=${token}`, expiresAt, ttlSec: MEDIA_TOKEN_TTL_SEC });
}));

/**
 * Audio redirect. Accepts either a valid `?media_token=` (from /audio-url, no session needed) or an
 * authenticated caller (Authorization header) who owns the note or is staff.
 * NOTE: the global API gate still 401s anonymous requests on this path; a media-token-only request works
 * once `/^\/voice-notes\/\d+\/audio$/` (GET) is on PUBLIC_API_ROUTES in lib/auth.ts — the route enforces
 * the token itself, so nothing is exposed without it.
 */
router.get("/voice-notes/:id/audio", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");

  const [note] = await db.select().from(voiceNotesTable).where(eq(voiceNotesTable.id, id));
  if (!note) throw new AppError("VOICE_NOTE_NOT_FOUND");

  const byToken = verifyMediaToken(id, req.query.media_token);
  if (!byToken) {
    if (!req.authUser) throw unauthorized();
    if (!canActAs(req, note.userId)) throw forbidden();
    // Legacy clients still send ?userId=; when present it must be the note owner.
    const { userId } = req.query as Record<string, string | undefined>;
    if (userId && userId.trim() && note.userId !== userId.trim()) throw forbidden();
  }

  res.setHeader("Cache-Control", "private, no-store");
  try {
    const file = await objectStorageService.getObjectEntityFile(note.audioUrl);
    const signedUrl = await objectStorageService.signDownloadUrl(file, 900);
    res.redirect(302, signedUrl);
  } catch (e) {
    if (e instanceof ObjectNotFoundError) {
      throw new AppError("VOICE_NOTE_NOT_FOUND");
    } else {
      throw e;
    }
  }
}));

export default router;
