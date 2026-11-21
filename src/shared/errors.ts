export type ErrorCategory =
  | "not_found"
  | "stale_reference"
  | "document_changed"
  | "ambiguous"
  | "not_actionable"
  | "invalid_target"
  | "unsupported"
  | "permission"
  | "browser"
  | "action_failed"
  | "internal";

export interface ErrorMetadata {
  category: ErrorCategory;
  retryable: boolean;
  stateChanged: boolean | null;
  recovery: string;
}

const CATEGORIES = new Set<ErrorCategory>([
  "not_found", "stale_reference", "document_changed", "ambiguous", "not_actionable",
  "invalid_target", "unsupported", "permission", "browser", "action_failed", "internal",
]);

export function errorMetadata(code: string, details?: Record<string, unknown>): ErrorMetadata {
  const override =
    typeof details?.category === "string" && CATEGORIES.has(details.category as ErrorCategory)
      ? (details.category as ErrorCategory)
      : undefined;
  switch (code) {
    case "element_not_found":
    case "selector_not_found":
      return { category: override ?? "not_found", retryable: true, stateChanged: false, recovery: "Read the page again or refine the target." };
    case "stale_reference":
      return { category: "stale_reference", retryable: false, stateChanged: false, recovery: "Take a fresh snapshot and use a new ref." };
    case "document_changed":
      return { category: "document_changed", retryable: false, stateChanged: false, recovery: "The document navigated. Read it again and use a new ref." };
    case "target_not_found":
      return { category: "not_found", retryable: true, stateChanged: false, recovery: "Wait for the content or refine the target." };
    case "target_ambiguous":
      return { category: "ambiguous", retryable: false, stateChanged: false, recovery: "Use a ref or a more specific target." };
    case "target_not_actionable":
    case "element_disabled":
    case "element_readonly":
    case "unsupported_target":
      return { category: "not_actionable", retryable: false, stateChanged: false, recovery: "Inspect the element state or wait for it to change." };
    case "invalid_target":
      return { category: "invalid_target", retryable: false, stateChanged: false, recovery: "Supply exactly one target strategy." };
    case "unsupported_operation":
    case "unsupported_page":
    case "privileged_page":
      return { category: "unsupported", retryable: false, stateChanged: false, recovery: "Use a supported page or a narrower target." };
    case "read_only":
    case "domain_not_allowed":
    case "paused":
    case "cancelled":
    case "consent_required":
      return { category: "permission", retryable: false, stateChanged: false, recovery: "Adjust policy or ask the user before retrying." };
    case "browser_disconnected":
    case "bridge_unavailable":
    case "bridge_timeout":
    case "bridge_disconnected":
    case "tab_not_found":
    case "tab_not_loaded":
    case "actor_unavailable":
      return { category: "browser", retryable: false, stateChanged: false, recovery: "Check status and relaunch if the owned browser is gone." };
    case "click_failed":
    case "type_failed":
      return { category: "action_failed", retryable: false, stateChanged: null, recovery: "Inspect the page before retrying the action." };
    default:
      return { category: override ?? "internal", retryable: false, stateChanged: null, recovery: "Inspect the error before retrying." };
  }
}

export class DefinedError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DefinedError";
    this.code = code;
    this.details = details;
  }
}
