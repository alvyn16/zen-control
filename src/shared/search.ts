/**
 * Literal page search. The query is always treated as data (never a regex),
 * and case-insensitive search reuses the evidence canonicalizer so `cafe`
 * matches `Café` and straight quotes match typographic ones.
 */
import { canonicalizeEvidenceText } from "./evidence.js";

export interface LiteralMatch {
  start: number;
  end: number;
  text: string;
  excerpt: string;
}

export interface LiteralSearchOptions {
  query: string;
  caseSensitive?: boolean;
  maxMatches?: number;
  contextChars?: number;
}

export interface LiteralSearchOutcome {
  matches: LiteralMatch[];
  totalMatches: number;
  scanStopped: boolean;
}

const DEFAULT_MAX_MATCHES = 20;
const MAX_MATCHES = 50;
const DEFAULT_CONTEXT_CHARS = 120;
const MAX_CONTEXT_CHARS = 300;
const MAX_SCAN = 5_000;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function excerptAt(page: string, start: number, end: number, context: number): string {
  const from = Math.max(0, start - context);
  const to = Math.min(page.length, end + context);
  const before = from > 0 ? "..." : "";
  const after = to < page.length ? "..." : "";
  return `${before}${collapse(page.slice(from, to))}${after}`;
}

export function findLiteralMatches(
  pageText: string,
  options: LiteralSearchOptions
): LiteralSearchOutcome {
  const page = String(pageText ?? "");
  const query = String(options?.query ?? "").trim();
  if (!page || !query) return { matches: [], totalMatches: 0, scanStopped: false };

  const maxMatches = clamp(options.maxMatches ?? DEFAULT_MAX_MATCHES, 1, MAX_MATCHES);
  const contextChars = clamp(options.contextChars ?? DEFAULT_CONTEXT_CHARS, 0, MAX_CONTEXT_CHARS);

  let spans: Array<{ start: number; end: number }> = [];
  if (options.caseSensitive === true) {
    let from = 0;
    while (spans.length < MAX_SCAN) {
      const index = page.indexOf(query, from);
      if (index === -1) break;
      spans.push({ start: index, end: index + query.length });
      from = index + Math.max(1, query.length);
    }
  } else {
    const canonicalPage = canonicalizeEvidenceText(page);
    const canonicalQuery = canonicalizeEvidenceText(query).text;
    if (!canonicalQuery) return { matches: [], totalMatches: 0, scanStopped: false };
    const seen = new Set<string>();
    let from = 0;
    while (spans.length < MAX_SCAN) {
      const index = canonicalPage.text.indexOf(canonicalQuery, from);
      if (index === -1) break;
      from = index + Math.max(1, canonicalQuery.length);
      const start = canonicalPage.starts[index];
      const end = canonicalPage.ends[index + canonicalQuery.length - 1];
      if (start === undefined || end === undefined || end <= start) continue;
      const key = `${start}:${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      spans.push({ start, end });
    }
  }

  const matches: LiteralMatch[] = spans.slice(0, maxMatches).map((span) => ({
    start: span.start,
    end: span.end,
    text: page.slice(span.start, span.end),
    excerpt: excerptAt(page, span.start, span.end, contextChars),
  }));
  return {
    matches,
    totalMatches: spans.length,
    scanStopped: spans.length >= MAX_SCAN,
  };
}
