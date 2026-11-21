/**
 * Top-level document identity for a tab.
 *
 * `innerWindowId` changes on every committed document, including same-origin
 * navigations, and is readable from chrome for both local and remote frames.
 * The value is opaque to callers: it is only ever compared for equality.
 *
 * During a process swap Gecko briefly exposes the new process's initial
 * `about:blank` as `currentWindowGlobal`. That placeholder is not the page and
 * is replaced moments later, so it is reported as "no identity". Otherwise a
 * document wait could resolve on a placeholder no later observation matches.
 */

interface WindowGlobalLike {
  innerWindowId?: unknown;
  isInitialDocument?: unknown;
}

interface TabWithBrowsingContext {
  linkedBrowser?: {
    browsingContext?: {
      currentWindowGlobal?: WindowGlobalLike | null;
    } | null;
  } | null;
}

export function documentIdForTab(tab: TabWithBrowsingContext | null | undefined): string {
  try {
    const global = tab?.linkedBrowser?.browsingContext?.currentWindowGlobal;
    if (!global || global.isInitialDocument === true) return "";
    const id = global.innerWindowId;
    if (typeof id !== "number" || !Number.isFinite(id)) return "";
    return `doc-${id}`;
  } catch {
    return "";
  }
}

/** True when the two identities are both known and differ. */
export function isDifferentDocument(before: string, after: string): boolean {
  return before !== "" && after !== "" && before !== after;
}
