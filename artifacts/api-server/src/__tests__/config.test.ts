import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../config";

const prod = { NODE_ENV: "production", DATABASE_URL: "postgresql://x/y", JWT_SECRET: "jwt-secret", MEDIA_TOKEN_SECRET: "media-secret", TELEGRAM_WEBHOOK_SECRET: "tg-secret" };

describe("config", () => {
  it("parses a complete production environment", () => {
    const { config, warnings } = loadConfig({ ...prod, PORT: "8080", PROPREPORTS_DOMAIN: " demo " });
    expect(config.isProduction).toBe(true);
    expect(config.port).toBe(8080);
    expect(config.mediaTokenSecret).toBe("media-secret");
    expect(config.propreportsEnv("PROPREPORTS_DOMAIN")).toBe("demo");
    expect(config.pg.statementTimeoutMs).toBe(30_000);
    expect(config.backupCron).toBe("15 3 * * *");
    expect(warnings).toEqual([]);
  });

  it("fails fast in production when a required variable is missing, naming every problem", () => {
    const { JWT_SECRET: _j, MEDIA_TOKEN_SECRET: _m, ...missing } = prod;
    try {
      loadConfig(missing);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toContain("JWT_SECRET is required");
      expect(msg).toContain("MEDIA_TOKEN_SECRET is required in production");
      expect(msg).toContain(".env.example");
    }
  });

  it("secrets are not derived from each other in production", () => {
    expect(() => loadConfig({ ...prod, TELEGRAM_WEBHOOK_SECRET: undefined })).toThrow(/TELEGRAM_WEBHOOK_SECRET is required/);
    expect(() => loadConfig({ ...prod, MEDIA_TOKEN_SECRET: prod.JWT_SECRET })).toThrow(/must differ from JWT_SECRET/);
  });

  it("development derives missing secrets with a warning and never throws for them", () => {
    const { config, warnings } = loadConfig({ NODE_ENV: "development", JWT_SECRET: "dev" });
    expect(config.mediaTokenSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(config.mediaTokenSecret).not.toBe("dev");
    expect(config.telegramWebhookSecret).toHaveLength(32);
    expect(warnings.join("\n")).toMatch(/MEDIA_TOKEN_SECRET.*development only/);
    expect(loadConfig({}).warnings.join("\n")).toMatch(/JWT_SECRET is not set/);
  });

  it("rejects malformed numbers", () => {
    expect(() => loadConfig({ JWT_SECRET: "x", PG_STATEMENT_TIMEOUT_MS: "abc" })).toThrow(ConfigError);
  });
});
