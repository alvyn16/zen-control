/**
 * Short-lived read baselines for delta reads.
 *
 * A caller that already read a page can stash its text under an opaque token,
 * then pass that token to a later read to get only what changed. Entries are
 * bounded in count and age so this never becomes an unbounded memory store.
 */
import { randomUUID } from "node:crypto";

export interface ReadDeltaSnapshot {
  tabId: string;
  text: string;
  documentId: string;
  url: string;
  createdAt: number;
  /** Cheap content-actor signature captured with the baseline. */
  textHash?: number;
  textLength?: number;
}

export interface ReadDeltaDiff {
  added: string;
  removed: string;
  truncated: boolean;
}

const MAX_ENTRIES = 100;
const TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_CHARS = 4_000;

interface StoredEntry {
  snapshot: ReadDeltaSnapshot;
  expiresAt: number;
}

/**
 * Diffs two strings in O(n) by trimming their common prefix and suffix. This
 * is deliberately not an LCS: it reports the single contiguous span that was
 * replaced, which is enough for a "what changed since my last read" summary.
 */
export function diffText(before: string, after: string, maxChars: number = DEFAULT_MAX_CHARS): ReadDeltaDiff {
  const left = typeof before === "string" ? before : "";
  const right = typeof after === "string" ? after : "";
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : DEFAULT_MAX_CHARS;

  let prefix = 0;
  const sharedPrefix = Math.min(left.length, right.length);
  while (prefix < sharedPrefix && left.charCodeAt(prefix) === right.charCodeAt(prefix)) {
    prefix += 1;
  }

  let suffix = 0;
  const leftEnd = left.length - prefix;
  const rightEnd = right.length - prefix;
  while (
    suffix < leftEnd && suffix < rightEnd &&
    left.charCodeAt(left.length - 1 - suffix) === right.charCodeAt(right.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  const removed = left.slice(prefix, left.length - suffix);
  const added = right.slice(prefix, right.length - suffix);
  const truncated = removed.length > limit || added.length > limit;
  return {
    added: added.slice(0, limit),
    removed: removed.slice(0, limit),
    truncated,
  };
}

export class ReadDeltaStore {
  /** Insertion order is LRU order: newest last, least-recently-used first. */
  readonly #entries = new Map<string, StoredEntry>();

  create(
    tabId: string,
    text: string,
    documentId: string,
    url: string,
    signature?: { textHash?: number; textLength?: number }
  ): string {
    this.#pruneExpired();
    const now = Date.now();
    const token = this.#newToken();
    this.#entries.set(token, {
      snapshot: {
        tabId: String(tabId ?? ""),
        text: typeof text === "string" ? text : "",
        documentId: String(documentId ?? ""),
        url: String(url ?? ""),
        createdAt: now,
        ...(typeof signature?.textHash === "number" ? { textHash: signature.textHash } : {}),
        ...(typeof signature?.textLength === "number" ? { textLength: signature.textLength } : {}),
      },
      expiresAt: now + TTL_MS,
    });
    while (this.#entries.size > MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return token;
  }

  get(token: string): ReadDeltaSnapshot | null {
    if (typeof token !== "string") return null;
    const entry = this.#entries.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(token);
      return null;
    }
    // Refresh recency: a touched entry is now the most recently used.
    this.#entries.delete(token);
    this.#entries.set(token, entry);
    return entry.snapshot;
  }

  diff(before: string, after: string, maxChars?: number): ReadDeltaDiff {
    return diffText(before, after, maxChars);
  }

  get size(): number {
    this.#pruneExpired();
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  #newToken(): string {
    let token = "";
    do {
      let id: string;
      try {
        id = randomUUID().replace(/-/g, "");
      } catch {
        id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      }
      token = `dr-${id.slice(0, 8)}`;
    } while (this.#entries.has(token));
    return token;
  }

  #pruneExpired(): void {
    const now = Date.now();
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(token);
    }
  }
}
