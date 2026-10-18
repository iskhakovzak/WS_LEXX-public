import { createNamespace } from "..";
import ru from "../locales/ru/voice";

/** Voice recorder and voice-note player (components/voice-recorder.tsx, components/voice-note-player.tsx), used in many dialogs. */
export const voiceI18n = createNamespace("voice", ru, {
  en: () => import("../locales/en/voice"),
  uz: () => import("../locales/uz/voice"),
});
