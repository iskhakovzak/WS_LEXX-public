# src/lib/http — errors and route()

One error shape for the whole API, translated into the request language:

```json
{ "error": "Сделка не найдена", "code": "TRADE_NOT_FOUND", "details": { … }, "requestId": "…" }
```

- `error`: text for people in the language of `X-Lang` / `users.locale` (the frontend shows it as is).
- `code`: stable machine code. Branch on it, never on the text. The full list is in [CODES.md](./CODES.md).
- `details`: optional. Validation issues `[{ path, message }]`, `{ capability }` for a missing right, and so on.
- `requestId`: only on 5xx. It is the pino request id, so the matching log line can be found.

| File | What |
|---|---|
| `errors.ts` | `AppError`, helpers, `ERROR_CODES` (code → default status), `sendError` |
| `middleware.ts` | `errorMiddleware`, registered last in `app.ts`. It maps AppError, zod, pg, multer, body-parser and CORS errors (see the header of the file). |
| `route.ts` | `route({ cap?, params?, query?, body? }, handler)`, `assertCap`, `idParam` |
| `src/i18n/{ru,en,uz}/errors.ts` | the text of every code (namespace `errors`) |

## Writing a handler

```ts
import { z } from "zod";
import { route, idParam, notFound, badRequest } from "../lib/http";

const Params = z.object({ id: idParam });                       // "42" → 42, rejects 0 / "abc"
const Body = z.object({ label: z.string().trim().min(1).max(500), sortOrder: z.number().int().optional() });

router.patch("/checklist-template/:id", route({ cap: "checklist.template.edit", params: Params, body: Body },
  async ({ params, body, actor }) => {                            // typed from the schemas; actor is non-null with `cap`
    const row = await updateItem(params.id, body, actor.name);
    if (!row) throw notFound("CHECKLIST_ITEM_NOT_FOUND");
    return row;                                                  // → res.json(row)
  }));
```

What `route()` does, in order:
1. With `cap` (one capability, or a list of which any one is enough) it checks the matrix through `resolveActor`/`evaluate`, the same as `requireCap`. Failures: anonymous or inactive → 401 `AUTH_REQUIRED`, guest → 403 `GUEST_READ_ONLY`, missing capability → 403 `FORBIDDEN` with `details.capability`. Without `cap`, any caller that the global gate (`apiAuthGate`) let through gets in. `actor` is then `null`; call `resolveActor(req)` if you need it.
2. It parses `params`, `query` and `body` with zod. On failure: 400 `VALIDATION`, `details: [{ path: "body.label", message }]`.
3. It calls the handler with `{ params, query, body, actor, req, res }`. A returned value other than `undefined` is sent with `res.json`. For 201 call `res.status(201)` and still return the value. When you answer yourself (stream, file, 204) return nothing.
4. Anything thrown goes to the error middleware.

Target-dependent checks inside a handler: `await assertCap(req, "trades.write.any", { trader })` throws like step 1.

## Errors in existing handlers (no route() yet)

```ts
if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
if (!row) throw notFound("TRADE_NOT_FOUND");
if (!(await can(req, "risk.limits.edit"))) throw forbidden("risk.limits.edit");
throw new AppError("CONFLICT", 409, undefined, { field: "name" });
```

- Express 5 sends thrown errors and rejected promises to the middleware, so `asyncHandler` is not needed in new code.
- **Inside `try { … } catch`**, a throw is caught by your own catch. Either rethrow `AppError`s from the catch (`if (err instanceof AppError) throw err;`), or use `sendError(res, notFound()); return;`. The same goes for helpers that answer and return `false`/`null`.
- Never write `res.status(4xx).json({ error: "…" })`. The ratchet `node scripts/check-error-bodies.mjs` fails when a file gains one. Use `--list <path>` to see what is left in a file.
- pg errors need no catch just for the status: a unique violation (23505) becomes 409 `CONFLICT` by itself.
- Unknown errors become 500 `INTERNAL` with no message (the stack is logged with the request id).

## Adding a code

1. `src/i18n/ru/errors.ts`: `MY_CODE: "Текст"` (RU is the source). Use `{name}` placeholders for params: `new AppError("MY_CODE", undefined, { name })`.
2. The same key in `en/errors.ts` and `uz/errors.ts` (tsc rejects missing or extra keys; terms from `edge-tracker/src/i18n/GLOSSARY.md`).
3. `ERROR_CODES.MY_CODE = <status>` in `errors.ts` (tsc checks that the keys match the RU dictionary).
4. A row in `CODES.md`.

Prefer a generic code (`NOT_FOUND`, `VALIDATION`, `CONFLICT`) unless the frontend needs to tell the case apart or the text would be misleading without the entity name.
