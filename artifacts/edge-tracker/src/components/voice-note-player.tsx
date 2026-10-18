import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Mic, Play, Pause, Loader2, ChevronDown, AlertCircle, Copy, Check, Search, RotateCcw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { BASE } from "@/lib/api";
import { ApiError, http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { Skeleton } from "@/components/ui/skeleton";
import { Pill } from "@/components/ds";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/format";
import { voiceI18n } from "@/i18n/ns/voice";
import { commonI18n } from "@/i18n/ns/common";

// ─── authenticated audio sources ──────────────────────────────────────────────
// <audio src> cannot send the Authorization header. GET /api/voice-notes/:id/audio-url returns a URL with a
// 5-minute HMAC media token bound to that one note (nothing about the session leaks; the session token is never
// put into a URL — the API no longer accepts `?access_token=`). On a playback error (expired media token) the
// source is rebuilt once with a fresh media URL, then the error is shown.
// The token-bearing URL is never logged, never put into React keys/attributes other than `src`, and
// is removed from the element on unmount.

class MediaUrlError extends Error {}

async function fetchMediaUrl(noteId: number): Promise<string> {
  const d = await http.get<{ path?: string } | null>(`/api/voice-notes/${noteId}/audio-url`).catch((e: unknown) => {
    // Answered but refused / not JSON → final; network errors stay retryable.
    if (e instanceof ApiError && !e.isNetwork) throw new MediaUrlError(e.code === "BAD_RESPONSE" ? "bad media url" : `HTTP ${e.status}`);
    throw e;
  });
  if (!d?.path || typeof d.path !== "string" || !d.path.startsWith("/api/")) throw new MediaUrlError("bad media url");
  return `${BASE}${d.path}`;
}

interface VoiceNote {
  id: number;
  userId: string;
  tradeId: number | null;
  audioUrl: string;
  transcript: string | null;
  durationSec: number | null;
  createdAt: string;
}

const SPEEDS = [1, 1.25, 1.5, 2, 0.75] as const;
const SPEED_KEY = "voice-note-speed";
const BAR_COUNT = 56;
const PLAY_EVENT = "voice-note:play";

function readSpeed(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return (SPEEDS as readonly number[]).includes(v) ? v : 1;
  } catch {
    return 1;
  }
}
function writeSpeed(v: number) {
  try { localStorage.setItem(SPEED_KEY, String(v)); } catch { /* storage unavailable */ }
}

function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "0:00";
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatCreated(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.substring(0, 10) : fmtDate(d, "dateTime");
}

