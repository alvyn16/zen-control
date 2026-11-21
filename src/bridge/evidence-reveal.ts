/**
 * Support for the "Show source" activity action.
 *
 * The overlay painted by `tabs.evidence` expires after a short TTL, so a later
 * click on the activity card must re-run the same fixed highlight pipeline. The
 * bridge remembers only the request that came from the agent's tool call
 * (quote, context, confidence floor) keyed by tab id. It never stores page
 * text, selectors or scripts, and the card action carries only a tab id.
 */
import type {
  EvidenceOpResult,
  EvidenceShowParams,
  SelectTabResult,
} from "../shared/protocol.js";

export const MAX_EVIDENCE_RECORDS = 20;
export const EVIDENCE_REVEAL_HIGHLIGHT_MS = 25_000;
const MAX_QUOTE_CHARS = 20_000;
const MAX_CONTEXT_CHARS = 8_000;
const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface EvidenceRecord {
  quote: string;
  context?: string;
  minConfidence?: number;
}

export type EvidenceRevealMethod = "tabs.select" | "tabs.evidence";
export type EvidenceRevealDispatch = (
  method: EvidenceRevealMethod,
  params: unknown
) => Promise<unknown>;

export interface EvidenceRevealOptions {
  highlightMs?: number;
}

export class EvidenceRevealError extends Error {
  override name = "EvidenceRevealError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

function isTabId(value: unknown): value is string {
  return typeof value === "string" && TAB_ID_PATTERN.test(value);
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && code ? code : fallback;
}

function clampHighlightMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return EVIDENCE_REVEAL_HIGHLIGHT_MS;
  return Math.min(120_000, Math.max(1_000, Math.floor(parsed)));
}

/** Bounded insertion-ordered map; reused tab ids become the newest entry. */
export class EvidenceRecordStore {
  readonly #records = new Map<string, EvidenceRecord>();
  readonly #limit: number;

  constructor(limit: number = MAX_EVIDENCE_RECORDS) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  get size(): number {
    return this.#records.size;
  }

  remember(tabId: string, record: EvidenceRecord): void {
    if (!isTabId(tabId)) return;
    const quote =
      typeof record?.quote === "string"
        ? record.quote.replace(/\r\n?/g, "\n").trim()
        : "";
    if (!quote) return;
    const stored: EvidenceRecord = { quote: quote.slice(0, MAX_QUOTE_CHARS) };
    const context = typeof record.context === "string" ? record.context.trim() : "";
    if (context) stored.context = context.slice(0, MAX_CONTEXT_CHARS);
    if (
      typeof record.minConfidence === "number" &&
      Number.isFinite(record.minConfidence)
    ) {
      stored.minConfidence = record.minConfidence;
    }
    this.#records.delete(tabId);
    this.#records.set(tabId, stored);
    while (this.#records.size > this.#limit) {
      const oldest = this.#records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#records.delete(oldest);
    }
  }

  peek(tabId: string): EvidenceRecord | undefined {
    const record = this.#records.get(tabId);
    return record ? { ...record } : undefined;
  }

  clear(tabId: string): boolean {
    return this.#records.delete(tabId);
  }

  clearAll(): void {
    this.#records.clear();
  }
}

/** Caches a successful evidence request; clears the tab on any other result. */
export function cacheEvidenceRequest(
  store: EvidenceRecordStore,
  tabId: unknown,
  params: unknown,
  result: unknown
): boolean {
  if (!isTabId(tabId)) return false;
  const request = (params ?? {}) as Partial<EvidenceShowParams>;
  const outcome = (result ?? {}) as Partial<EvidenceOpResult>;
  if (outcome.ok !== true) {
    store.clear(tabId);
    return false;
  }
  const quote =
    typeof request.quote === "string"
      ? request.quote.replace(/\r\n?/g, "\n").trim()
      : "";
  if (!quote) {
    store.clear(tabId);
    return false;
  }
  store.remember(tabId, {
    quote,
    ...(typeof request.context === "string" && request.context.trim()
      ? { context: request.context.trim() }
      : {}),
    ...(typeof request.minConfidence === "number" && Number.isFinite(request.minConfidence)
      ? { minConfidence: request.minConfidence }
      : {}),
  });
  return true;
}

/**
 * Selects the tab, then re-runs the fixed pipeline with the cached request.
 * Returns null when there is nothing to replay. Selection and highlight
 * failures throw a coded error so the card can show a useful message.
 */
export async function revealEvidence(
  dispatch: EvidenceRevealDispatch,
  store: EvidenceRecordStore,
  tabId: unknown,
  options: EvidenceRevealOptions = {}
): Promise<EvidenceOpResult | null> {
  if (!isTabId(tabId)) {
    throw new EvidenceRevealError(
      "invalid_tab",
      "The Show source action did not carry a valid tab id."
    );
  }

  let selection: SelectTabResult | null;
  try {
    selection = (await dispatch("tabs.select", {
      tabId,
      focusWindow: true,
    })) as SelectTabResult | null;
  } catch (error) {
    throw new EvidenceRevealError(errorCode(error, "select_failed"), errorMessage(error));
  }
  if (selection?.tab?.active !== true) {
    throw new EvidenceRevealError(
      "select_failed",
      `The tab ${tabId} did not become active, so the source was not brought forward.`
    );
  }

  const record = store.peek(tabId);
  if (!record) return null;
  const params: EvidenceShowParams = {
    tabId,
    quote: record.quote,
    ...(record.context ? { context: record.context } : {}),
    ...(typeof record.minConfidence === "number"
      ? { minConfidence: record.minConfidence }
      : {}),
    scroll: true,
    highlightMs: clampHighlightMs(options.highlightMs),
  };

  let result: EvidenceOpResult | null;
  try {
    result = (await dispatch("tabs.evidence", params)) as EvidenceOpResult | null;
  } catch (error) {
    throw new EvidenceRevealError(errorCode(error, "highlight_failed"), errorMessage(error));
  }
  if (!result || result.ok !== true) {
    throw new EvidenceRevealError(
      result?.error?.code ?? "HIGHLIGHT_FAILED",
      result?.error?.message ??
        "Zen MCP could not mark the passage again. The page may have changed."
    );
  }
  return result;
}
