/**
 * Evidence quote matching. Pure code: it runs in Node and inside the bridge,
 * never touching platform APIs. The match ladder is exact -> normalized ->
 * context-assisted -> fuzzy, and a repeated quote is never resolved by simply
 * taking the first hit.
 */
import type { EvidenceMatchMethod } from "./protocol.js";

export type { EvidenceMatchMethod } from "./protocol.js";

export interface EvidenceMatch {
  ok: boolean;
  method?: EvidenceMatchMethod;
  confidence?: number;
  start: number;
  end: number;
  matchedQuote: string;
  occurrences: number;
  ambiguous?: boolean;
  errorCode?: "QUOTE_NOT_FOUND" | "AMBIGUOUS_MATCH" | "LOW_MATCH_CONFIDENCE";
  message?: string;
  occurrencesTruncated?: boolean;
  candidates?: Array<{ start: number; end: number; excerpt: string }>;
}

export interface EvidenceMatchOptions {
  quote: string;
  context?: string;
  minConfidence?: number;
  maxCandidates?: number;
}

export interface CanonicalText {
  text: string;
  starts: number[];
  ends: number[];
  folds: number[];
}

interface Candidate {
  start: number;
  end: number;
  confidence: number;
  contextScore: number;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

interface CriticalProfile {
  numbers: Map<string, number>;
  negations: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.85;
const MAX_CANDIDATES = 5;
const CONTEXT_WINDOW = 240;
const CONTEXT_PROXIMITY_DECAY = 12;
const CONTEXT_MIN_SCORE = 0.2;
const CONTEXT_MIN_MARGIN = 0.1;
const MAX_OCCURRENCES = 50;
const MAX_CONTEXT_OCCURRENCES = 300;
const MAX_FUZZY_QUOTE = 300;
const MAX_FUZZY_WINDOWS = 160;
const MIN_FUZZY_SIMILARITY = 0.45;
const MIN_FUZZY_PLAUSIBILITY = 0.7;
const NORMALIZED_CONFIDENCE = [0.99, 0.97, 0.93] as const;
const TOKEN_SOURCE = "[\\p{L}\\p{N}]+";
const NEGATIONS = new Set([
  "no", "not", "never", "none", "nobody", "nothing", "neither", "nor",
  "cannot", "without", "lack", "lacks", "lacking", "denied", "denies",
]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", lsquo: "\u2018",
  rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", laquo: "\u00ab",
  raquo: "\u00bb", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  deg: "\u00b0", plusmn: "\u00b1", times: "\u00d7", divide: "\u00f7",
  frac12: "\u00bd", frac14: "\u00bc", frac34: "\u00be",
};

const PUNCTUATION: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
  "\u2032": "'", "\u00b4": "'", "\u201c": '"', "\u201d": '"',
  "\u201e": '"', "\u201f": '"', "\u2033": '"', "\u00ab": '"',
  "\u00bb": '"', "\u2039": "'", "\u203a": "'", "\u300c": '"',
  "\u300d": '"', "\u300e": '"', "\u300f": '"', "\u2010": "-",
  "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-",
  "\u2015": "-", "\u2212": "-", "\u00ad": "", "\u2026": "...",
  "\u22ef": "...", "\u00a0": " ",
};

const INVISIBLE = /^[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]$/u;
const SPACE = /^\s$/u;
const MARK = /^\p{M}$/u;
const LATIN_LETTER = /^[a-z]$/;

/** Decodes the small set of HTML entities an agent commonly copies. */
export function decodeHtmlEntities(input: string): string {
  return String(input ?? "").replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi,
    (whole, body: string) => {
      if (body.charAt(0) !== "#") return ENTITIES[body.toLowerCase()] ?? whole;
      const hex = body.charAt(1).toLowerCase() === "x";
      const digits = body.slice(hex ? 2 : 1);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (
        !Number.isFinite(code) || code <= 0 || code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff) || isDisallowedControl(code)
      ) {
        return whole;
      }
      return String.fromCodePoint(code);
    }
  );
}

