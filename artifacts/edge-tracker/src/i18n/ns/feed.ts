import { createNamespace } from "..";
import ru from "../locales/ru/feed";

/** /dailyfeed — «Лента» (components/feed/*, pages/dailyfeed.tsx). Stream item titles come localized from the server. */
export const feedI18n = createNamespace("feed", ru, {
  en: () => import("../locales/en/feed"),
  uz: () => import("../locales/uz/feed"),
});
