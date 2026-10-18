import { describe, expect, it } from "vitest";
import { audioExtension, transcribeConfig } from "../transcribe";

describe("transcribeConfig", () => {
  it("defaults to OpenAI only", () => {
    expect(transcribeConfig({})).toMatchObject({ providers: ["openai"], whisperUrl: "http://127.0.0.1:8178", language: "ru" });
  });
  it("ships a trading vocabulary hint that can be overridden or switched off", () => {
    expect(transcribeConfig({}).prompt).toContain("VWAP");
    expect(transcribeConfig({ WHISPER_PROMPT: " SPY, QQQ " }).prompt).toBe("SPY, QQQ");
    expect(transcribeConfig({ WHISPER_PROMPT: "" }).prompt).toBe("");
  });
  it("local tries whisper first and falls back to OpenAI", () => {
    expect(transcribeConfig({ TRANSCRIBE_PROVIDER: "local" }).providers).toEqual(["local", "openai"]);
    expect(transcribeConfig({ TRANSCRIBE_PROVIDER: " LOCAL " }).providers).toEqual(["local", "openai"]);
  });
  it("fallback can be switched off so nothing is ever sent to OpenAI", () => {
    expect(transcribeConfig({ TRANSCRIBE_PROVIDER: "local", TRANSCRIBE_FALLBACK: "off" }).providers).toEqual(["local"]);
  });
  it("unknown provider means OpenAI", () => {
    expect(transcribeConfig({ TRANSCRIBE_PROVIDER: "deepgram" }).providers).toEqual(["openai"]);
  });
  it("normalises the whisper URL and language", () => {
    const c = transcribeConfig({ TRANSCRIBE_PROVIDER: "local", WHISPER_URL: "http://gpu-box:9000///", WHISPER_LANGUAGE: "auto" });
    expect(c.whisperUrl).toBe("http://gpu-box:9000");
    expect(c.language).toBe("auto");
  });
});

describe("audioExtension", () => {
  it("maps recorder mime types to file extensions", () => {
    expect(audioExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExtension("audio/mp4")).toBe("mp4");
    expect(audioExtension("audio/ogg")).toBe("ogg");
    expect(audioExtension("audio/mpeg")).toBe("mp3");
    expect(audioExtension("audio/wav")).toBe("wav");
  });
});
