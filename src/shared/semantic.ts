/**
 * Semantic page model: bounded coercion plus a deterministic, explainable
 * page classifier. No field values, hidden text or page scripts ever enter
 * this shape.
 */
import type {
  PageClassification,
  SemanticCollection,
  SemanticCollectionKind,
  SemanticDialog,
  SemanticHeading,
  SemanticPage,
  SemanticRegion,
  SemanticRegionRole,
} from "./protocol.js";

export const SEMANTIC_MAX_REGIONS = 40;
export const SEMANTIC_MAX_HEADINGS = 40;
/** Alias kept for callers using the older constant name. */
export const SEMANTIC_MAX_HEADINGS_LIST = SEMANTIC_MAX_HEADINGS;
export const SEMANTIC_MAX_COLLECTIONS = 12;
export const SEMANTIC_MAX_DIALOGS = 5;
export const SEMANTIC_MAX_SIGNALS = 6;
export const SEMANTIC_MAX_CONTROLS = 120;
export const SEMANTIC_MAX_NODES = 6_000;
export const SEMANTIC_MAX_SAMPLES = 3;
export const SEMANTIC_MAX_SHADOW_ROOTS = 40;
export const SEMANTIC_MAX_DEPTH = 10;
export const SEMANTIC_LABEL_CHARS = 120;
export const SEMANTIC_HEADING_CHARS = 160;
export const SEMANTIC_MAX_LIMITATIONS = 5;

export const PAGE_CLASSIFICATIONS: readonly PageClassification[] = [
  "article", "search-results", "product", "listing", "dashboard",
  "login", "form", "documentation", "discussion", "generic",
];

const REGION_ROLES: readonly SemanticRegionRole[] = [
  "banner", "navigation", "main", "complementary", "contentinfo", "search",
  "form", "article", "section", "dialog", "table", "list",
];
const COLLECTION_KINDS: readonly SemanticCollectionKind[] = [
  "cards", "results", "links", "items",
];
const LABEL_SOURCES = ["aria", "html", "heading", "inferred"] as const;

export interface SemanticSignals {
  password: number;
  search: number;
  forms: number;
  repeatedArticles: number;
  headings: number;
  codeBlocks: number;
  tables: number;
  regions: number;
  repeatedCards: number;
  priceCards: number;
  addToCart: number;
  searchWithResults: number;
}

export interface PageClassificationResult {
  classification: PageClassification;
  confidence: number;
  signals: string[];
}

const PRIORITY: readonly PageClassification[] = [
  "login", "search-results", "product", "documentation", "discussion",
  "dashboard", "article", "form", "listing",
];

/** Deterministic point system; near ties are reported with capped confidence. */
export function classifyPage(signals: SemanticSignals): PageClassificationResult {
  const scores = new Map<PageClassification, number>();
  const evidence: string[] = [];
  const add = (kind: PageClassification, points: number, signal: string): void => {
    scores.set(kind, (scores.get(kind) ?? 0) + points);
    if (!evidence.includes(signal)) evidence.push(signal);
  };
  const s = signals ?? ({} as SemanticSignals);

  if (s.password > 0) add("login", 5, "password field");
  if (s.search > 0) add("search-results", 2, "search control");
  if (s.forms > 0) add("form", 2, "form landmark");
  if (s.repeatedArticles >= 3) add("discussion", 2, "repeated articles");
  if (s.repeatedArticles > 0 && s.headings >= 3) add("article", 2, "article structure");
  if (s.codeBlocks >= 3) add("documentation", 3, "code blocks");
  if (s.tables >= 2 && s.regions >= 4) add("dashboard", 2, "tables with landmarks");
  if (s.repeatedCards > 0) add("listing", 2, "repeated cards");
  if (s.repeatedCards > 0 && s.priceCards > 0) add("product", 3, "price cards");
  if (s.addToCart > 0) add("product", 4, "add-to-cart control");
  if (s.searchWithResults > 0) add("search-results", 3, "results collection");

  let best: PageClassification = "generic";
  let bestScore = 0;
  let second = 0;
  for (const kind of PRIORITY) {
    const score = scores.get(kind) ?? 0;
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = kind;
    } else if (score > second) {
      second = score;
    }
  }
  if (bestScore < 2) best = "generic";

  const margin = Math.max(0, bestScore - second);
  let confidence = best === "generic" ? 0.35 : Math.min(0.95, 0.5 + 0.08 * bestScore + 0.04 * margin);
  if (best !== "generic" && margin < 2) confidence = Math.min(confidence, 0.6);

  return {
    classification: best,
    confidence: Math.round(confidence * 100) / 100,
    signals: evidence.slice(0, SEMANTIC_MAX_SIGNALS),
  };
}

