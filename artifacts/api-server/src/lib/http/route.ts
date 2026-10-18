/**
 * route(): one wrapper per handler — authorize, validate, run, answer. See ./README.md.
 *
 *   router.patch("/watchlist/:id", route({
 *     cap: "watchlist.manage",
 *     params: z.object({ id: idParam }),
 *     body: z.object({ note: z.string().max(2000) }),
 *   }, async ({ params, body, actor }) => {
 *     const row = await update(params.id, body.note, actor.name);
 *     if (!row) throw notFound();
 *     return row;                                  // → res.json(row)
 *   }));
 *
 * Order: capability (401 / 403 GUEST_READ_ONLY / 403 FORBIDDEN) → params → query → body (400 VALIDATION with
 * details [{ path, message }]) → handler. A returned value (not undefined) is sent with res.json; return nothing
 * when the handler answered itself (stream, file, 201/204). Thrown errors go to the error middleware.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z, type ZodTypeAny } from "zod";
import { evaluate, getEffectiveMatrix, resolveActor, type Actor, type Capability, type Target } from "../permissions";
import { AppError, forbidden, unauthorized } from "./errors";
import { zodDetails } from "./middleware";

export type RouteSpec = {
  /** Capability (or any-of list) the caller must hold. Omit for routes any signed-in caller may use. */
  cap?: Capability | readonly Capability[];
  params?: ZodTypeAny;
  query?: ZodTypeAny;
  body?: ZodTypeAny;
};

type Out<T> = T extends ZodTypeAny ? z.output<T> : undefined;

export type RouteCtx<S extends RouteSpec> = {
  params: Out<S["params"]>;
  query: Out<S["query"]>;
  body: Out<S["body"]>;
  /** Resolved actor when `cap` is set (never null then); otherwise null — call resolveActor(req) if needed. */
  actor: S["cap"] extends Capability | readonly Capability[] ? Actor : Actor | null;
  req: Request;
  res: Response;
};

/** Path id: "42" → 42 (positive safe integer). */
export const idParam = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Throws AUTH_REQUIRED / GUEST_READ_ONLY / FORBIDDEN unless the caller holds `cap` (any of a list) on `target`. */
export async function assertCap(req: Request, cap: Capability | readonly Capability[], target?: Target | null): Promise<Actor> {
  if (!req.authUser) throw unauthorized();
  const actor = await resolveActor(req);
  if (!actor) throw unauthorized();
  if (actor.guest) throw new AppError("GUEST_READ_ONLY");
  const caps: readonly Capability[] = typeof cap === "string" ? [cap] : cap;
  const matrix = await getEffectiveMatrix();
  if (!caps.some((c) => evaluate(matrix, actor, c, target))) throw forbidden(caps[0]);
  return actor;
}

function parsePart(schema: ZodTypeAny | undefined, value: unknown, where: "params" | "query" | "body"): unknown {
  if (!schema) return undefined;
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new AppError(
    "VALIDATION",
    400,
    undefined,
    zodDetails(r.error.issues).map((d) => ({ ...d, path: d.path ? `${where}.${d.path}` : where })),
  );
}

export function route<S extends RouteSpec>(spec: S, handler: (ctx: RouteCtx<S>) => unknown): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = spec.cap ? await assertCap(req, spec.cap) : null;
      const ctx = {
        params: parsePart(spec.params, req.params, "params"),
        query: parsePart(spec.query, req.query, "query"),
        body: parsePart(spec.body, req.body ?? {}, "body"),
        actor,
        req,
        res,
      } as RouteCtx<S>;
      const result = await handler(ctx);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (err) {
      next(err);
    }
  };
}