function isDisallowedControl(code: number): boolean {
  if (code === 9 || code === 10 || code === 13) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * Folds case, typography and Latin-only diacritics while remembering which raw
 * span produced each canonical unit. Fold levels are 0 (case), 1 (whitespace
 * or punctuation) and 2 (compatibility characters or diacritics).
 */
export function canonicalizeEvidenceText(input: string): CanonicalText {
  const text: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const folds: number[] = [];

  const emit = (value: string, from: number, to: number, fold: number): void => {
    for (let i = 0; i < value.length; i += 1) {
      text.push(value.charAt(i));
      starts.push(from);
      ends.push(to);
      folds.push(fold);
    }
  };

  const source = String(input ?? "");
  let cursor = 0;
  while (cursor < source.length) {
    const code = source.codePointAt(cursor);
    if (code === undefined) break;
    const character = String.fromCodePoint(code);
    const from = cursor;
    const to = cursor + character.length;
    cursor = to;

    if (INVISIBLE.test(character)) continue;
    if (SPACE.test(character)) {
      if (text.length === 0 || text[text.length - 1] === " ") continue;
      emit(" ", from, to, 1);
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;

    const mapped = PUNCTUATION[character];
    if (mapped !== undefined) {
      if (mapped) emit(mapped, from, to, 1);
      continue;
    }

    const compatibility = character.normalize("NFKC");
    const lowered = compatibility.toLowerCase();
    let fold = compatibility === character ? 0 : 2;
    let base = "";
    let folded = "";
    for (const unit of lowered.normalize("NFD")) {
      if (!MARK.test(unit)) {
        folded += unit;
        base = unit;
        continue;
      }
      if (LATIN_LETTER.test(base)) {
        fold = 2;
      } else {
        const last = text.length - 1;
        if (last >= 0 && LATIN_LETTER.test(text[last])) {
          // A combining mark in its own code point still belongs to the
          // preceding Latin letter (e.g. "cafe" + U+0301).
          folds[last] = 2;
          ends[last] = to;
          continue;
        }
        folded += unit;
      }
    }
    const normalized = folded.normalize("NFC");
    if (normalized) emit(normalized, from, to, fold);
  }

  while (text.length > 0 && text[text.length - 1] === " ") {
    text.pop();
    starts.pop();
    ends.pop();
    folds.pop();
  }
  return { text: text.join(""), starts, ends, folds };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function locateAll(
  haystack: string,
  needle: string,
  limit: number
): { starts: number[]; truncated: boolean } {
  const starts: number[] = [];
  if (!needle) return { starts, truncated: false };
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return { starts, truncated: false };
    if (starts.length >= limit) return { starts, truncated: true };
    starts.push(index);
    from = index + Math.max(1, needle.length);
  }
}

function excerptAt(page: string, start: number, end: number): string {
  const compact = page.slice(start, end).replace(/\s+/g, " ").trim();
  return compact.length <= 300 ? compact : `${compact.slice(0, 297)}...`;
}

function notFound(message: string): EvidenceMatch {
  return {
    ok: false, start: -1, end: -1, matchedQuote: "", occurrences: 0,
    errorCode: "QUOTE_NOT_FOUND", message,
  };
}

function success(
  page: string,
  start: number,
  end: number,
  method: EvidenceMatchMethod,
  confidence: number,
  occurrences: number,
  truncated?: boolean
): EvidenceMatch {
  return {
    ok: true,
    method,
    confidence: Math.round(confidence * 1000) / 1000,
    start,
    end,
    matchedQuote: page.slice(start, end),
    occurrences,
    ...(truncated ? { occurrencesTruncated: true } : {}),
  };
}

function ambiguous(
  page: string,
  candidates: Candidate[],
  maxCandidates: number,
  message: string,
  occurrences: number,
  truncated: boolean
): EvidenceMatch {
  const ranked = [...candidates].sort(
    (a, b) => b.contextScore - a.contextScore || a.start - b.start
  );
  return {
    ok: false,
    start: -1,
    end: -1,
    matchedQuote: "",
    occurrences,
    ambiguous: true,
    errorCode: "AMBIGUOUS_MATCH",
    message,
    ...(truncated ? { occurrencesTruncated: true } : {}),
    candidates: ranked.slice(0, maxCandidates).map((candidate) => ({
      start: candidate.start,
      end: candidate.end,
      excerpt: excerptAt(page, candidate.start, candidate.end),
    })),
  };
}

function scoreContexts(
  page: string,
  candidates: Candidate[],
  context: string
): void {
  const contextTokens = tokensOf(canonicalizeEvidenceText(context).text).map((t) => t.text);
  const uniqueContext = [...new Set(contextTokens)];
  const contextBigrams = bigrams(contextTokens);

  for (const candidate of candidates) {
    const beforeText = canonicalizeEvidenceText(
      page.slice(Math.max(0, candidate.start - CONTEXT_WINDOW), candidate.start)
    ).text;
    const afterText = canonicalizeEvidenceText(
      page.slice(candidate.end, Math.min(page.length, candidate.end + CONTEXT_WINDOW))
    ).text;
    const before = tokensOf(beforeText).map((t) => t.text);
    const after = tokensOf(afterText).map((t) => t.text);
    const windowTokens = [...before, ...after];
    const present = new Set(windowTokens);

    let hits = 0;
    let proximity = 0;
    for (const token of uniqueContext) {
      if (present.has(token)) hits += 1;
      let distance = Number.POSITIVE_INFINITY;
      const beforeIndex = before.lastIndexOf(token);
      if (beforeIndex >= 0) distance = before.length - beforeIndex;
      const afterIndex = after.indexOf(token);
      if (afterIndex >= 0) distance = Math.min(distance, afterIndex + 1);
      if (Number.isFinite(distance)) {
        proximity += 1 / (1 + (distance - 1) / CONTEXT_PROXIMITY_DECAY);
      }
    }

    const windowBigrams = bigrams(windowTokens);
    let bigramHits = 0;
    for (const pair of contextBigrams) if (windowBigrams.has(pair)) bigramHits += 1;

    const tokenScore = uniqueContext.length ? hits / uniqueContext.length : 0;
    const proximityScore = uniqueContext.length ? proximity / uniqueContext.length : 0;
    const bigramScore = contextBigrams.size ? bigramHits / contextBigrams.size : 0;
    candidate.contextScore = Math.round(
      (tokenScore * 0.45 + bigramScore * 0.3 + proximityScore * 0.25) * 1000
    ) / 1000;
  }
}

function bigrams(tokens: string[]): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    result.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return result;
}

function resolveOccurrences(
  page: string,
  spans: Candidate[],
  baseMethod: "exact" | "normalized",
  baseConfidence: number,
  context: string,
  maxCandidates: number,
  truncated: boolean,
  limit: number
): EvidenceMatch {
  if (spans.length === 0) return notFound("The quote was not found on the page.");
  if (spans.length === 1) {
    return success(
      page, spans[0].start, spans[0].end, baseMethod,
      spans[0].confidence || baseConfidence, 1, truncated
    );
  }
  if (!context) {
    return ambiguous(
      page, spans, maxCandidates,
      truncated
        ? `Found at least ${limit} matching passages and stopped counting. Supply a longer quote or nearby context; no passage was highlighted.`
        : `Found ${spans.length} matching passages and no context was supplied to choose between them. No passage was highlighted.`,
      truncated ? limit : spans.length,
      truncated
    );
  }

  scoreContexts(page, spans, context);
  const ranked = [...spans].sort(
    (a, b) => b.contextScore - a.contextScore || a.start - b.start
  );
  const best = ranked[0];
  const runnerUp = ranked[1];
  const margin = best.contextScore - (runnerUp?.contextScore ?? 0);
  if (best.contextScore >= CONTEXT_MIN_SCORE && margin >= CONTEXT_MIN_MARGIN) {
    return {
      ...success(
        page, best.start, best.end, "context",
        Math.min(0.95, best.confidence || baseConfidence),
        spans.length, truncated
      ),
    };
  }
  return ambiguous(
    page, ranked, maxCandidates,
    truncated
      ? `Found at least ${limit} passages; the supplied context did not clearly select one. No passage was highlighted.`
      : `Found ${spans.length} passages and the supplied context did not clearly select one. No passage was highlighted.`,
    truncated ? limit : spans.length,
    truncated
  );
}

function tokensOf(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = new RegExp(TOKEN_SOURCE, "gu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    if (tokens.length >= 200_000) break;
  }
  return tokens;
}

function criticalProfile(tokens: Token[]): CriticalProfile {
  const numbers = new Map<string, number>();
  let negations = 0;
  for (const token of tokens) {
    if (/\d/.test(token.text)) {
      numbers.set(token.text, (numbers.get(token.text) ?? 0) + 1);
    }
    if (NEGATIONS.has(token.text)) negations += 1;
  }
  return { numbers, negations };
}

function criticalTokensMatch(wanted: CriticalProfile, found: Token[]): boolean {
  const actual = criticalProfile(found);
  if (actual.negations !== wanted.negations) return false;
  if (actual.numbers.size !== wanted.numbers.size) return false;
  for (const [token, count] of wanted.numbers) {
    if (actual.numbers.get(token) !== count) return false;
  }
  return true;
}

function boundedLevenshtein(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let i = 0; i <= right.length; i += 1) previous[i] = i;
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    let rowMin = row;
    const code = left.charCodeAt(row - 1);
    for (let column = 1; column <= right.length; column += 1) {
      const cost = code === right.charCodeAt(column - 1) ? 0 : 1;
      const value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost
      );
      current[column] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[right.length] > limit ? limit + 1 : previous[right.length];
}

