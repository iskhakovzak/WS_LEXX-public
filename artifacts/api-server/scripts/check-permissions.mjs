#!/usr/bin/env node
/**
 * Offline check of the permissions matrix (no DB, no vitest). Run from artifacts/api-server:
 *   node scripts/check-permissions.mjs
 * Requires Node >= 22.6 (type stripping): it imports the pure TS core and the frontend mirror directly.
 */
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (...p) => import(pathToFileURL(path.join(here, ...p)).href);
const api = await load("..", "src", "lib", "permissionsMatrix.ts");
const web = await load("..", "..", "edge-tracker", "src", "lib", "permissions.ts");

const {
  ROLES, CAPABILITY_KEYS, CAPABILITY_DEFS, DEFAULT_MATRIX, DEFAULT_SCOPE,
  buildEffectiveMatrix, diffFromDefaults, evaluate, readableTraders, capabilitiesOf, isEditableRole, capabilityDef,
} = api;

let checks = 0;
const ok = (name, fn) => { fn(); checks++; console.log("  ok  " + name); };

console.log("permissions matrix — offline check");

// ── 1. Catalogue sanity ────────────────────────────────────────────────────
ok("capability keys are unique and well-formed", () => {
  assert.equal(new Set(CAPABILITY_KEYS).size, CAPABILITY_KEYS.length);
  for (const k of CAPABILITY_KEYS) assert.match(k, /^[a-z]+(\.[a-z]+)+$/, k);
  for (const d of CAPABILITY_DEFS) {
    assert.ok(d.label && d.description && d.group, d.key);
    assert.ok(!(d.own && d.team), `${d.key}: own and team are exclusive`);
    assert.ok(!(d.adminOnly && d.own), `${d.key}: adminOnly caps are never own`);
  }
});

ok("defaults only reference known capabilities; admin holds everything; guest nothing", () => {
  for (const role of ROLES) for (const c of DEFAULT_MATRIX[role]) assert.ok(CAPABILITY_KEYS.includes(c), `${role}: ${c}`);
  assert.deepEqual([...DEFAULT_MATRIX.admin].sort(), [...CAPABILITY_KEYS].sort());
  assert.deepEqual(DEFAULT_MATRIX.guest, []);
});

ok("trader defaults = own caps only; curator = everything except adminOnly", () => {
  for (const c of DEFAULT_MATRIX.trader) {
    const d = capabilityDef(c);
    assert.ok(!d.team && !d.adminOnly, `trader must not hold ${c}`);
  }
  const expectedCurator = CAPABILITY_KEYS.filter((c) => !capabilityDef(c).adminOnly);
  assert.deepEqual([...DEFAULT_MATRIX.curator].sort(), expectedCurator.sort());
  assert.ok(DEFAULT_MATRIX.curator.length < DEFAULT_MATRIX.admin.length);
});

// ── 2. Frontend mirror ─────────────────────────────────────────────────────
ok("frontend mirror has the same keys, groups, flags and defaults", () => {
  assert.deepEqual([...web.CAPABILITY_KEYS], [...CAPABILITY_KEYS]);
  for (const d of CAPABILITY_DEFS) {
    const w = web.capabilityDef(d.key);
    assert.ok(w, `frontend missing ${d.key}`);
    assert.equal(w.group, d.group, `${d.key} group`);
    assert.equal(!!w.team, !!d.team, `${d.key} team`);
    assert.equal(!!w.own, !!d.own, `${d.key} own`);
    assert.equal(!!w.adminOnly, !!d.adminOnly, `${d.key} adminOnly`);
  }
  for (const role of ROLES) assert.deepEqual([...web.DEFAULT_MATRIX[role]], [...DEFAULT_MATRIX[role]], role);
  assert.equal(web.DEFAULT_SCOPE, DEFAULT_SCOPE);
});

// ── 3. Effective matrix / overrides ────────────────────────────────────────
const actor = (name, role, wards = [], guest = false) => ({ id: 1, name, role, guest, wards });
const base = buildEffectiveMatrix([]);

ok("buildEffectiveMatrix([]) reproduces the defaults with desk scope", () => {
  for (const role of ROLES) {
    assert.deepEqual(capabilitiesOf(base, role), CAPABILITY_KEYS.filter((c) => DEFAULT_MATRIX[role].includes(c)));
    for (const c of CAPABILITY_KEYS) assert.equal(base[role][c].scope, "desk");
  }
  assert.deepEqual(diffFromDefaults(base), []);
});

ok("overrides flip trader/curator cells; admin & guest rows and adminOnly caps are locked", () => {
  const m = buildEffectiveMatrix([
    { role: "trader", capability: "trades.read.team", allowed: true, scope: "assigned" },
    { role: "curator", capability: "users.manage", allowed: false },
    { role: "curator", capability: "users.manage.admins", allowed: true },       // adminOnly → ignored
    { role: "admin", capability: "users.manage", allowed: false },               // locked row → ignored
    { role: "guest", capability: "trades.read.own", allowed: true },             // locked row → ignored
    { role: "trader", capability: "no.such.cap", allowed: true },                // unknown → ignored
    { role: "trader", capability: "playbook.edit", allowed: true, scope: "assigned" }, // scope only on team caps
  ]);
  assert.equal(m.trader["trades.read.team"].allowed, true);
  assert.equal(m.trader["trades.read.team"].scope, "assigned");
  assert.equal(m.curator["users.manage"].allowed, false);
  assert.equal(m.curator["users.manage.admins"].allowed, false);
  assert.equal(m.admin["users.manage"].allowed, true);
  assert.equal(m.guest["trades.read.own"].allowed, false);
  assert.equal(m.trader["playbook.edit"].scope, "desk");
  const diff = diffFromDefaults(m);
  assert.deepEqual(diff.map((d) => `${d.role}:${d.capability}:${d.allowed}:${d.scope ?? "-"}`).sort(), [
    "curator:users.manage:false:-",
    "trader:trades.read.team:true:assigned",
  ]);
  // round-trip: rebuilding from the diff gives the same matrix
  assert.deepEqual(buildEffectiveMatrix(diff), m);
});

