/**
 * Remembers where a tab lived before Zen moved it into Essentials.
 *
 * Zen's essentials manager can re-home a tab when adding or removing it. We
 * capture the original space and pinned flag first, then restore them through
 * supported browser methods and report any part we could not confirm. All
 * types here are structural so the helpers can be tested with plain objects.
 */

export const ESSENTIALS_STATE_LIMIT = 20;

export interface EssentialsTabLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  readonly pinned?: boolean;
  readonly isConnected?: boolean;
  readonly closing?: boolean;
}

export interface EssentialsTabState {
  spaceId: string | null;
  pinned: boolean;
}

export interface EssentialsCapture extends EssentialsTabState {
  tabId: string;
}

/** Insertion-ordered, bounded store; the first capture for a tab always wins. */
export class EssentialsStateStore {
  readonly limit: number;
  readonly #entries = new Map<string, EssentialsCapture>();

  constructor(limit: number = ESSENTIALS_STATE_LIMIT) {
    const parsed = Math.floor(Number(limit));
    this.limit = Number.isFinite(parsed) && parsed > 0 ? parsed : ESSENTIALS_STATE_LIMIT;
  }

  get size(): number {
    return this.#entries.size;
  }

  capture(tabId: string, state: EssentialsTabState): EssentialsCapture {
    const existing = this.#entries.get(tabId);
    if (existing) return existing;
    const captured: EssentialsCapture = {
      tabId,
      spaceId: state.spaceId,
      pinned: state.pinned,
    };
    this.#entries.set(tabId, captured);
    while (this.#entries.size > this.limit) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return captured;
  }

  get(tabId: string): EssentialsCapture | undefined {
    return this.#entries.get(tabId);
  }

  take(tabId: string): EssentialsCapture | undefined {
    const found = this.#entries.get(tabId);
    if (found) this.#entries.delete(tabId);
    return found;
  }

  clear(): void {
    this.#entries.clear();
  }
}

export function readEssentialsTabState(tab: EssentialsTabLike): EssentialsTabState {
  return { spaceId: tab.getAttribute("zen-workspace-id") || null, pinned: !!tab.pinned };
}

export function captureEssentialsState(
  store: EssentialsStateStore,
  tabId: string,
  tab: EssentialsTabLike
): EssentialsCapture {
  return store.capture(tabId, readEssentialsTabState(tab));
}

export interface EssentialsRestoreHost {
  moveTabsToWorkspace?: (tabs: EssentialsTabLike[], spaceId: string) => unknown;
  pinTab?: (tab: EssentialsTabLike) => unknown;
  unpinTab?: (tab: EssentialsTabLike) => unknown;
}

export interface EssentialsRestoreOptions {
  restorePinned?: boolean;
}

export interface EssentialsRestoreReport {
  applied: boolean;
  skipped: boolean;
  spaceRestored: boolean;
  pinnedRestored: boolean;
  reasons: string[];
}

const CLOSED_REASON = "closed before its previous state could be restored";
const SPACE_REASON = "could not be returned to its original space";
const MOVE_REASON = "had an error while moving back to its original space";
const PIN_REASON = "could not have its pinned state restored";

function isGone(tab: EssentialsTabLike): boolean {
  return tab.isConnected === false || tab.closing === true;
}

function addReasons(target: string[], reasons: string[]): void {
  for (const reason of reasons) if (!target.includes(reason)) target.push(reason);
}

/** Checks whether the tab currently holds the captured state. */
export function verifyEssentialsState(
  capture: EssentialsCapture | undefined,
  tab: EssentialsTabLike,
  options: EssentialsRestoreOptions = {}
): { spaceRestored: boolean; pinnedRestored: boolean; reasons: string[] } {
  if (!capture) return { spaceRestored: true, pinnedRestored: true, reasons: [] };
  if (isGone(tab)) {
    return { spaceRestored: false, pinnedRestored: false, reasons: [CLOSED_REASON] };
  }
  const reasons: string[] = [];
  const currentSpace = tab.getAttribute("zen-workspace-id") || null;
  const spaceRestored = capture.spaceId === null || currentSpace === capture.spaceId;
  if (!spaceRestored) reasons.push(SPACE_REASON);
  const pinnedRestored =
    options.restorePinned === false || !!tab.pinned === capture.pinned;
  if (!pinnedRestored) reasons.push(PIN_REASON);
  return { spaceRestored, pinnedRestored, reasons };
}

/**
 * Puts a captured space and (optionally) pinned flag back on one tab. Missing
 * captures mean the tab was not added by this bridge session, so it is untouched.
 */
export function restoreEssentialsState(
  capture: EssentialsCapture | undefined,
  tab: EssentialsTabLike,
  host: EssentialsRestoreHost,
  options: EssentialsRestoreOptions = {}
): EssentialsRestoreReport {
  if (!capture) {
    return {
      applied: false,
      skipped: false,
      spaceRestored: true,
      pinnedRestored: true,
      reasons: [],
    };
  }
  if (isGone(tab)) {
    return {
      applied: false,
      skipped: true,
      spaceRestored: false,
      pinnedRestored: false,
      reasons: [CLOSED_REASON],
    };
  }

  const reasons: string[] = [];
  if (capture.spaceId !== null) {
    const current = tab.getAttribute("zen-workspace-id") || null;
    if (current !== capture.spaceId) {
      tab.setAttribute("zen-workspace-id", capture.spaceId);
      if (typeof host.moveTabsToWorkspace === "function") {
        try {
          host.moveTabsToWorkspace([tab], capture.spaceId);
        } catch {
          reasons.push(MOVE_REASON);
        }
      }
    }
  }

  if (options.restorePinned !== false && !!tab.pinned !== capture.pinned) {
    const handler = capture.pinned ? host.pinTab : host.unpinTab;
    if (typeof handler === "function") {
      try {
        handler.call(host, tab);
      } catch {
        reasons.push(PIN_REASON);
      }
    } else {
      reasons.push(PIN_REASON);
    }
  }

  const verified = verifyEssentialsState(capture, tab, options);
  addReasons(reasons, verified.reasons);
  return {
    applied: true,
    skipped: false,
    spaceRestored: verified.spaceRestored,
    pinnedRestored: verified.pinnedRestored,
    reasons,
  };
}