function similarityOf(candidate: string, quote: string): number {
  const longest = Math.max(candidate.length, quote.length);
  if (longest === 0) return 1;
  const limit = Math.ceil(longest * (1 - MIN_FUZZY_SIMILARITY));
  const distance = boundedLevenshtein(candidate, quote, limit);
  if (distance > limit) return 0;
  return Math.max(0, 1 - distance / longest);
}

function fuzzyWindows(
  canonical: CanonicalText,
  quoteText: string,
  quoteTokens: Token[]
): Array<{ start: number; end: number }> {
  const pageTokens = tokensOf(canonical.text);
  if (pageTokens.length === 0) return [];

  const seeds = new Set(
    [...new Set(quoteTokens.map((t) => t.text))]
      .filter((token) => token.length >= 3)
      .sort((a, b) => b.length - a.length)
      .slice(0, 10)
  );
  if (seeds.size === 0) return [];

  const positions = new Map<string, number[]>();
  pageTokens.forEach((token, index) => {
    if (!seeds.has(token.text)) return;
    const list = positions.get(token.text);
    if (list) {
      if (list.length < 25) list.push(index);
    } else {
      positions.set(token.text, [index]);
    }
  });

  const windows: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();
  for (let quoteIndex = 0; quoteIndex < quoteTokens.length; quoteIndex += 1) {
    const token = quoteTokens[quoteIndex].text;
    if (!seeds.has(token)) continue;
    for (const pageIndex of positions.get(token) ?? []) {
      const base = pageIndex - quoteIndex;
      for (const padding of [0, 1]) {
        const from = base - padding;
        const to = base + quoteTokens.length - 1 + padding;
        if (from < 0 || to >= pageTokens.length) continue;
        if (to - from + 1 > quoteTokens.length * 2 + 2) continue;
        const start = pageTokens[from].start;
        const end = pageTokens[to].end;
        if (end - start > quoteText.length * 1.8 + 32) continue;
        const key = `${start}:${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        windows.push({ start, end });
        if (windows.length >= MAX_FUZZY_WINDOWS) return windows;
      }
    }
  }
  return windows;
}

function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (overlap <= 0) return 0;
  const shortest = Math.min(a.end - a.start, b.end - b.start);
  return shortest > 0 ? overlap / shortest : 0;
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort(
    (a, b) => b.confidence - a.confidence || (a.end - a.start) - (b.end - b.start) || a.start - b.start
  );
  const kept: Candidate[] = [];
  for (const candidate of sorted) {
    if (kept.some((existing) => overlapRatio(existing, candidate) > 0.6)) continue;
    kept.push(candidate);
  }
  return kept;
}

function fuzzyMatch(
  page: string,
  canonical: CanonicalText,
  quoteCanonical: CanonicalText,
  threshold: number,
  maxCandidates: number
): EvidenceMatch {
  if (quoteCanonical.text.length > MAX_FUZZY_QUOTE) {
    return notFound(
      `The quote is ${quoteCanonical.text.length} characters, beyond the ` +
        `${MAX_FUZZY_QUOTE}-character fuzzy limit. Supply an exact excerpt or a shorter quote.`
    );
  }
  const quoteTokens = tokensOf(quoteCanonical.text);
  if (quoteTokens.length === 0) return notFound("The quote has no readable words.");

  const profile = criticalProfile(quoteTokens);
  const windows = fuzzyWindows(canonical, quoteCanonical.text, quoteTokens);
  const candidates: Candidate[] = [];
  for (const window of windows) {
    const windowText = canonical.text.slice(window.start, window.end);
    if (!criticalTokensMatch(profile, tokensOf(windowText))) continue;
    const similarity = similarityOf(windowText, quoteCanonical.text);
    if (similarity < MIN_FUZZY_SIMILARITY) continue;
    const start = canonical.starts[window.start];
    const end = canonical.ends[window.end - 1];
    if (start === undefined || end === undefined || end <= start) continue;
    candidates.push({ start, end, confidence: Math.round(similarity * 1000) / 1000, contextScore: 0 });
  }
  if (candidates.length === 0) {
    return notFound(
      `No passage matching the quote was found. Nothing reached the ` +
        `${Math.round(MIN_FUZZY_PLAUSIBILITY * 100)}% plausibility floor.`
    );
  }

  const distinct = dedupeCandidates(candidates);
  const best = distinct[0];
  if (best.confidence < threshold) {
    if (best.confidence >= MIN_FUZZY_PLAUSIBILITY) {
      return {
        ok: false,
        start: best.start,
        end: best.end,
        matchedQuote: page.slice(best.start, best.end),
        confidence: best.confidence,
        occurrences: distinct.length,
        errorCode: "LOW_MATCH_CONFIDENCE",
        message:
          `The closest passage matched at ${Math.round(best.confidence * 100)}%, ` +
          `below the required ${Math.round(threshold * 100)}%. No passage was highlighted.`,
      };
    }
    return notFound(
      `The closest passage matched at ${Math.round(best.confidence * 100)}%, ` +
        `below the ${Math.round(MIN_FUZZY_PLAUSIBILITY * 100)}% plausibility floor.`
    );
  }

  const runnerUp = distinct.find((other) => overlapRatio(other, best) < 0.4);
  if (runnerUp && runnerUp.confidence >= threshold && best.confidence - runnerUp.confidence < 0.04) {
    return ambiguous(
      page, distinct, maxCandidates,
      "Several similar passages matched equally well. Supply nearby context so one can be chosen; no passage was highlighted.",
      distinct.length, false
    );
  }
  return success(page, best.start, best.end, "fuzzy", best.confidence, distinct.length);
}

/**
 * Finds a quote in raw page text. Returns a flat result suitable for both the
 * evidence tool and the browser's highlight verifier.
 */
export function findEvidenceQuote(pageText: string, options: EvidenceMatchOptions): EvidenceMatch {
  const page = String(pageText ?? "");
  const quote = String(options?.quote ?? "").replace(/\r\n?/g, "\n").trim();
  if (!quote) return notFound("The quote is empty.");

  const decoded = decodeHtmlEntities(quote).trim();
  const variants = decoded && decoded !== quote ? [quote, decoded] : [quote];
  const context = decodeHtmlEntities(options.context ?? "").trim();
  const limit = context ? MAX_CONTEXT_OCCURRENCES : MAX_OCCURRENCES;
  const threshold = clamp(options.minConfidence ?? DEFAULT_MIN_CONFIDENCE, 0.5, 0.99);
  const maxCandidates = Math.max(1, Math.min(10, Math.trunc(options.maxCandidates ?? MAX_CANDIDATES)));

  for (const variant of variants) {
    const exact = locateAll(page, variant, limit);
    if (exact.starts.length > 0) {
      const spans: Candidate[] = exact.starts.map((start) => ({
        start, end: start + variant.length, confidence: 1, contextScore: 0,
      }));
      const outcome = resolveOccurrences(
        page, spans, "exact", 1, context, maxCandidates, exact.truncated, limit
      );
      return outcome;
    }
  }

  const pageCanonical = canonicalizeEvidenceText(page);
  const normalized: Candidate[] = [];
  let normalizedTruncated = false;
  for (const variant of variants) {
    const quoteCanonical = canonicalizeEvidenceText(variant);
    if (!quoteCanonical.text) continue;
    const found = locateAll(pageCanonical.text, quoteCanonical.text, limit);
    normalizedTruncated = normalizedTruncated || found.truncated;
    const quoteFold = Math.max(0, ...quoteCanonical.folds.slice(0, quoteCanonical.text.length));
    for (const canonicalStart of found.starts) {
      const canonicalEnd = canonicalStart + quoteCanonical.text.length;
      const start = pageCanonical.starts[canonicalStart];
      const end = pageCanonical.ends[canonicalEnd - 1];
      if (start === undefined || end === undefined || end <= start || end > page.length) continue;
      let fold = quoteFold;
      for (let i = canonicalStart; i < canonicalEnd; i += 1) {
        fold = Math.max(fold, pageCanonical.folds[i] ?? 0);
      }
      const confidence = NORMALIZED_CONFIDENCE[Math.min(fold, 2)];
      const key = `${start}:${end}`;
      const existing = normalized.find((item) => `${item.start}:${item.end}` === key);
      if (!existing || confidence > existing.confidence) {
        if (existing) {
          existing.confidence = confidence;
        } else {
          normalized.push({ start, end, confidence, contextScore: 0 });
        }
      }
    }
  }
  if (normalized.length > 0) {
    // Literal and normalized hits are authoritative: an ambiguous result must
    // never silently degrade into a fuzzy guess.
    return resolveOccurrences(
      page, normalized, "normalized", 0.99, context,
      maxCandidates, normalizedTruncated, limit
    );
  }

  return fuzzyMatch(page, pageCanonical, canonicalizeEvidenceText(decoded || quote), threshold, maxCandidates);
}
