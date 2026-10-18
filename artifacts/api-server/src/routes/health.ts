import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { asyncHandler } from "../lib/asyncHandler";

const router: IRouter = Router();

router.get("/healthz", asyncHandler(async (_req, res): Promise<void> => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
}));

export default router;
