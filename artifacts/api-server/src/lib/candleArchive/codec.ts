/**
 * Compact binary codec for one symbol-day of intraday bars (candle_archive.payload). Pure, no I/O; node:zlib only.
 *
 * Layout (encoding version 1) — every integer is an unsigned LEB128 varint written with arithmetic (safe up to 2^53),
 * signed values are zigzag-mapped first. Prices are integers p = round(price × 10⁴).
 *
 *   header   tfSec · timeMode · n · subTick · volTick
 *   time     timeMode 0 (bars on a tfSec grid): phase · firstSlot · runCount · (gap, len) × runCount
 *              — implicit timestamps: `len` consecutive slots after skipping `gap` empty ones (gaps = no-trade minutes,
 *              halts, the 09:30 seam of a regular-hours-only day);
 *            timeMode 1 (off-grid bars, e.g. Yahoo 60m with its 09:30 bar): firstT · Δt per bar
 *   cents    column-major on q = floor(p / 100), so the compressor sees similar numbers together:
 *              open  zigzag(qo − previous qc)  (first bar against 0) · body zigzag(qc − qo)
 *              upper qh − max(qo, qc) ≥ 0      · lower min(qo, qc) − ql ≥ 0
 *   sub-cent (only when subTick < 100) (p mod 100) / subTick for o, c, h, l — Yahoo ships real sub-penny prints
 *            (a third of 1-minute values; half-cents dominate), so they are kept, but in their own near-constant
 *            stream instead of inflating every delta 100×. subTick = 100 / 10 / 1 = the coarsest grid every price is on.
 *   volume   v / volTick (volTick = GCD of all volumes)
 *
 * The varint stream is then compressed; byte 0 of the payload names the compressor (1 = brotli, 2 = deflate-raw,
 * 0 = none) so payloads stay readable if the default ever changes.
 *
 * Exactness: decode(encode(bars)) === normalizeBars(bars): prices on the 10⁻⁴ grid, integer volumes, h/l widened to
 * contain the body, duplicates by `t` collapsed (last wins), sorted by time. Yahoo float noise such as
 * 226.42999267578125 becomes 226.43.
 *
 * Measured on the local candles_cache (789 extended-hours 1-minute days, ≈739 bars each): 3.2 KB per day on average
 * against 67.6 KB of JSON (12.1 KB gzipped); regular-hours-only days 2.4 KB; 5-minute days 1.1 KB.
 */
import { brotliCompressSync, brotliDecompressSync, constants, deflateRawSync, inflateRawSync } from "node:zlib";

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

export const CODEC_VERSION = 1;
export const PRICE_SCALE = 10_000;

const COMPRESS_NONE = 0;
const COMPRESS_BROTLI = 1;
const COMPRESS_DEFLATE = 2;

// ── varint writer / reader ─────────────────────────────────────────────────────

class Writer {
  private buf: Uint8Array;
  len = 0;
  constructor(cap = 4096) { this.buf = new Uint8Array(Math.max(16, cap)); }
  private put(b: number): void {
    if (this.len >= this.buf.length) { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; }
    this.buf[this.len++] = b;
  }
  u(v: number): void {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`varint out of range: ${v}`);
    while (v >= 0x80) { this.put((v % 0x80) | 0x80); v = Math.floor(v / 0x80); }
    this.put(v);
  }
  s(v: number): void { this.u(v >= 0 ? v * 2 : -v * 2 - 1); }
  bytes(): Uint8Array { return this.buf.subarray(0, this.len); }
}

class Reader {
  pos = 0;
  private readonly buf: Uint8Array;
  constructor(buf: Uint8Array) { this.buf = buf; }
  u(): number {
    let v = 0, mul = 1, b: number;
    do {
      if (this.pos >= this.buf.length) throw new RangeError("candle payload truncated");
      b = this.buf[this.pos++];
      v += (b & 0x7f) * mul;
      mul *= 0x80;
    } while (b & 0x80);
    return v;
  }
  s(): number { const z = this.u(); return z % 2 === 0 ? z / 2 : -(z + 1) / 2; }
}

