/** HTTP layer: error contract (errors.ts), error middleware (middleware.ts), route() helper (route.ts). See README.md. */
export * from "./errors";
export { errorMiddleware, toAppError, zodDetails } from "./middleware";
export { route, assertCap, idParam, type RouteSpec, type RouteCtx } from "./route";
