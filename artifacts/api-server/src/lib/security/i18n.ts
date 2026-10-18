import { defineNamespace } from "../../i18n";
import ru from "../../i18n/ru/security";
import en from "../../i18n/en/security";
import uz from "../../i18n/uz/security";

/** Sign-in, secrets policy, body limits and error alerts (lib/security/*, lib/errorTracking). */
export const securityT = defineNamespace(ru, { en, uz });