/** Deterministic pseudo-waveform (decorative) seeded by note id. */
function makeBars(seed: number, count: number): number[] {
  let x = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
  const out: number[] = [];
  let prev = 0.5;
  for (let i = 0; i < count; i++) {
    const env = 0.55 + 0.45 * Math.sin((i / count) * Math.PI); // louder in the middle
    const v = Math.min(1, Math.max(0.12, (prev * 0.45 + rnd() * 0.75) * env));
    out.push(v);
    prev = v;
  }
  return out;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const q = query.trim().toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  const lower = text.toLowerCase();
  while (i < text.length) {
    const j = lower.indexOf(q, i);
    if (j === -1) { parts.push(text.slice(i)); break; }
    if (j > i) parts.push(text.slice(i, j));
    parts.push(<mark key={j} className="rounded bg-primary/25 px-0.5 text-foreground">{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  return <>{parts}</>;
}

function VoiceNoteItem({ note, query }: { note: VoiceNote; query: string }) {
  const { t } = voiceI18n.useT();
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(note.durationSec ?? 0);
  const [playError, setPlayError] = useState(false);
  const [speed, setSpeed] = useState<number>(() => readSpeed());
  const [copied, setCopied] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const draggingRef = useRef(false);
  // Source bookkeeping lives in refs: the token-bearing URL must not become React state/props.
  const retriedRef = useRef(false);
  const resolvingRef = useRef<Promise<void> | null>(null);

  const bars = useMemo(() => makeBars(note.id, BAR_COUNT), [note.id]);
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // Only one note plays at a time across the page.
    const onOtherPlay = (e: Event) => {
      if ((e as CustomEvent<number>).detail !== note.id && !audio.paused) audio.pause();
    };
    window.addEventListener(PLAY_EVENT, onOtherPlay);
    return () => {
      window.removeEventListener(PLAY_EVENT, onOtherPlay);
      audio.pause();
      audio.removeAttribute("src"); // drop the token-bearing URL from the DOM
      audio.load();
    };
  }, [note.id]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  /** Attach a playable src (fresh media-token URL). `force` rebuilds it even when one is set (after an error). */
  function ensureSrc(audio: HTMLAudioElement, force = false): Promise<void> {
    if (audio.getAttribute("src") && !force) return Promise.resolve();
    if (resolvingRef.current) return resolvingRef.current;
    const p = fetchMediaUrl(note.id)
      .then((url) => {
        audio.src = url;
        audio.playbackRate = speed;
      })
      .finally(() => { resolvingRef.current = null; });
    resolvingRef.current = p;
    return p;
  }

  /** Playback failed (401 after token rotation, expired media token, missing file): rebuild the source once. */
  function recoverFromError(resume: boolean = playing): boolean {
    const audio = audioRef.current;
    if (!audio || retriedRef.current) return false;
    retriedRef.current = true;
    const wasPlaying = resume;
    const resumeAt = currentTime;
    // Media tokens live 5 minutes: a paused player resumed later needs a fresh URL.
    ensureSrc(audio, true).then(() => {
      if (resumeAt > 0) audio.addEventListener("loadedmetadata", () => { audio.currentTime = resumeAt; }, { once: true });
      audio.load();
      if (wasPlaying) audio.play().catch(() => { setLoading(false); setPlayError(true); });
    }, () => { setLoading(false); setPlayError(true); });
    return true;
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      return;
    }
    const hadSrc = !!audio.getAttribute("src") && !playError;
    const startAt = currentTime;
    setPlayError(false);
    retriedRef.current = false;
    window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: note.id }));
    setLoading(true);
    ensureSrc(audio, playError).then(() => {
      if (!hadSrc && startAt > 0) {
        audio.addEventListener("loadedmetadata", () => { audio.currentTime = startAt; }, { once: true });
      }
      return audio.play();
    }).catch((e) => {
      if (e?.name === "AbortError") return;
      if (!(e instanceof MediaUrlError) && recoverFromError(true)) return;
      setLoading(false);
      setPlayError(true);
    });
  }

  function seekTo(sec: number) {
    const audio = audioRef.current;
    if (!audio) return;
    const max = audio.duration && Number.isFinite(audio.duration) ? audio.duration : duration;
    if (!max) return;
    const t = Math.min(max, Math.max(0, sec));
    if (audio.getAttribute("src")) audio.currentTime = t;
    setCurrentTime(t);
  }

  function ratioFromPointer(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.getAttribute("src")) {
      // Load metadata first, then seek.
      const ratio = ratioFromPointer(e);
      ensureSrc(audio).then(() => {
        const apply = () => seekTo(ratio * (audio.duration || duration));
        audio.addEventListener("loadedmetadata", apply, { once: true });
        audio.load();
      });
      return;
    }
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTo(ratioFromPointer(e) * (audio.duration || duration));
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const audio = audioRef.current;
    seekTo(ratioFromPointer(e) * ((audio?.duration || 0) || duration));
  }
  function onPointerUp() { draggingRef.current = false; }

  function cycleSpeed() {
    const idx = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    setSpeed(next);
    writeSpeed(next);
  }

  async function copyTranscript() {
    if (!note.transcript) return;
    try {
      await navigator.clipboard.writeText(note.transcript);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  }

  const transcript = note.transcript?.trim() ?? "";
  const hasTranscript = transcript.length > 0;
  const isLong = transcript.length > 160;
  const showFull = expanded || !isLong || !!query.trim();

  return (
    <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-3">
      <audio
        ref={audioRef}
        preload="none"
        className="hidden"
        onLoadStart={() => setLoading(true)}
        onCanPlay={() => setLoading(false)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (d && Number.isFinite(d)) setDuration(d);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrentTime(0); }}
        onTimeUpdate={(e) => { if (!draggingRef.current) setCurrentTime(e.currentTarget.currentTime); }}
        onError={() => {
          setPlaying(false);
          if (!audioRef.current?.getAttribute("src")) { setLoading(false); return; }
          if (recoverFromError()) return; // one silent retry with a rebuilt source (rotated / expired token)
          setLoading(false);
          setPlayError(true);
        }}
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? t("player.pause") : t("player.play")}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {loading && !playing ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : playing ? (
            <Pause className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Play className="ml-0.5 h-4 w-4" aria-hidden="true" />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div
            role="slider"
            tabIndex={0}
            aria-label={t("player.position")}
            aria-valuemin={0}
            aria-valuemax={Math.round(duration) || 0}
            aria-valuenow={Math.round(currentTime)}
            aria-valuetext={t("player.positionText", { current: formatDuration(currentTime), total: formatDuration(duration) })}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") { e.preventDefault(); seekTo(currentTime + 5); }
              else if (e.key === "ArrowLeft") { e.preventDefault(); seekTo(currentTime - 5); }
              else if (e.key === "Home") { e.preventDefault(); seekTo(0); }
              else if (e.key === "End") { e.preventDefault(); seekTo(duration); }
              else if (e.key === " " || e.key === "Enter") { e.preventDefault(); togglePlay(); }
            }}
            className="flex h-9 cursor-pointer touch-none select-none items-center gap-[2px] rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {bars.map((h, i) => {
              const played = (i + 0.5) / bars.length <= progress;
              return (
                <span
                  key={i}
                  aria-hidden="true"
                  className={cn("min-w-[2px] flex-1 rounded-full transition-colors duration-150", played ? "bg-primary" : "bg-muted-foreground/30")}
                  style={{ height: `${Math.round(h * 100)}%` }}
                />
              );
            })}
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-2xs tabular-nums text-muted-foreground">
            <span>{formatDuration(currentTime)} / {formatDuration(duration)}</span>
            <span className="truncate">{formatCreated(note.createdAt)}</span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-center gap-1">
          <button
            type="button"
            onClick={cycleSpeed}
            aria-label={t("player.speed", { speed })}
            className="chip min-h-8 min-w-[3.25rem] px-2 text-xs font-semibold tabular-nums"
          >
            {speed}×
          </button>
          {currentTime > 0 && (
            <button
              type="button"
              onClick={() => seekTo(0)}
              aria-label={t("player.toStart")}
              className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {playError && (
        <div role="alert" className="mt-2 flex items-center gap-1.5 text-xs text-down">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t("player.playFailed")}
        </div>
      )}

      {hasTranscript ? (
        <div className="mt-2.5 border-t border-[var(--glass-border)] pt-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="micro-label">{t("player.transcript")}</span>
            <button
              type="button"
              onClick={copyTranscript}
              aria-label={t("player.copyTranscript")}
              className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-up" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
          </div>
          <p className={cn("mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90", !showFull && "line-clamp-2")}>
            <Highlight text={transcript} query={query} />
          </p>
          {isLong && !query.trim() && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
              {expanded ? commonI18n.t("actions.collapse") : t("player.showFull")}
            </button>
          )}
        </div>
      ) : (
        <p className="mt-2 text-2xs text-muted-foreground">{t("player.noTranscript")}</p>
      )}
    </div>
  );
}

