export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function sanitizeMultiLineUrls(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;
  const lines = raw.split("\n").map((l) => safeHttpUrl(l)).filter((u): u is string => !!u);
  return lines.length > 0 ? lines.join("\n") : null;
}
