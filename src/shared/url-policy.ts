/** URL policy shared by the guard, runtime and bridge. */

export function normalizeWebUrl(input: string | null | undefined): URL | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function normalizeDomainEntry(entry: string): string {
  return String(entry ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
}

export function normalizeDomainList(entries: readonly string[] | null | undefined): string[] {
  return (entries ?? []).map(normalizeDomainEntry).filter(Boolean);
}

export function hostOf(url: string): string | null {
  const parsed = normalizeWebUrl(url);
  return parsed ? parsed.hostname.toLowerCase().replace(/\.+$/, "") : null;
}

/** Empty list allows everything; a list that normalizes away denies everything. */
export function isUrlAllowed(
  url: string,
  allowedDomains: readonly string[] | null | undefined
): boolean {
  const configured = allowedDomains ?? [];
  if (configured.length === 0) return true;
  const host = hostOf(url);
  if (!host) return false;
  return normalizeDomainList(configured).some(
    (entry) => host === entry || host.endsWith(`.${entry}`)
  );
}
