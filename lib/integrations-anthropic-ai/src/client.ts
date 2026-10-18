import Anthropic from "@anthropic-ai/sdk";

let cached: Anthropic | null = null;

export class AnthropicNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`${missing} must be set. Did you forget to provision the Anthropic AI integration?`);
    this.name = "AnthropicNotConfiguredError";
  }
}

export function isAnthropicConfigured(): boolean {
  return Boolean(
    process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL &&
    process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
  );
}

export function getAnthropic(): Anthropic {
  if (cached) return cached;
  if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
    throw new AnthropicNotConfiguredError("AI_INTEGRATIONS_ANTHROPIC_BASE_URL");
  }
  if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
    throw new AnthropicNotConfiguredError("AI_INTEGRATIONS_ANTHROPIC_API_KEY");
  }
  cached = new Anthropic({
    apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  });
  return cached;
}

export const anthropic: Anthropic = new Proxy({} as Anthropic, {
  get(_t, prop) {
    return (getAnthropic() as any)[prop];
  },
});
