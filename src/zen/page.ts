/**
 * Thin, policy-forwarding wrappers around the bridge's `tabs.read` method.
 *
 * All page scripting lives in the injected bridge; this module never builds or
 * executes its own scripts. It only selects a tab, clamps the read budget and
 * forwards the configured domain allowlist.
 */

import type { BridgeHub } from "../bridge/host.js";
import type { PageReadResult, ReadFormat, TabReadParams } from "../shared/protocol.js";

const MIN_CHARS = 500;
const MAX_CHARS = 60_000;
const DEFAULT_CHARS = 24_000;

export interface PageReadOptions {
  windowId?: string;
  maxChars?: number;
  /** Character offset into the text or markdown stream. */
  offset?: number;
  /** Read this tab instead of the active one, without selecting it. */
  tabId?: string;
  format?: ReadFormat;
  selector?: string;
  /** Snapshot control cap, 1-200. */
  maxElements?: number;
  /** Child-frame indexes to read instead of the top document. */
  framePath?: number[];
  /** Client cancellation for the underlying bridge request. */
  signal?: AbortSignal;
}

function clampMaxChars(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CHARS;
  return Math.max(MIN_CHARS, Math.min(MAX_CHARS, Math.trunc(value)));
}

function readParams(tabId: string, options: PageReadOptions): TabReadParams {
  return {
    tabId,
    // Snapshot reads are bounded by maxElements instead of text characters.
    maxChars: options.format === "snapshot" ? undefined : clampMaxChars(options.maxChars),
    offset: options.offset,
    format: options.format,
    selector: options.selector,
    maxElements: options.maxElements,
    framePath: options.framePath,
  };
}

/** Reads the page the user is looking at, without changing selection or focus. */
export async function readActivePage(
  hub: BridgeHub,
  options: PageReadOptions = {}
): Promise<PageReadResult> {
  const status = await hub.request("status", undefined, { windowId: options.windowId });
  const active = status.activeTab;
  if (!active?.id) throw new Error("There is no active tab to read");
  // The hub owns the allowlist and re-checks the page URL and every listed
  // frame URL; do not forward an empty list from this layer.
  return hub.readTab(readParams(active.id, options), options.windowId, {
    signal: options.signal,
  });
}

/** Reads one specific tab without selecting it. */
export async function readTabPage(
  hub: BridgeHub,
  tabId: string,
  options: PageReadOptions = {}
): Promise<PageReadResult> {
  const id = String(tabId ?? "").trim();
  if (!id) throw new Error("tabId is required");
  return hub.readTab(readParams(id, options), options.windowId, {
    signal: options.signal,
  });
}
