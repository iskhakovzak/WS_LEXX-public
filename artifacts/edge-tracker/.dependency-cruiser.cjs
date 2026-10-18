/**
 * Layer rules for the web app (ARCHITECTURE.md §1, frontend research §3.2 rule 1):
 *   lib ← ui/ds ← shared ← <feature> ← pages ← app
 * Existing violations live in .dependency-cruiser-known-violations.json (a ratchet): `pnpm check:layers` fails only on
 * NEW violations. After fixing some, run `pnpm --filter @workspace/edge-tracker run check:layers:update` (shrink-only:
 * drops fixed violations, never adds new ones). A deliberate full reset: `depcruise src --config .dependency-cruiser.cjs --baseline`.
 * Test files are not part of the graph.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "lib-is-framework-free",
      comment: "src/lib is pure code: it must not import UI, features, pages, hooks or contexts.",
      severity: "error",
      from: { path: "^src/lib/" },
      to: { path: "^src/(components|pages|app|hooks|contexts)/" },
    },
    {
      name: "hooks-not-features",
      comment: "src/hooks holds generic hooks; feature-specific hooks live in their feature folder.",
      severity: "error",
      from: { path: "^src/hooks/" },
      to: { path: "^src/(components/|pages/|app/)", pathNot: "^src/components/(ui/|ds/|ds\\.tsx$|shared/)" },
    },
    {
      name: "ui-ds-only-lib",
      comment: "Design-system and shadcn primitives (components/ui, components/ds, components/ds.tsx) depend on lib only.",
      severity: "error",
      from: { path: "^src/components/(ui/|ds/|ds\\.tsx$)" },
      to: { path: "^src/(components/|pages/|app/)", pathNot: "^src/components/(ui/|ds/|ds\\.tsx$)" },
    },
    {
      name: "shared-not-features",
      comment: "components/shared holds cross-feature widgets: it may use ds, ui, lib and hooks, never a feature.",
      severity: "error",
      from: { path: "^src/components/shared/" },
      to: { path: "^src/(components/|pages/|app/)", pathNot: "^src/components/(shared/|ui/|ds/|ds\\.tsx$)" },
    },
    {
      name: "no-feature-to-feature",
      comment: "A feature (components/<feature>/) never imports another feature; promote shared code to components/shared.",
      severity: "error",
      from: { path: "^src/components/([^/]+)/", pathNot: "^src/components/(ui|ds|shared)/" },
      // chart-engine and people (person search, pickers, highlight) are shared by design (ARCHITECTURE.md §1); phase E
      // moves them to components/shared/{charts,people}. people/** imports only ui, lib, i18n and contexts.
      to: { path: "^src/components/[^/]+/", pathNot: ["^src/components/$1/", "^src/components/(ui|ds|shared|chart-engine|people)/"] },
    },
    {
      name: "no-page-to-page",
      comment: "Pages compose features; a page never imports another page (same-folder sub-pages excepted).",
      severity: "error",
      from: { path: "^src/pages/([^/]+)" },
      to: { path: "^src/pages/", pathNot: "^src/pages/$1" },
    },
    {
      name: "no-circular",
      comment: "Import cycles make load order fragile; break them by moving shared types/helpers down a layer.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(\\.test\\.tsx?$|/__tests__/|\\.d\\.ts$)" },
    includeOnly: "^src/",
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default", "types"] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
