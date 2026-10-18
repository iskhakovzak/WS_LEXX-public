import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installFetchAuth } from "./lib/install-fetch-auth";
import { installErrorReporting } from "./lib/error-reporting";
import { i18nReady } from "./i18n";

installFetchAuth();
// After installFetchAuth: reports carry the session and /api responses ≥ 500 are observed (Пульт → Ошибки).
installErrorReporting();

// With EN/UZ saved, wait for the dictionaries of the namespaces in the main bundle (tiny chunks, usually cached)
// so the first paint is already in the right language. RU resolves at once.
const root = createRoot(document.getElementById("root")!);
void i18nReady().finally(() => root.render(<App />));
