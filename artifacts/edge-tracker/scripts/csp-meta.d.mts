import type { Plugin } from "vite";
export function inlineScriptHashes(html: string): string[];
export function metaCsp(hashes: readonly string[]): string;
export function injectMetaCsp(html: string): string;
export function cspMeta(): Plugin;
