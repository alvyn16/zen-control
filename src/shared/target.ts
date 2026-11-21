/**
 * Target normalization shared by click/type. A target must name exactly one
 * control in exactly one way; ambiguity is rejected before any browser work.
 */
import type { PageTargetSpec } from "./protocol.js";

export const TARGET_REF_CHARS = 20;
export const TARGET_ROLE_CHARS = 200;
export const TARGET_NAME_CHARS = 200;
export const TARGET_TEXT_CHARS = 500;
export const TARGET_LABEL_CHARS = 200;
export const TARGET_PLACEHOLDER_CHARS = 200;
export const TARGET_SELECTOR_CHARS = 500;
export const TARGET_MAX_CANDIDATES = 5;

export type TargetMatchMode = "exact" | "contains";
export type TargetKind = "ref" | "role" | "text" | "label" | "placeholder" | "selector";

export interface NormalizedTarget {
  kind: TargetKind;
  /** Primary value for ref/text/label/placeholder/selector (and name for role). */
  value?: string;
  role?: string;
  name?: string;
  match: TargetMatchMode;
  maxCandidates: number;
  /** True for the legacy top-level ref/selector shortcuts. */
  legacy: boolean;
}

export interface TargetInput {
  ref?: string;
  selector?: string;
  target?: PageTargetSpec;
}

export class TargetInputError extends Error {
  readonly code = "invalid_target";
  readonly field: string;
  readonly limit: number;
  readonly length: number;

  constructor(
    message: string,
    details: { field?: string; limit?: number; length?: number } = {}
  ) {
    super(message);
    this.name = "TargetInputError";
    this.field = details.field ?? "";
    this.limit = details.limit ?? 0;
    this.length = details.length ?? 0;
  }

  /** Structured metadata for the bridge's error envelope. */
  get details(): { field: string; limit: number; length: number } {
    return { field: this.field, limit: this.limit, length: this.length };
  }
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleaned(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function bounded(value: string, field: string, limit: number): string {
  if (value.length > limit) {
    throw new TargetInputError(`${field} must be ${limit} characters or fewer.`, {
      field,
      limit,
      length: value.length,
    });
  }
  return value;
}

function result(
  kind: TargetKind,
  value: string,
  match: TargetMatchMode = "exact",
  extras: { role?: string; name?: string; legacy?: boolean } = {}
): NormalizedTarget {
  return {
    kind,
    value,
    match,
    maxCandidates: TARGET_MAX_CANDIDATES,
    legacy: extras.legacy === true,
    role: extras.role,
    name: extras.name,
  };
}

/**
 * Accepts either the legacy top-level `ref`/`selector` fields or the newer
 * `target` object, never both. The target object must supply one strategy.
 */
export function normalizeTargetInput(input: TargetInput = {}): NormalizedTarget {
  const topRef = trimmed(input.ref);
  const topSelector = trimmed(input.selector);
  const target = input.target;

  if (target !== undefined && target !== null) {
    if (topRef || topSelector) {
      throw new TargetInputError(
        "Provide target or a top-level ref/selector, not both."
      );
    }
    if (typeof target !== "object" || Array.isArray(target)) {
      throw new TargetInputError("target must be an object.");
    }
    return normalizeTargetObject(target);
  }

  if (Boolean(topRef) === Boolean(topSelector)) {
    throw new TargetInputError("Provide exactly one of ref or selector.");
  }
  if (topRef) {
    return result("ref", bounded(topRef, "ref", TARGET_REF_CHARS), "exact", { legacy: true });
  }
  return result("selector", bounded(topSelector, "selector", TARGET_SELECTOR_CHARS), "exact", { legacy: true });
}

function normalizeTargetObject(target: PageTargetSpec): NormalizedTarget {
  const ref = trimmed(target.ref);
  const role = cleaned(target.role);
  const name = cleaned(target.name);
  const text = cleaned(target.text);
  const label = cleaned(target.label);
  const placeholder = cleaned(target.placeholder);
  const selector = trimmed(target.selector);
  const match = target.match;

  if (match !== undefined && match !== "exact" && match !== "contains") {
    throw new TargetInputError('match must be "exact" or "contains".', {
      field: "target.match",
    });
  }

  const strategies: string[] = [];
  if (ref) strategies.push("ref");
  if (role || name) strategies.push("role");
  if (text) strategies.push("text");
  if (label) strategies.push("label");
  if (placeholder) strategies.push("placeholder");
  if (selector) strategies.push("selector");
  if (strategies.length !== 1) {
    throw new TargetInputError(
      "Provide exactly one of ref, role+name, text, label, placeholder or " +
        "selector inside target.",
      { field: "target", length: strategies.length }
    );
  }

  const mode = match ?? "exact";
  if (ref) {
    if (match !== undefined) throw matchOnlyError();
    return result("ref", bounded(ref, "target.ref", TARGET_REF_CHARS));
  }
  if (role || name) {
    if (!role || !name) {
      throw new TargetInputError("role and name must be provided together.", {
        field: "target.role+name",
      });
    }
    const safeRole = bounded(role, "target.role", TARGET_ROLE_CHARS).toLowerCase();
    const safeName = bounded(name, "target.name", TARGET_NAME_CHARS);
    return result("role", safeName, mode, { role: safeRole, name: safeName });
  }
  if (text) {
    return result("text", bounded(text, "target.text", TARGET_TEXT_CHARS), mode);
  }
  if (label) {
    if (match !== undefined) throw matchOnlyError();
    return result("label", bounded(label, "target.label", TARGET_LABEL_CHARS));
  }
  if (placeholder) {
    if (match !== undefined) throw matchOnlyError();
    return result(
      "placeholder",
      bounded(placeholder, "target.placeholder", TARGET_PLACEHOLDER_CHARS)
    );
  }
  if (match !== undefined) throw matchOnlyError();
  return result("selector", bounded(selector, "target.selector", TARGET_SELECTOR_CHARS));
}

function matchOnlyError(): TargetInputError {
  return new TargetInputError(
    "match applies only to role+name and text targets.",
    { field: "target.match" }
  );
}

/** Normalizes an accessible name, visible text or label for comparison. */
export function normalizeTargetText(value: unknown): string {
  return cleaned(value).toLowerCase();
}

/** Exact/contains comparison used by the in-page resolver. */
export function targetTextMatches(
  candidate: unknown,
  wanted: string,
  mode: TargetMatchMode
): boolean {
  const haystack = normalizeTargetText(candidate);
  const needle = normalizeTargetText(wanted);
  if (!needle) return false;
  return mode === "contains" ? haystack.includes(needle) : haystack === needle;
}
