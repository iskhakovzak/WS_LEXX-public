// One response for "AI is not configured" (no AI_INTEGRATIONS_ANTHROPIC_* env), audit P2-3:
// 503 { code: "ai_not_configured", error: <translated "AI is not configured"> } instead of a generic 500/502.
// The frontend (edge-tracker lib/api-errors.ts) recognises the code and shows «AI не настроен».
import type { Response } from "express";
import { AnthropicNotConfiguredError, isAnthropicConfigured } from "@workspace/integrations-anthropic-ai";
import { AppError, sendError } from "./http/errors";

/** True for the integration's "env not provisioned" error (name check survives duplicated bundles). */
export function isAiNotConfigured(e: unknown): boolean {
  return e instanceof AnthropicNotConfiguredError || (e instanceof Error && e.name === "AnthropicNotConfiguredError");
}

export function sendAiNotConfigured(res: Response): void {
  if (!res.headersSent) sendError(res, new AppError("ai_not_configured"));
}

/** Call in a catch block before the generic error response; returns true when the 503 was sent. */
export function handleAiNotConfigured(e: unknown, res: Response): boolean {
  if (!isAiNotConfigured(e)) return false;
  sendAiNotConfigured(res);
  return true;
}

/** Early guard for AI-only endpoints: sends the 503 and returns false when AI is not configured. */
export function requireAiConfigured(res: Response): boolean {
  if (isAnthropicConfigured()) return true;
  sendAiNotConfigured(res);
  return false;
}
