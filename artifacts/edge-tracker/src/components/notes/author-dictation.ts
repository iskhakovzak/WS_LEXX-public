import { useCallback, useEffect, useRef, useState } from "react";
import { getLang, localeTagFor, type Lang } from "@/i18n";
import { notesI18n } from "@/i18n/ns/notes";

/* Web Speech API dictation (Chrome / Edge / Safari). Final phrases are handed to `onFinal`,
   interim text is exposed for a live caption. */

export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

export function getSR(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return ((w["SpeechRecognition"] || w["webkitSpeechRecognition"]) as (new () => SpeechRecognitionLike) | undefined) ?? null;
}

/**
 * Dictation language = the UI language (an input language, the only locale tag kept outside lib/format).
 * Uzbek recognition is not available in every browser: on «language-not-supported» the recognizer restarts
 * with Russian, the desk's second language.
 */
const SPEECH_LANG: Record<Lang, string> = { ru: localeTagFor("ru"), en: localeTagFor("en"), uz: "uz-UZ" };
export const SPEECH_FALLBACK = SPEECH_LANG.ru;
export function speechLang(lang: Lang = getLang()): string {
  return SPEECH_LANG[lang];
}

export function useDictation({
  onFinal,
  onError,
  onEnd,
}: {
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onEnd?: () => void;
}) {
  const [supported] = useState(() => !!getSR());
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const cb = useRef({ onFinal, onError, onEnd });
  cb.current = { onFinal, onError, onEnd };

  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* already stopped */ }
  }, []);

  const startWith = useCallback((lang: string) => {
    const SR = getSR();
    if (!SR || recRef.current) return;
    const rec = new SR();
    let retryLang: string | null = null;
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const t = r[0].transcript.trim();
        if (!t) continue;
        if (r.isFinal) cb.current.onFinal(t);
        else live += (live ? " " : "") + t;
      }
      setInterim(live);
    };
    rec.onend = () => {
      recRef.current = null;
      setInterim("");
      if (retryLang) {
        startWith(retryLang);
        return;
      }
      setRecording(false);
      cb.current.onEnd?.();
    };
    rec.onerror = (e) => {
      if (e.error === "language-not-supported" && lang !== SPEECH_FALLBACK) {
        retryLang = SPEECH_FALLBACK;
      } else if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        cb.current.onError(notesI18n.t("author.toast.micDenied"));
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        cb.current.onError(notesI18n.t("micError", { error: e.error }));
      }
    };
    try {
      rec.start();
      recRef.current = rec;
      setRecording(true);
    } catch {
      setRecording(false);
      cb.current.onError(notesI18n.t("author.toast.dictationFailed"));
    }
  }, []);

  const start = useCallback(() => startWith(speechLang()), [startWith]);

  useEffect(() => () => {
    try { recRef.current?.abort(); } catch { /* ignore */ }
  }, []);

  return { supported, recording, interim, start, stop, toggle: recording ? stop : start };
}
