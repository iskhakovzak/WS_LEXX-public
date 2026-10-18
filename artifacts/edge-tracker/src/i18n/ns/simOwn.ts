import { createNamespace } from "..";
import ru from "../locales/ru/simOwn";

/** /simulator mode «Мои худшие дни» (components/sim/own-*, components/shared/replay-own-day.tsx). */
export const simOwnI18n = createNamespace("simOwn", ru, {
  en: () => import("../locales/en/simOwn"),
  uz: () => import("../locales/uz/simOwn"),
});
