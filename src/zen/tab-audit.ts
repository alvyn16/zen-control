/** Pure, side-effect-free analysis of the current tab/space/folder graph. */

import type { FolderInfo, SpaceInfo, TabInfo } from "../shared/protocol.js";

export interface TabAuditOptions {
  staleDays?: number;
  duplicateLimit?: number;
  staleLimit?: number;
  now?: number;
}

export interface TabAuditDuplicate {
  url: string;
  title: string;
  tabIds: string[];
  spaces: string[];
}

export interface TabAuditStale {
  tabId: string;
  title: string;
  url: string;
  spaceName: string | null;
  lastAccessed: number | null;
  ageDays: number | null;
}

export interface TabAuditDomain {
  domain: string;
  count: number;
  tabIds: string[];
}

export interface TabAuditSpace {
  spaceId: string | null;
  spaceName: string;
  tabs: number;
  pinned: number;
  folders: number;
  stale: number;
}

export interface TabAuditTotals {
  tabs: number;
  spaces: number;
  folders: number;
  pinned: number;
  essentials: number;
  grouped: number;
  loading: number;
  duplicates: number;
  stale: number;
}

export interface TabAuditResult {
  duplicates: TabAuditDuplicate[];
  stale: TabAuditStale[];
  domains: TabAuditDomain[];
  bySpace: TabAuditSpace[];
  totals: TabAuditTotals;
}

export interface DomainFolderPlan {
  label: string;
  tabIds: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_DAYS = 14;
const DEFAULT_DUPLICATE_LIMIT = 20;
const DEFAULT_STALE_LIMIT = 30;
const MAX_DOMAIN_GROUPS = 30;

function internalUrl(url: string): boolean {
  const trimmed = String(url ?? "").trim().toLowerCase();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("about:") ||
    trimmed.startsWith("chrome:")
  );
}

/** Lowercase URL without its fragment or a single trailing slash. */
function normalizeUrl(url: string): string | null {
  if (internalUrl(url)) return null;
  const lowered = String(url).trim().toLowerCase();
  const withoutHash = lowered.split("#")[0] ?? "";
  const withoutSlash = withoutHash.endsWith("/")
    ? withoutHash.slice(0, -1)
    : withoutHash;
  return withoutSlash.length > 0 ? withoutSlash : null;
}

