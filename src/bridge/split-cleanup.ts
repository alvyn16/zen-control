/**
 * Classifies tabs left behind after a split view is closed.
 *
 * Only tabs that appeared after the close can be residue: a tab that existed
 * before the call is never selected. Clearly synthetic empty tabs are safe to
 * close. A non-empty tab duplicating a split URL may have been opened by the
 * user, so it is reported rather than closed.
 */

export interface SplitTabSnapshot {
  id: string;
  url: string;
  title: string;
}

export interface SplitCleanupCandidate extends SplitTabSnapshot {
  /** Zen marks its empty placeholder tabs with `zen-empty-tab`. */
  empty?: boolean;
  /** Candidates from another window are ignored. */
  windowId?: string;
}

export interface SplitCleanupInput {
  /** Bridge tab ids that existed before the split was closed. */
  beforeTabIds: string[];
  /** URLs of the tabs that were in the split group. */
  groupUrls: string[];
  windowId?: string;
}

export interface SplitDuplicateResidue {
  tabId: string;
  title: string;
  url: string;
}

export interface SplitCleanupPlan {
  closeTabIds: string[];
  duplicates: SplitDuplicateResidue[];
  newTabIds: string[];
  limitation?: string;
}

function normalizeSplitUrl(url: string): string {
  const lowered = String(url ?? "").trim().toLowerCase();
  if (!lowered) return "";
  const withoutHash = lowered.split("#")[0] ?? "";
  return withoutHash.endsWith("/") ? withoutHash.slice(0, -1) : withoutHash;
}

/** True for Zen's empty placeholders and blank/new-tab pages. */
export function isSyntheticSplitTab(tab: SplitCleanupCandidate): boolean {
  if (tab.empty === true) return true;
  const url = String(tab.url ?? "").trim().toLowerCase().split("#")[0] ?? "";
  return url === "" || url === "about:newtab" || url === "about:blank";
}

export function planSplitCleanup(
  input: SplitCleanupInput,
  candidates: SplitCleanupCandidate[]
): SplitCleanupPlan {
  const before = new Set(input.beforeTabIds ?? []);
  const groupUrls = new Set(
    (input.groupUrls ?? []).map(normalizeSplitUrl).filter(Boolean)
  );
  const closeTabIds: string[] = [];
  const duplicates: SplitDuplicateResidue[] = [];
  const newTabIds: string[] = [];

  for (const tab of candidates ?? []) {
    if (!tab?.id) continue;
    if (
      input.windowId !== undefined &&
      tab.windowId !== undefined &&
      tab.windowId !== input.windowId
    ) {
      continue;
    }
    if (before.has(tab.id)) continue;
    newTabIds.push(tab.id);
    if (isSyntheticSplitTab(tab)) {
      closeTabIds.push(tab.id);
      continue;
    }
    const key = normalizeSplitUrl(tab.url);
    if (key && groupUrls.has(key)) {
      duplicates.push({ tabId: tab.id, title: tab.title, url: tab.url });
    }
  }

  let limitation: string | undefined;
  if (duplicates.length > 0) {
    const listed = duplicates
      .map((entry) => `"${entry.title}" (${entry.tabId})`)
      .join(", ");
    limitation =
      `Left ${duplicates.length} new tab${duplicates.length === 1 ? "" : "s"} ` +
      `open because they duplicate the split: ${listed}. Close them manually ` +
      "if they were not opened by the user.";
  }
  return {
    closeTabIds,
    duplicates,
    newTabIds,
    ...(limitation ? { limitation } : {}),
  };
}
