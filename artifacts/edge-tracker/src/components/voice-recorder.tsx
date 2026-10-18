import { useState, useRef, useCallback, useEffect } from "react";
import { Mic, Square, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { recordingToWav } from "@/lib/audio-wav";
import { voiceI18n } from "@/i18n/ns/voice";


const BAR_COUNT = 12;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

function extFor(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  return "ogg";
}

function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return voiceI18n.t("recorder.micDenied");
  if (name === "NotFoundError" || name === "OverconstrainedError") return voiceI18n.t("recorder.micNotFound");
  if (name === "NotReadableError" || name === "AbortError") return voiceI18n.t("recorder.micBusy");
  if (name === "NotSupportedError") return voiceI18n.t("recorder.unsupported");
  return voiceI18n.t("recorder.micFailed");
}


interface VoiceRecorderProps {
  onTranscript: (text: string) => void;
  onUploaded?: () => void;
  userId?: string;
  tradeId?: number;
  dailyFeedId?: number;
  className?: string;
  /** Optional: text shown next to the mic icon in idle state (e.g. «Надиктовать»). */
  label?: string;
  /** Optional: auto-stop after this many seconds (default 300). */
  maxDurationSec?: number;
}

export function VoiceRecorder({ onTranscript, onUploaded, userId, tradeId, dailyFeedId, className, label, maxDurationSec = 300 }: VoiceRecorderProps) {
  const { toast } = useToast();
  const { t } = voiceI18n.useT();
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [duration, setDuration] = useState(0);
  const [bars, setBars] = useState<number[]>(Array(BAR_COUNT).fill(0));

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const discardRef = useRef(false);

  const stopWaveform = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setBars(Array(BAR_COUNT).fill(0));
  }, []);

  const startWaveform = useCallback((stream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const step = Math.floor(data.length / BAR_COUNT);
        setBars(Array.from({ length: BAR_COUNT }, (_, i) => data[i * step] / 255));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      /* AudioContext unavailable — degrade gracefully */
    }
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      const mr = mediaRecorderRef.current;
      if (mr && mr.state !== "inactive") {
        mr.onstop = null;
        mr.stop();
      }
      activeStreamRef.current?.getTracks().forEach((t) => t.stop());
      activeStreamRef.current = null;
      stopWaveform();
    };
  }, [stopWaveform]);

  const startRecording = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast({
        title: voiceI18n.t("recorder.unavailable"),
        description: voiceI18n.t(window.isSecureContext === false ? "recorder.httpsOnly" : "recorder.unsupported"),
        variant: "destructive",
      });
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      activeStreamRef.current = stream;
      const picked = pickMimeType();
      const mediaRecorder = picked ? new MediaRecorder(stream, { mimeType: picked }) : new MediaRecorder(stream);
      const mimeType = mediaRecorder.mimeType || picked || "audio/webm";
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      const recStream = stream;
      mediaRecorder.onstop = async () => {
        recStream.getTracks().forEach((t) => t.stop());
        activeStreamRef.current = null;
        stopWaveform();
        if (discardRef.current) {
          discardRef.current = false;
          chunksRef.current = [];
          setDuration(0);
          return;
        }
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const dur = Math.round((Date.now() - startTimeRef.current) / 1000);
        if (blob.size === 0 || Date.now() - startTimeRef.current < 600) {
          setDuration(0);
          toast({ title: voiceI18n.t("recorder.tooShort"), description: voiceI18n.t("recorder.tooShortHint") });
          return;
        }
        setUploading(true);
        try {
          // 16 kHz WAV works with the free local Whisper (no ffmpeg) and OpenAI alike; keep the original if decoding fails.
          let upload: Blob = blob;
          let uploadName = `recording.${extFor(mimeType)}`;
          try {
            upload = await recordingToWav(blob);
            uploadName = "recording.wav";
          } catch { /* browser can't decode its own recording — send as recorded */ }
          const formData = new FormData();
          formData.append("audio", upload, uploadName);
          const transcribeOnly = !userId || (!tradeId && !dailyFeedId);
          if (transcribeOnly) {
            const res = await http.raw("/api/voice-notes/transcribe", { method: "POST", body: formData });
            const data = await res.json();
            if (data.transcript) onTranscript(data.transcript);
            else toast({ title: voiceI18n.t("recorder.noSpeech"), description: voiceI18n.t("recorder.noSpeechHint") });
          } else {
            formData.append("userId", userId!);
            if (tradeId) formData.append("tradeId", String(tradeId));
            if (dailyFeedId) formData.append("dailyFeedId", String(dailyFeedId));
            formData.append("durationSec", String(dur));
            const res = await http.raw("/api/voice-notes", { method: "POST", body: formData });
            const data = await res.json();
            if (data.transcript) onTranscript(data.transcript);
            onUploaded?.();
          }
        } catch (e) {
          toast({ title: voiceI18n.t("recorder.error"), description: humanizeApiError(e, voiceI18n.t("recorder.processFailed")), variant: "destructive" });
        } finally {
          setUploading(false);
          setDuration(0);
        }
      };

      discardRef.current = false;
      mediaRecorder.start(200);
      startTimeRef.current = Date.now();
      setRecording(true);
      setDuration(0);
      startWaveform(stream);
      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
    } catch (e) {
      // Release the mic if it was granted but the recorder couldn't start.
      stream?.getTracks().forEach((t) => t.stop());
      activeStreamRef.current = null;
      toast({ title: voiceI18n.t("recorder.micUnavailable"), description: micErrorMessage(e), variant: "destructive" });
    }
  }, [userId, tradeId, dailyFeedId, onTranscript, onUploaded, startWaveform, stopWaveform, toast]);

  const stopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  }, []);

  const cancelRecording = useCallback(() => {
    discardRef.current = true;
    stopRecording();
  }, [stopRecording]);

  // Auto-stop at the duration limit so a forgotten recording doesn't run forever.
  useEffect(() => {
    if (recording && maxDurationSec > 0 && duration >= maxDurationSec) stopRecording();
  }, [recording, duration, maxDurationSec, stopRecording]);

  // Esc discards the take while recording (capture phase so a parent dialog doesn't close first).
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); cancelRecording(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, cancelRecording]);

  const formatDuration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  // Announced once per state change (not every second) so screen readers know recording started/stopped.
  const liveText = uploading ? t("recorder.liveUploading") : recording ? t("recorder.liveRecording") : "";
  const live = <span className="sr-only" aria-live="polite">{liveText}</span>;
  const nearLimit = recording && maxDurationSec > 0 && maxDurationSec - duration <= 15;

  if (uploading) {
    return (
      <>
        <span
          role="status"
          aria-busy="true"
          className={cn("inline-flex min-h-8 items-center gap-2 rounded-full bg-primary/12 px-3 text-xs font-medium text-primary", className)}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {t("recorder.transcribing")}
        </span>
        {live}
      </>
    );
  }

  if (recording) {
    return (
      <>
        <span
          className={cn(
            "inline-flex min-h-8 items-center gap-2 rounded-full border border-down/40 bg-down/12 py-0.5 pl-3 pr-0.5 text-xs font-medium text-down",
            className,
          )}
        >
          <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
            <span className="absolute inset-0 animate-ping rounded-full bg-down opacity-60 motion-reduce:animate-none" />
            <span className="relative h-2 w-2 rounded-full bg-down" />
          </span>
          <svg width={BAR_COUNT * 4} height={16} className="shrink-0" aria-hidden="true">
            {bars.map((v, i) => {
              const h = Math.max(2, Math.round(v * 14));
              return <rect key={i} x={i * 4} y={(16 - h) / 2} width={3} height={h} rx={1.5} fill="currentColor" opacity={0.6 + v * 0.4} />;
            })}
          </svg>
          <span className={cn("tabular-nums", nearLimit && "font-semibold")} aria-hidden="true">
            {formatDuration(duration)}
            {nearLimit && <span className="opacity-80"> / {formatDuration(maxDurationSec)}</span>}
          </span>
          <button
            type="button"
            onClick={cancelRecording}
            aria-label={t("recorder.cancelAria")}
            title={t("recorder.cancelTitle")}
            className="grid h-7 w-7 place-items-center rounded-full text-down/90 transition-colors hover:bg-down/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={stopRecording}
            autoFocus
            aria-label={t("recorder.stopAria", { duration: formatDuration(duration) })}
            title={t("recorder.stopTitle")}
            className="inline-flex h-7 items-center gap-1 rounded-full bg-down px-2.5 text-xs font-semibold text-primary-foreground transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Square className="h-3 w-3 fill-current" aria-hidden="true" />
            {t("recorder.stop")}
          </button>
        </span>
        {live}
      </>
    );
  }

  return (
    <>
      <button
        aria-label={label ? undefined : t("recorder.startAria")}
        type="button"
        onClick={startRecording}
        title={t("recorder.startTitle")}
        className={cn(
          "chip inline-flex min-h-8 min-w-8 items-center justify-center gap-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          label ? "px-3" : "px-0",
          className,
        )}
      >
        <Mic className="h-3.5 w-3.5" aria-hidden="true" />
        {label && <span>{label}</span>}
      </button>
      {live}
    </>
  );
}