function hostOf(url: string): string | null {
  if (internalUrl(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  return host.length > 0 ? host : null;
}

function spaceLabel(tab: TabInfo): string {
  return tab.spaceName ?? tab.spaceId ?? "No space";
}

export function auditTabs(
  tabs: TabInfo[],
  spaces: SpaceInfo[],
  folders: FolderInfo[],
  opts: TabAuditOptions = {}
): TabAuditResult {
  const allTabs = Array.isArray(tabs) ? tabs : [];
  const allSpaces = Array.isArray(spaces) ? spaces : [];
  const allFolders = Array.isArray(folders) ? folders : [];
  const now = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  const staleDays =
    typeof opts.staleDays === "number" && Number.isFinite(opts.staleDays)
      ? Math.max(0, opts.staleDays)
      : DEFAULT_STALE_DAYS;
  const duplicateLimit =
    typeof opts.duplicateLimit === "number" && Number.isFinite(opts.duplicateLimit)
      ? Math.max(0, Math.floor(opts.duplicateLimit))
      : DEFAULT_DUPLICATE_LIMIT;
  const staleLimit =
    typeof opts.staleLimit === "number" && Number.isFinite(opts.staleLimit)
      ? Math.max(0, Math.floor(opts.staleLimit))
      : DEFAULT_STALE_LIMIT;

  // Duplicate detection ---------------------------------------------------
  const groups = new Map<string, { title: string; tabIds: string[]; spaces: string[] }>();
  for (const tab of allTabs) {
    const key = normalizeUrl(tab.url);
    if (!key) continue;
    const group = groups.get(key);
    const label = spaceLabel(tab);
    if (group) {
      group.tabIds.push(tab.id);
      if (!group.spaces.includes(label)) group.spaces.push(label);
    } else {
      groups.set(key, { title: tab.title, tabIds: [tab.id], spaces: [label] });
    }
  }
  const allDuplicates: TabAuditDuplicate[] = [];
  for (const [url, group] of groups) {
    if (group.tabIds.length < 2) continue;
    allDuplicates.push({ url, ...group });
  }
  allDuplicates.sort(
    (a, b) => b.tabIds.length - a.tabIds.length || a.url.localeCompare(b.url)
  );
  const duplicates = allDuplicates.slice(0, duplicateLimit);

  // Stale detection -------------------------------------------------------
  const threshold = staleDays * DAY_MS;
  const allStale: TabAuditStale[] = [];
  for (const tab of allTabs) {
    const last = tab.lastAccessed;
    if (typeof last !== "number" || !Number.isFinite(last)) continue;
    const age = now - last;
    if (!Number.isFinite(age) || age <= threshold) continue;
    allStale.push({
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      spaceName: tab.spaceName,
      lastAccessed: last,
      ageDays: Math.floor(age / DAY_MS),
    });
  }
  allStale.sort((a, b) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0));
  const stale = allStale.slice(0, staleLimit);

  // Domain grouping -------------------------------------------------------
  const domainsByHost = new Map<string, string[]>();
  for (const tab of allTabs) {
    const domain = hostOf(tab.url);
    if (!domain) continue;
    const ids = domainsByHost.get(domain);
    if (ids) ids.push(tab.id);
    else domainsByHost.set(domain, [tab.id]);
  }
  const domains: TabAuditDomain[] = [];
  for (const [domain, tabIds] of domainsByHost) {
    domains.push({ domain, count: tabIds.length, tabIds });
  }
  domains.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));

  // Per-space rollups -----------------------------------------------------
  const bySpace: TabAuditSpace[] = allSpaces.map((space) => {
    const spaceTabs = allTabs.filter((tab) => tab.spaceId === space.id);
    const ids = new Set(spaceTabs.map((tab) => tab.id));
    return {
      spaceId: space.id,
      spaceName: space.name,
      tabs: spaceTabs.length,
      pinned: spaceTabs.filter((tab) => tab.pinned).length,
      folders: allFolders.filter((folder) => folder.spaceId === space.id).length,
      stale: allStale.filter((entry) => ids.has(entry.tabId)).length,
    };
  });
  const loose = allTabs.filter((tab) => tab.spaceId === null);
  if (loose.length > 0) {
    const ids = new Set(loose.map((tab) => tab.id));
    bySpace.push({
      spaceId: null,
      spaceName: "No space",
      tabs: loose.length,
      pinned: loose.filter((tab) => tab.pinned).length,
      folders: 0,
      stale: allStale.filter((entry) => ids.has(entry.tabId)).length,
    });
  }

  return {
    duplicates,
    stale,
    domains: domains.slice(0, MAX_DOMAIN_GROUPS),
    bySpace,
    totals: {
      tabs: allTabs.length,
      spaces: allSpaces.length,
      folders: allFolders.length,
      pinned: allTabs.filter((tab) => tab.pinned).length,
      essentials: allTabs.filter((tab) => tab.essential).length,
      grouped: allTabs.filter((tab) => tab.folderId !== null).length,
      loading: allTabs.filter((tab) => tab.loading).length,
      duplicates: allDuplicates.length,
      stale: allStale.length,
    },
  };
}

/**
 * Plans one folder per domain for loose, ungrouped, non-pinned http(s) tabs.
 */
export function planDomainFolders(
  tabs: TabInfo[],
  opts: { spaceId?: string; minTabs?: number } = {}
): DomainFolderPlan[] {
  const minTabs =
    typeof opts.minTabs === "number" && Number.isFinite(opts.minTabs)
      ? Math.max(1, Math.floor(opts.minTabs))
      : 2;
  const scopeProvided = opts.spaceId !== undefined;
  const groups = new Map<string, string[]>();

  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (tab.folderId !== null || tab.pinned || tab.essential) continue;
    if (scopeProvided && tab.spaceId !== opts.spaceId) continue;
    const domain = hostOf(tab.url);
    if (!domain) continue;
    const ids = groups.get(domain);
    if (ids) {
      if (!ids.includes(tab.id)) ids.push(tab.id);
    } else {
      groups.set(domain, [tab.id]);
    }
  }

  const plans: DomainFolderPlan[] = [];
  for (const [domain, tabIds] of groups) {
    if (tabIds.length < minTabs) continue;
    plans.push({ label: domain, tabIds });
  }
  plans.sort(
    (a, b) => b.tabIds.length - a.tabIds.length || a.label.localeCompare(b.label)
  );
  return plans;
}