function gcd(a: number, b: number): number {
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

/** Price as an integer of 10⁻⁴ dollars. */
export const toTicks = (p: number): number => Math.round(p * PRICE_SCALE);

/** What the archive stores for `bars`: exactly the values decodeBars returns. */
export function normalizeBars(bars: readonly Bar[]): Bar[] {
  const byT = new Map<number, Bar>();
  for (const b of bars) {
    const t = Math.round(b.t);
    const o = toTicks(b.o), c = toTicks(b.c);
    byT.set(t, {
      t,
      o: o / PRICE_SCALE,
      h: Math.max(toTicks(b.h), o, c) / PRICE_SCALE,
      l: Math.min(toTicks(b.l), o, c) / PRICE_SCALE,
      c: c / PRICE_SCALE,
      v: Math.max(0, Math.round(Number.isFinite(b.v) ? b.v : 0)),
    });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

// ── encode ─────────────────────────────────────────────────────────────────────

/** "auto" (default) keeps the smaller of brotli and deflate (deflate wins on tiny hourly days). */
export type EncodeOptions = { compress?: "auto" | "brotli" | "deflate" | "none" };

/**
 * Encode bars (any order). `tfSec` is the bar length (60 for 1-minute bars). Throws on non-finite or negative
 * prices — clean the series (lib/candleClean) before archiving.
 */
export function encodeBars(input: readonly Bar[], tfSec: number, opts: EncodeOptions = {}): Buffer {
  if (!Number.isInteger(tfSec) || tfSec <= 0) throw new RangeError(`bad tfSec ${tfSec}`);
  for (const b of input) {
    for (const x of [b.o, b.h, b.l, b.c]) if (!Number.isFinite(x) || x < 0) throw new RangeError(`bad price in bar t=${b.t}`);
    if (!Number.isFinite(b.t)) throw new RangeError("bad bar time");
  }
  const bars = normalizeBars(input);
  const n = bars.length;
  const P: number[][] = [[], [], [], []]; // o, c, h, l in 10⁻⁴
  let sub = 0, vg = 0;
  for (const b of bars) {
    const row = [toTicks(b.o), toTicks(b.c), toTicks(b.h), toTicks(b.l)];
    for (let k = 0; k < 4; k++) {
      if (!Number.isSafeInteger(row[k])) throw new RangeError(`price out of range in bar t=${b.t}`);
      P[k].push(row[k]);
      sub = gcd(sub, row[k] % 100);
    }
    vg = gcd(vg, b.v);
  }
  // subTick: the coarsest grid (100 = whole cents, 10, 1) all sub-cent remainders sit on.
  const subTick = sub === 0 ? 100 : sub % 10 === 0 ? 10 : 1;
  const volTick = vg > 0 ? vg : 1;

  const w = new Writer(64 + n * 9);
  w.u(tfSec);
  const T = bars.map((b) => b.t);
  const phase = n ? ((T[0] % tfSec) + tfSec) % tfSec : 0;
  const onGrid = T.every((t) => (((t - phase) % tfSec) + tfSec) % tfSec === 0);
  w.u(onGrid ? 0 : 1);
  w.u(n);
  w.u(subTick);
  w.u(volTick);
  if (n) {
    if (onGrid) {
      const slots = T.map((t) => (t - phase) / tfSec);
      const runs: [number, number][] = [];
      let prevEnd = slots[0];
      for (let i = 0; i < n; ) {
        let j = i + 1;
        while (j < n && slots[j] === slots[j - 1] + 1) j++;
        runs.push([slots[i] - prevEnd, j - i]);
        prevEnd = slots[j - 1] + 1;
        i = j;
      }
      w.u(phase); w.u(slots[0]); w.u(runs.length);
      for (const [gap, len] of runs) { w.u(gap); w.u(len); }
    } else {
      w.u(T[0]);
      for (let i = 1; i < n; i++) w.u(T[i] - T[i - 1]);
    }
    const q = (k: number, i: number) => Math.floor(P[k][i] / 100);
    let prevC = 0;
    for (let i = 0; i < n; i++) { w.s(q(0, i) - prevC); prevC = q(1, i); }
    for (let i = 0; i < n; i++) w.s(q(1, i) - q(0, i));
    for (let i = 0; i < n; i++) w.u(q(2, i) - Math.max(q(0, i), q(1, i)));
    for (let i = 0; i < n; i++) w.u(Math.min(q(0, i), q(1, i)) - q(3, i));
    if (subTick < 100) for (let k = 0; k < 4; k++) for (let i = 0; i < n; i++) w.u((P[k][i] % 100) / subTick);
    for (let i = 0; i < n; i++) w.u(bars[i].v / volTick);
  }
  const raw = w.bytes();
  const mode = opts.compress ?? "auto";
  let body: Uint8Array = raw, tag = COMPRESS_NONE;
  const consider = (b: Uint8Array, t: number) => { if (b.length < body.length) { body = b; tag = t; } };
  if (mode === "brotli" || mode === "auto") {
    consider(brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_LGWIN]: 16,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    }), COMPRESS_BROTLI);
  }
  if (mode === "deflate" || mode === "auto") consider(deflateRawSync(raw, { level: 9 }), COMPRESS_DEFLATE);
  const out = Buffer.allocUnsafe(body.length + 1);
  out[0] = tag;
  out.set(body, 1);
  return out;
}

