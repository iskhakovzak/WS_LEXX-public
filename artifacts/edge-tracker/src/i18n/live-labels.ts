/**
 * Label maps that stay in the current language: `{ key: label }` whose values are read on every access, so the map
 * can be a module-level constant (`LABEL[code]` in render returns today's language). Same signature as the local
 * copies features wrote during the wave — switch them to this import.
 *
 *   export const PHASE_LABEL = liveLabels(PHASES, (p) => curatorI18n.t(`phase.${p}`));
 *   PHASE_LABEL.session   // → "Сессия" / "Session" / "Sessiya", read now
 *
 * Unknown keys return undefined (index the map with a fallback: `LABEL[k] ?? k`). Object.keys / entries list the keys.
 */
export function liveLabels<K extends string>(keys: readonly K[], label: (k: K) => string): Readonly<Record<K, string>> {
  const o = {} as Record<K, string>;
  for (const k of keys) Object.defineProperty(o, k, { get: () => label(k), enumerable: true });
  return o;
}