ok("admin can never remove their own admin access (adminOnly caps + locked row)", () => {
  const nuke = CAPABILITY_KEYS.flatMap((c) => ROLES.map((r) => ({ role: r, capability: c, allowed: false })));
  const m = buildEffectiveMatrix(nuke);
  const admin = actor("Boss", "admin");
  for (const c of ["users.manage", "users.manage.admins", "permissions.manage", "admin.backups.run", "team.read"]) {
    assert.equal(evaluate(m, admin, c), true, c);
  }
  assert.equal(evaluate(m, actor("Cur", "curator"), "team.read"), false);
  assert.equal(isEditableRole("admin"), false);
  assert.equal(isEditableRole("guest"), false);
});

// ── 4. evaluate(): own / team / assigned semantics ─────────────────────────
ok("own caps: only on the actor's own data", () => {
  const t = actor("Закир", "trader");
  assert.equal(evaluate(base, t, "trades.write.own"), true);
  assert.equal(evaluate(base, t, "trades.write.own", { trader: "Закир" }), true);
  assert.equal(evaluate(base, t, "trades.write.own", { trader: "Антон" }), false);
  assert.equal(evaluate(base, t, "trades.write.any", { trader: "Антон" }), false);
  assert.equal(evaluate(base, t, "trades.read.team"), false);
  assert.equal(evaluate(base, t, "users.manage"), false);
});

ok("guest and missing actor get nothing", () => {
  assert.equal(evaluate(base, null, "trades.read.own"), false);
  assert.equal(evaluate(base, actor("", "guest", [], true), "trades.read.own"), false);
  assert.deepEqual(readableTraders(base, actor("", "guest", [], true), "team.read"), []);
  assert.deepEqual(readableTraders(base, null, "team.read"), []);
});

ok("curator defaults: whole desk (assignments do not restrict)", () => {
  const c = actor("Антон", "curator", ["Закир"]);
  assert.equal(evaluate(base, c, "trades.write.any", { trader: "Умид" }), true);
  assert.equal(evaluate(base, c, "journal.review", { trader: "Умид" }), true);
  assert.equal(readableTraders(base, c, "team.read"), null);
  // but not admin-only things
  assert.equal(evaluate(base, c, "users.manage.admins"), false);
  assert.equal(evaluate(base, c, "ratings.manage.any"), false);
  assert.equal(evaluate(base, c, "discussions.edit.any"), false);
  assert.equal(evaluate(base, c, "admin.backups.run"), false);
  assert.equal(evaluate(base, c, "permissions.manage"), false);
});

ok("assigned scope: curator acts only on self + wards", () => {
  const m = buildEffectiveMatrix([
    { role: "curator", capability: "trades.write.any", allowed: true, scope: "assigned" },
    { role: "curator", capability: "team.read", allowed: true, scope: "assigned" },
  ]);
  const c = actor("Антон", "curator", ["Закир", "Артур"]);
  assert.equal(evaluate(m, c, "trades.write.any", { trader: "Закир" }), true);
  assert.equal(evaluate(m, c, "trades.write.any", { trader: "Антон" }), true);
  assert.equal(evaluate(m, c, "trades.write.any", { trader: "Умид" }), false);
  assert.equal(evaluate(m, c, "trades.write.any"), true, "no target = may act on the desk at all");
  assert.deepEqual(readableTraders(m, c, "team.read"), ["Антон", "Закир", "Артур"]);
  // other team caps keep desk scope
  assert.equal(evaluate(m, c, "journal.review", { trader: "Умид" }), true);
  // a curator with no wards sees only themselves
  assert.deepEqual(readableTraders(m, actor("Тимур", "curator"), "team.read"), ["Тимур"]);
  // a trader without the cap: own name only
  assert.deepEqual(readableTraders(m, actor("Закир", "trader"), "team.read"), ["Закир"]);
});

ok("frontend canWith agrees with evaluate for own / team / assigned", () => {
  const me = { name: "Антон", role: "curator", guest: false, capabilities: ["trades.write.any", "trades.write.own"], scopes: { "trades.write.any": "assigned" }, wards: ["Закир"], customized: true, updatedAt: null };
  assert.equal(web.canWith(me, "trades.write.any", { trader: "Закир" }), true);
  assert.equal(web.canWith(me, "trades.write.any", { trader: "Умид" }), false);
  assert.equal(web.canWith(me, "trades.write.own", { trader: "Умид" }), false);
  assert.equal(web.canWith(me, "users.manage"), false);
  assert.equal(web.canWith({ ...me, guest: true }, "trades.write.own"), false);
  const d = web.defaultPermissions("curator", "Антон");
  assert.deepEqual(d.capabilities, [...DEFAULT_MATRIX.curator]);
  assert.equal(web.canWith(d, "trades.write.any", { trader: "Умид" }), true);
  assert.equal(web.canWith(web.defaultPermissions("trader", "Закир"), "trades.write.any", { trader: "Умид" }), false);
  assert.equal(web.canWith(web.defaultPermissions("guest", null), "trades.read.own"), false);
});

console.log(`\n${checks} checks passed`);
