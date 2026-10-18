/** `setups` namespace (src/i18n/{ru,en,uz}/setups.ts): auto setup classifier texts (lib/setupClassifier, routes/setups-auto). */
import { defineNamespace } from "../i18n";
import ru from "../i18n/ru/setups";
import en from "../i18n/en/setups";
import uz from "../i18n/uz/setups";

export const setupsT = defineNamespace(ru, { en, uz });
export { ru as ruSetups };
