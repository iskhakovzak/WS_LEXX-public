import { createNamespace } from "..";
import ru from "../locales/ru/curator";

export const curatorI18n = createNamespace("curator", ru, {
  en: () => import("../locales/en/curator"),
  uz: () => import("../locales/uz/curator"),
});
