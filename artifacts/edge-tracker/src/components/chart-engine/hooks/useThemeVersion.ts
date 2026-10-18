import * as React from "react";

const themeSignature = (el: HTMLElement) => `${el.className}|${el.getAttribute("data-theme") ?? ""}|${el.style.colorScheme}`;

/**
 * Increments when the html class / data-theme / color-scheme actually changes, so the chart re-reads CSS tokens.
 * Other writes to those attributes (same value, unrelated inline styles) do not rebuild the chart.
 */
export function useThemeVersion(): number {
  const [v, setV] = React.useState(0);
  React.useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const el = document.documentElement;
    let sig = themeSignature(el);
    const obs = new MutationObserver(() => {
      const next = themeSignature(el);
      if (next === sig) return;
      sig = next;
      setV((x) => x + 1);
    });
    obs.observe(el, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    return () => obs.disconnect();
  }, []);
  return v;
}