// ── decode ─────────────────────────────────────────────────────────────────────

export type Decoded = { tfSec: number; bars: Bar[] };

export function decodeBars(payload: Uint8Array): Decoded {
  if (!payload.length) return { tfSec: 0, bars: [] };
  const tag = payload[0];
  const body = payload.subarray(1);
  const raw = tag === COMPRESS_BROTLI ? brotliDecompressSync(body) : tag === COMPRESS_DEFLATE ? inflateRawSync(body) : tag === COMPRESS_NONE ? body : null;
  if (!raw) throw new RangeError(`unknown candle payload compressor ${tag}`);
  const r = new Reader(raw);
  const tfSec = r.u();
  const timeMode = r.u();
  const n = r.u();
  const subTick = r.u();
  const volTick = r.u();
  const T = new Array<number>(n);
  if (n) {
    if (timeMode === 0) {
      const phase = r.u();
      let slot = r.u();
      const runs = r.u();
      let k = 0;
      for (let i = 0; i < runs; i++) {
        slot += r.u();
        const len = r.u();
        if (k + len > n) throw new RangeError("candle payload: run lengths exceed the bar count");
        for (let j = 0; j < len; j++) T[k++] = (slot++) * tfSec + phase;
      }
      if (k !== n) throw new RangeError("candle payload: run lengths do not add up");
    } else {
      T[0] = r.u();
      for (let i = 1; i < n; i++) T[i] = T[i - 1] + r.u();
    }
  }
  // Cents: opens are deltas against the previous close.
  const D = new Array<number>(n), O = new Array<number>(n), C = new Array<number>(n), H = new Array<number>(n), L = new Array<number>(n);
  for (let i = 0; i < n; i++) D[i] = r.s();
  let prevC = 0;
  for (let i = 0; i < n; i++) { O[i] = prevC + D[i]; C[i] = O[i] + r.s(); prevC = C[i]; }
  for (let i = 0; i < n; i++) H[i] = Math.max(O[i], C[i]) + r.u();
  for (let i = 0; i < n; i++) L[i] = Math.min(O[i], C[i]) - r.u();
  const cols = [O, C, H, L];
  for (const col of cols) for (let i = 0; i < n; i++) col[i] *= 100;
  if (subTick < 100) for (const col of cols) for (let i = 0; i < n; i++) col[i] += r.u() * subTick;
  const bars = new Array<Bar>(n);
  for (let i = 0; i < n; i++) {
    bars[i] = { t: T[i], o: O[i] / PRICE_SCALE, h: H[i] / PRICE_SCALE, l: L[i] / PRICE_SCALE, c: C[i] / PRICE_SCALE, v: r.u() * volTick };
  }
  return { tfSec, bars };
}