interface VoiceNotePlayerProps {
  tradeId: number;
  userId: string;
  refreshKey?: number;
  /** Optional: render an empty-state hint instead of nothing when there are no notes. */
  showEmpty?: boolean;
  className?: string;
}

export function VoiceNotePlayer({ tradeId, userId, refreshKey, showEmpty, className }: VoiceNotePlayerProps) {
  const { t } = voiceI18n.useT();
  const [query, setQuery] = useState("");
  const { data: notes = [], isLoading, isError, refetch } = useQuery<VoiceNote[]>({
    queryKey: ["voice-notes", tradeId, userId, refreshKey],
    queryFn: async ({ signal }) => {
      const d = await http.get<VoiceNote[]>(`/api/voice-notes?userId=${encodeURIComponent(userId)}&tradeId=${tradeId}`, { signal });
      return Array.isArray(d) ? d : [];
    },
    enabled: !!userId,
    staleTime: STALE.default,
  });

  const totalSec = useMemo(() => notes.reduce((s, n) => s + (Number(n.durationSec) || 0), 0), [notes]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => n.transcript?.toLowerCase().includes(q));
  }, [notes, query]);

  const onQuery = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value), []);

  if (isError) {
    return (
      <div role="alert" className={cn("flex items-center gap-2 py-1 text-xs text-down", className)}>
        <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t("player.loadFailed")}</span>
        <button type="button" onClick={() => refetch()} className="font-medium text-primary hover:underline">{commonI18n.t("actions.retry")}</button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={cn("space-y-2 py-1", className)} aria-busy="true" aria-label={t("player.loading")}>
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }

  if (!notes.length) {
    if (!showEmpty) return null;
    return (
      <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
        <Mic className="h-3.5 w-3.5" aria-hidden="true" /> {t("player.empty")}
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Mic className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t("player.title")}
          <Pill tone="accent">{notes.length}</Pill>
          {totalSec > 0 && <span className="text-xs font-normal tabular-nums text-muted-foreground">{formatDuration(totalSec)}</span>}
        </div>
        {notes.length >= 3 && notes.some((n) => n.transcript) && (
          <label className="glass-field flex min-h-8 items-center gap-1.5 px-3">
            <Search className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">{t("player.search")}</span>
            <input
              type="search"
              value={query}
              onChange={onQuery}
              placeholder={t("player.search")}
              className="w-40 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        )}
      </div>
      <div className="space-y-2">
        {filtered.map((note) => (
          <VoiceNoteItem key={note.id} note={note} query={query} />
        ))}
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("player.notFound", { query })}</p>
        )}
      </div>
    </div>
  );
}
