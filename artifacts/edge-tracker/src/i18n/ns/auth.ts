import { createNamespace } from "..";
import ru from "../locales/ru/auth";

/** Sign-in screen and the forced password change after a staff sign-in. */
export const authI18n = createNamespace("auth", ru, {
  en: () => import("../locales/en/auth"),
  uz: () => import("../locales/uz/auth"),
});