/** Drops region fields that merely restate another field. */
export function leanSemanticPage(page: SemanticPage): SemanticPage {
  return {
    ...page,
    regions: page.regions.map((region) => {
      const lean: SemanticRegion = { id: region.id, role: region.role };
      const label = region.label ?? null;
      const heading = region.heading ?? null;
      if (label && label !== heading) {
        lean.label = label;
        lean.labelSource = region.labelSource;
      }
      if (heading) lean.heading = heading;
      if (region.parent) lean.parent = region.parent;
      if (region.ref) lean.ref = region.ref;
      if ((region.controls ?? 0) > 0) lean.controls = region.controls;
      if ((region.links ?? 0) > 0) lean.links = region.links;
      if ((region.items ?? 0) > 0) {
        lean.items = region.items;
        if (region.itemKind) lean.itemKind = region.itemKind;
      }
      return lean;
    }),
  };
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function nullableText(value: unknown, max: number): string | null {
  const result = text(value, max).trim();
  return result || null;
}

function count(value: unknown, max = 1_000_000): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(max, Math.max(0, Math.floor(numeric)));
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function coerceRegion(value: unknown, index: number): SemanticRegion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    id: text(raw.id, 16) || `r${index + 1}`,
    role: oneOf(raw.role, REGION_ROLES, "section"),
    label: nullableText(raw.label, SEMANTIC_LABEL_CHARS),
    labelSource: oneOf(raw.labelSource, LABEL_SOURCES, "inferred"),
    heading: nullableText(raw.heading, SEMANTIC_HEADING_CHARS),
    parent: nullableText(raw.parent, 16),
    ref: nullableText(raw.ref, 24),
    controls: count(raw.controls),
    links: count(raw.links),
    items: raw.items === null || raw.items === undefined ? null : count(raw.items),
    itemKind:
      raw.itemKind === null || raw.itemKind === undefined
        ? null
        : oneOf(raw.itemKind, COLLECTION_KINDS, "items"),
  };
}

function coerceCollection(value: unknown): SemanticCollection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const regionId = text(raw.regionId, 16);
  if (!regionId) return null;
  const sample: SemanticCollection["sample"] = [];
  if (Array.isArray(raw.sample)) {
    for (const entry of raw.sample.slice(0, SEMANTIC_MAX_SAMPLES)) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const ref = text(item.ref, 24);
      if (!ref) continue;
      sample.push({ ref, label: text(item.label, SEMANTIC_LABEL_CHARS) });
    }
  }
  return {
    regionId,
    kind: oneOf(raw.kind, COLLECTION_KINDS, "items"),
    count: count(raw.count),
    sample,
  };
}

function coerceDialog(value: unknown): SemanticDialog | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const ref = text(raw.ref, 24);
  if (!ref) return null;
  return {
    ref,
    label: text(raw.label, SEMANTIC_LABEL_CHARS) || "dialog",
    modal: raw.modal === true,
  };
}

function coerceHeading(value: unknown): SemanticHeading | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const content = text(raw.text, SEMANTIC_HEADING_CHARS).trim();
  if (!content) return null;
  const level = count(raw.level, 6);
  return {
    level: level >= 1 && level <= 6 ? level : 2,
    text: content,
    ref: nullableText(raw.ref, 24),
  };
}

/** Defensive parse of a bridge payload into the semantic wire shape. */
export function coerceSemanticPage(raw: unknown): SemanticPage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const regions: SemanticRegion[] = [];
  if (Array.isArray(value.regions)) {
    for (const [index, entry] of value.regions.slice(0, SEMANTIC_MAX_REGIONS).entries()) {
      const region = coerceRegion(entry, index);
      if (region) regions.push(region);
    }
  }
  const headings: SemanticHeading[] = [];
  if (Array.isArray(value.headings)) {
    for (const entry of value.headings.slice(0, SEMANTIC_MAX_HEADINGS)) {
      const heading = coerceHeading(entry);
      if (heading) headings.push(heading);
    }
  }
  const collections: SemanticCollection[] = [];
  if (Array.isArray(value.collections)) {
    for (const entry of value.collections.slice(0, SEMANTIC_MAX_COLLECTIONS)) {
      const collection = coerceCollection(entry);
      if (collection) collections.push(collection);
    }
  }
  const dialogs: SemanticDialog[] = [];
  if (Array.isArray(value.dialogs)) {
    for (const entry of value.dialogs.slice(0, SEMANTIC_MAX_DIALOGS)) {
      const dialog = coerceDialog(entry);
      if (dialog) dialogs.push(dialog);
    }
  }
  const coverageRaw =
    value.coverage && typeof value.coverage === "object" && !Array.isArray(value.coverage)
      ? (value.coverage as Record<string, unknown>)
      : {};
  const confidence = Number(value.confidence);
  const signals: string[] = [];
  if (Array.isArray(value.signals)) {
    for (const signal of value.signals.slice(0, SEMANTIC_MAX_SIGNALS)) {
      const clean = text(signal, 80);
      if (clean) signals.push(clean);
    }
  }
  const limitations: string[] = [];
  if (Array.isArray(value.limitations)) {
    for (const limitation of value.limitations.slice(0, SEMANTIC_MAX_LIMITATIONS)) {
      const clean = text(limitation, 300);
      if (clean) limitations.push(clean);
    }
  }
  return {
    classification: oneOf(value.classification, PAGE_CLASSIFICATIONS, "generic"),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    signals,
    primaryRegion: nullableText(value.primaryRegion, 16),
    regions,
    headings,
    collections,
    dialogs,
    coverage: {
      complete: value.coverage === undefined ? false : coverageRaw.complete === true,
      nodes: count(coverageRaw.nodes),
      regions: count(coverageRaw.regions, SEMANTIC_MAX_REGIONS),
      regionsTruncated: coverageRaw.regionsTruncated === true,
      controls: count(coverageRaw.controls),
      links: count(coverageRaw.links),
      headings: count(coverageRaw.headings),
      tables: count(coverageRaw.tables),
      images: count(coverageRaw.images),
      missingAlt: count(coverageRaw.missingAlt),
      shadowRoots: count(coverageRaw.shadowRoots),
    },
    limitations,
  };
}
