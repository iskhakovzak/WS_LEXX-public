/**
 * Starts a free local speech-to-text server (whisper.cpp `whisper-server`) for voice notes.
 *
 *   pnpm --filter @workspace/scripts run local-whisper
 *   then start the API with TRANSCRIBE_PROVIDER=local (WHISPER_URL defaults to http://127.0.0.1:8178)
 *
 * Expects the whisper.cpp release build and a ggml model under WHISPER_HOME (default %LOCALAPPDATA%\whisper):
 *   bin-cuda/Release/whisper-server.exe  — CUDA build (preferred when present, NVIDIA GPU)
 *   bin-cpu/Release/whisper-server.exe   — CPU build (fallback)
 *   models/ggml-large-v3-turbo-q5_0.bin  — model (override with WHISPER_MODEL)
 * See DEPLOY.md → «Локальный Whisper» for download links and the server (CPU) setup.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const home = process.env.WHISPER_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"), "whisper");
const exe = process.platform === "win32" ? "whisper-server.exe" : "whisper-server";
const candidates = [path.join(home, "bin-cuda", "Release", exe), path.join(home, "bin-cpu", "Release", exe), path.join(home, "bin", exe)];
const server = candidates.find((p) => existsSync(p));
const model = process.env.WHISPER_MODEL ?? path.join(home, "models", "ggml-large-v3-turbo-q5_0.bin");
const port = process.env.WHISPER_PORT ?? "8178";
const threads = process.env.WHISPER_THREADS ?? String(Math.max(4, Math.min(12, os.cpus().length - 2)));

if (!server) {
  console.error(`whisper-server not found. Looked in:\n  ${candidates.join("\n  ")}\nSee DEPLOY.md → «Локальный Whisper».`);
  process.exit(1);
}
if (!existsSync(model)) {
  console.error(`Model not found: ${model}\nSee DEPLOY.md → «Локальный Whisper».`);
  process.exit(1);
}

console.log(`whisper-server: ${server}\nmodel: ${model}\nlistening on http://127.0.0.1:${port} (${threads} threads)`);
const child = spawn(server, ["-m", model, "--host", "127.0.0.1", "--port", port, "-l", "ru", "-t", threads], {
  cwd: path.dirname(server), // the CUDA/ggml DLLs live next to the exe
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
