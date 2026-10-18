import OpenAI from "openai";
import { logger } from "./logger";
import { config } from "../config";

/**
 * Speech-to-text for voice notes.
 *
 *   TRANSCRIBE_PROVIDER = openai (default) | local
 *   WHISPER_URL         = base URL of a whisper.cpp server (default http://127.0.0.1:8178), used when provider = local
 *   WHISPER_LANGUAGE    = language hint for the local model (default "ru"; "auto" = detect)
 *   WHISPER_PROMPT      = vocabulary hint for the local model (default: desk slang + common tickers; "" = none)
 *   TRANSCRIBE_FALLBACK = openai (default) | off — what to do when the local server is down or errors
 *
 * The local server is whisper.cpp's `whisper-server` (POST /inference, multipart "file", JSON {text}). It is free and
 * runs on a GPU or CPU; OpenAI stays as the paid fallback so a stopped local server never loses a transcript.
 */

export type TranscribeProvider = "openai" | "local";

export type TranscribeConfig = {
  providers: TranscribeProvider[];
  whisperUrl: string;
  language: string;
  /** Vocabulary hint for the local model (desk slang and tickers it would otherwise mishear). "" = none. */
  prompt: string;
};

const DEFAULT_WHISPER_URL = "http://127.0.0.1:8178";
const DEFAULT_WHISPER_PROMPT = // i18n-ignore (speech-recognition vocabulary hint — model input)
  "Заметка трейдера: лонг, шорт, стоп, тейк, добор, перезаход, VWAP, премаркет, открытие, закрытие, MOC, OPG, 2R, NVDA, TSLA, AAPL.";
const LOCAL_TIMEOUT_MS = 120_000;
const OPENAI_TIMEOUT_MS = 60_000;

/** Pure: which providers to try, in order, for the given environment. */
export function transcribeConfig(env: Record<string, string | undefined> = config.transcribeEnv): TranscribeConfig {
  const primary = (env.TRANSCRIBE_PROVIDER ?? "").trim().toLowerCase() === "local" ? "local" : "openai";
  const fallbackOff = (env.TRANSCRIBE_FALLBACK ?? "").trim().toLowerCase() === "off";
  const providers: TranscribeProvider[] = primary === "local" && !fallbackOff ? ["local", "openai"] : [primary];
  const whisperUrl = (env.WHISPER_URL ?? "").trim().replace(/\/+$/, "") || DEFAULT_WHISPER_URL;
  const language = (env.WHISPER_LANGUAGE ?? "").trim() || "ru";
  const prompt = env.WHISPER_PROMPT === undefined ? DEFAULT_WHISPER_PROMPT : env.WHISPER_PROMPT.trim();
  return { providers, whisperUrl, language, prompt };
}

export function audioExtension(mimeType: string): string {
  return mimeType.includes("webm") ? "webm" : mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : mimeType.includes("mpeg") ? "mp3" : "wav";
}

let openaiClient: OpenAI | null = null;
function openai(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      baseURL: config.ai.openaiBaseUrl,
      apiKey: config.ai.openaiApiKey,
    });
  }
  return openaiClient;
}

async function transcribeOpenAI(file: File): Promise<string> {
  const response = await openai().audio.transcriptions.create(
    { file, model: "gpt-4o-mini-transcribe", response_format: "json" },
    { timeout: OPENAI_TIMEOUT_MS },
  );
  return response.text ?? "";
}

async function transcribeLocal(file: File, cfg: TranscribeConfig): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("language", cfg.language);
  if (cfg.prompt) form.append("prompt", cfg.prompt);
  const r = await fetch(`${cfg.whisperUrl}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`whisper-server HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = (await r.json()) as { text?: unknown; error?: unknown };
  if (typeof body.error === "string" && body.error) throw new Error(`whisper-server: ${body.error}`);
  return typeof body.text === "string" ? body.text.trim() : "";
}

export async function transcribeAudio(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const cfg = transcribeConfig();
  const file = new File([new Uint8Array(audioBuffer)], `audio.${audioExtension(mimeType)}`, { type: mimeType });
  let lastError = "no provider";
  for (const provider of cfg.providers) {
    const started = Date.now();
    try {
      const text = provider === "local" ? await transcribeLocal(file, cfg) : await transcribeOpenAI(file);
      logger.info({ provider, ms: Date.now() - started, bytes: audioBuffer.length }, "Transcribed voice note");
      return text;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
      logger.warn({ provider, error: lastError }, "Transcription provider failed");
    }
  }
  logger.error({ error: lastError }, "Transcription failed");
  throw new Error(`Transcription failed: ${lastError}`);
}
