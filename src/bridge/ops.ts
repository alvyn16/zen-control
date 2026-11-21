/**
 * Fixed bridge method map executed in Zen's browser chrome.
 *
 * The socket only exposes these named methods. There is no tool that evaluates
 * agent-supplied JavaScript: every DOM script is assembled here from the
 * shared, fixed generators, with agent values inserted only as JSON data.
 * Reads and actions go through the tab's MarionetteCommands content actor so
 * background and other-space tabs work without changing focus or selection.
 */
import type {
  BridgeStatus,
  PageReadResult,
  PageFrame,
  TabInfo,
  SpaceInfo,
  Space,
  FolderInfo,
  ContainerInfo,
  EvidenceErrorCode,
  EvidenceOpResult,
  EvidenceClearResult,
  TextSearchResult,
  ClickElementResult,
  TypeTextResult,
  WaitForResult,
  PageActionTargetInfo,
  PageActionEffect,
  WaitCondition,
  WaitElementState,
  UiOption,
} from "../shared/protocol.js";
import { isUrlAllowed, normalizeWebUrl } from "../shared/url-policy.js";

/* Shared generators and coercers. Their exact signatures are adapted locally so
 * this browser-only module does not depend on type drift in shared files. */
import { buildReadScript as _buildReadScript } from "../shared/read-script.js";
import { buildSemanticTargetScript as _buildSemanticTargetScript } from "../shared/read-script.js";
import { buildInspectElementScript as _buildInspectElementScript } from "../shared/read-script.js";
import { buildWaitProbeScript as _buildWaitProbeScript } from "../shared/read-script.js";
import { buildVerifyTypedValueScript as _buildVerifyTypedValueScript } from "../shared/read-script.js";
import { buildPageSignatureScript as _buildPageSignatureScript } from "../shared/read-script.js";
import { coercePageSnapshot as _coercePageSnapshot } from "../shared/read-script.js";
import { coerceSemanticTarget as _coerceSemanticTarget } from "../shared/read-script.js";
import { coerceWaitProbe as _coerceWaitProbe } from "../shared/read-script.js";
import { coerceTypedValueProbe as _coerceTypedValueProbe } from "../shared/read-script.js";
import { coercePageSignature as _coercePageSignature } from "../shared/read-script.js";
import { toPageReadResult as _toPageReadResult } from "../shared/read-script.js";
import { buildEvidenceStateScript as _buildEvidenceStateScript } from "../shared/evidence-script.js";
import { buildEvidenceIndexScript as _buildEvidenceIndexScript } from "../shared/evidence-script.js";
import { buildEvidenceHighlightScript as _buildEvidenceHighlightScript } from "../shared/evidence-script.js";
import { buildEvidenceClearScript as _buildEvidenceClearScript } from "../shared/evidence-script.js";
import { coerceEvidenceState as _coerceEvidenceState } from "../shared/evidence-script.js";
import { coerceEvidenceIndex as _coerceEvidenceIndex } from "../shared/evidence-script.js";
import { coerceEvidenceHighlight as _coerceEvidenceHighlight } from "../shared/evidence-script.js";
import { coerceEvidenceClear as _coerceEvidenceClear } from "../shared/evidence-script.js";
import { findEvidenceQuote as _findEvidenceQuote } from "../shared/evidence.js";
import { findLiteralMatches as _findLiteralMatches } from "../shared/search.js";
import { clampSnapshotElements as _clampSnapshotElements } from "../shared/snapshot.js";
import { normalizeTargetInput as _normalizeTargetInput } from "../shared/target.js";
import { comparePageSignatures as _comparePageSignatures } from "../shared/delta.js";
import { buildPageDelta as _buildPageDelta } from "../shared/delta.js";
import { normalizeFramePath as _normalizeFramePath } from "../shared/frame-path.js";
import { frameRefPrefix as _frameRefPrefix } from "../shared/frame-path.js";
import { parseFrameRef as _parseFrameRef } from "../shared/frame-path.js";
import { isSensitiveDescriptor as _isSensitiveDescriptor } from "../shared/sensitive.js";
import { activateTab, type TabActivationOutcome } from "./tab-activation.js";
import {
  RefRegistry,
  documentChanged,
  elementDigest,
  type RefDescriptor,
  type ResolvedRef,
} from "./ref-registry.js";
import {
  EssentialsStateStore,
  captureEssentialsState,
  restoreEssentialsState,
  verifyEssentialsState,
  type EssentialsCapture,
  type EssentialsRestoreHost,
} from "./essentials-state.js";
import { planSplitCleanup } from "./split-cleanup.js";
import { documentIdForTab } from "./tab-identity.js";

/* ------------------------------------------------------------------ *
 * Local adapters
 * ------------------------------------------------------------------ */
type AnyFn = (...args: any[]) => any;
const readScript = _buildReadScript as AnyFn;
const semanticTargetScript = _buildSemanticTargetScript as AnyFn;
const inspectElementScript = _buildInspectElementScript as AnyFn;
const waitProbeScript = _buildWaitProbeScript as AnyFn;
const verifyTypedValueScript = _buildVerifyTypedValueScript as AnyFn;
const pageSignatureScript = _buildPageSignatureScript as AnyFn;
const coercePageSnapshot = _coercePageSnapshot as AnyFn;
const coerceSemanticTarget = _coerceSemanticTarget as AnyFn;
const coerceWaitProbe = _coerceWaitProbe as AnyFn;
const coerceTypedValueProbe = _coerceTypedValueProbe as AnyFn;
const coercePageSignature = _coercePageSignature as AnyFn;
const toPageReadResult = _toPageReadResult as AnyFn;
const evidenceStateScript = _buildEvidenceStateScript as AnyFn;
const evidenceIndexScript = _buildEvidenceIndexScript as AnyFn;
const evidenceHighlightScript = _buildEvidenceHighlightScript as AnyFn;
const evidenceClearScript = _buildEvidenceClearScript as AnyFn;
const coerceEvidenceState = _coerceEvidenceState as AnyFn;
const coerceEvidenceIndex = _coerceEvidenceIndex as AnyFn;
const coerceEvidenceHighlight = _coerceEvidenceHighlight as AnyFn;
const coerceEvidenceClear = _coerceEvidenceClear as AnyFn;
const findEvidenceQuote = _findEvidenceQuote as AnyFn;
const findLiteralMatches = _findLiteralMatches as AnyFn;
const clampSnapshotElements = _clampSnapshotElements as AnyFn;
const normalizeTargetInput = _normalizeTargetInput as AnyFn;
const comparePageSignatures = _comparePageSignatures as AnyFn;
const buildPageDelta = _buildPageDelta as AnyFn;
const normalizeFramePath = _normalizeFramePath as (value: unknown) => number[] | null;
const frameRefPrefix = _frameRefPrefix as (path: number[]) => string;
const parseFrameRef = _parseFrameRef as (value: string) => { path: number[]; ref: string } | null;
const isSensitiveDescriptor = _isSensitiveDescriptor as AnyFn;

/* ------------------------------------------------------------------ *
 * Local structural types for coerce results
 * ------------------------------------------------------------------ */
interface ElementLike {
  ref?: string;
  tag?: string;
  role?: string;
  type?: string | null;
  label?: string;
  href?: string | null;
  value?: string | null;
  sensitive?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  editable?: boolean;
  checked?: boolean | null;
  selected?: boolean | null;
  placeholder?: string | null;
  visible?: boolean;
  element?: unknown;
  framePath?: number[];
  frameUrl?: string | null;
}
interface SnapshotLike {
  title: string;
  url: string;
  selectedText: string;
  text: string;
  fullLength: number;
  offset: number;
  readyState: string;
  description: string | null;
  format: string;
  selector: string | null;
  selectorMatched: boolean;
  contentType: string;
  elements?: ElementLike[];
  elementsTruncated?: boolean;
  elementsTotal?: number;
  framesComplete?: boolean;
  snapshotComplete?: boolean;
  semanticAnchors?: ElementLike[];
  limitations?: string[];
  semantic?: any;
  root?: unknown;
}
interface TargetProbe extends ElementLike {
  found?: boolean;
  element?: unknown;
  root?: unknown;
  ambiguous?: boolean;
  candidates?: Array<{ label?: string }>;
  count?: number;
  truncated?: boolean;
  invalidSelector?: boolean;
}
interface NormalizedTarget {
  kind: "ref" | "selector" | "role" | "text" | "label" | "placeholder";
  value?: string;
  role?: string;
  name?: string;
  match?: "exact" | "contains";
  maxCandidates?: number;
  /** Older target normalizers exposed a legacy flag; absent means modern. */
  legacy?: boolean;
}
interface FrameInfo {
  actor: any;
  path: number[];
  url: string;
  name: string;
}
interface EvidenceIndexLike {
  text: string;
  url: string;
  title: string;
  readyState: string;
  contentType?: string;
  truncated?: boolean;
}
interface EvidenceStateLike {
  url: string;
  title: string;
  readyState: string;
  contentType?: string;
}
interface ReadOutcomeLike {
  result: PageReadResult;
  snapshotId: string;
  refs: Array<{
    ref: string; tag: string; role: string; label: string; type: string | null;
    href: string | null; sensitive: boolean; element?: unknown; digest?: string;
  }>;
  root: unknown;
}
interface HighlightLike {
  ok: boolean;
  stale: boolean;
  highlighted: boolean;
  scrolled: boolean;
  inView: boolean;
  rects: number;
  scrollY: number;
  reason?: string;
}

/* ------------------------------------------------------------------ *
 * Constants and small helpers
 * ------------------------------------------------------------------ */
const MAX_TABS_PER_OPEN = 30;
const MAX_FRAMES = 20;
const MAX_FRAME_SCANS = 10;
const MAX_FRAME_DEPTH_LOCAL = 3;
const MAX_PAGE_ELEMENTS = 200;
const SNAPSHOT_TEXT_CHARS = 4_000;
const ACTION_SETTLE_MS = 1_200;
const ACTION_PROBE_INTERVAL_MS = 120;
const ACTION_PROBE_TIMEOUT_MS = 2_500;
const SIGNATURE_BEFORE_TIMEOUT_MS = 1_500;
const PDF_WAIT_MS = 8_000;
const EVIDENCE_WAIT_MS = 12_000;
const EVIDENCE_POLL_MS = 250;
const EVIDENCE_SETTLE_MS = 200;
const EVIDENCE_MAX_TEXT = 600_000;
const EVIDENCE_HIGHLIGHT_MS = 20_000;
const EVIDENCE_MAX_ATTEMPTS = 3;
const WAIT_DEFAULT_TIMEOUT_MS = 5_000;
const WAIT_MAX_TIMEOUT_MS = 30_000;
const GLANCE_SETTLE_MS = 10_000;
const LAYOUT_SETTLE_MS = 120;
const SPLIT_CLOSE_TIMEOUT_MS = 1_000;
const MAX_CLIPBOARD_CHARS = 1_048_576;
const MAX_RESULTS = 100;
const HISTORY_SCAN_LIMIT = 200;

class OpsError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "OpsError";
    this.code = code;
    this.details = details;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isPrivilegedUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return ["about:", "chrome:", "resource:", "view-source:", "moz-extension:", "javascript:"].includes(protocol);
  } catch {
    return true;
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function toIso(micros: unknown): string | null {
  const parsed = Number(micros);
  if (!parsed) return null;
  try {
    return new Date(parsed / 1000).toISOString();
  } catch {
    return null;
  }
}

function describeTarget(target: NormalizedTarget): string {
  switch (target.kind) {
    case "selector": return `selector "${target.value}"`;
    case "role": return "role+name";
    case "text": return "text";
    case "label": return "label";
    case "placeholder": return "placeholder";
    default: return "ref";
  }
}

function diffHasChanges(diff: any): boolean {
  if (!diff) return false;
  return ["changed", "urlChanged", "titleChanged", "domChanged", "valueChanged"].some(
    (key) => diff[key] === true
  );
}

function deltaHasChanges(delta: any): boolean {
  if (!delta) return false;
  return (
    (Array.isArray(delta.addedControls) && delta.addedControls.length > 0) ||
    (Array.isArray(delta.removedControls) && delta.removedControls.length > 0) ||
    (Array.isArray(delta.changedControls) && delta.changedControls.length > 0) ||
    (Array.isArray(delta.addedHeadings) && delta.addedHeadings.length > 0) ||
    (Array.isArray(delta.removedHeadings) && delta.removedHeadings.length > 0) ||
    (Array.isArray(delta.addedAlerts) && delta.addedAlerts.length > 0) ||
    (Array.isArray(delta.removedAlerts) && delta.removedAlerts.length > 0) ||
    delta.textChanged === true
  );
}

/** Distinct random attribute name for an evidence overlay. */
function createMarker(): string {
  let hex = "";
  try {
    hex = crypto.randomUUID().replace(/-/g, "");
  } catch {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `data-zen-${hex}`;
}

/* ------------------------------------------------------------------ *
 * Ops factory
 * ------------------------------------------------------------------ */
export interface OpsApi {
  dispatch(method: string, params?: unknown): Promise<unknown>;
  tabIdFor(tab: unknown): string;
  noteDialogShown(): void;
  tabIds(): string[];
}

export function createOps(win: any, windowId: string): OpsApi {
  const tabIds = new WeakMap<any, string>();
  const tabsById = new Map<string, any>();
  const closedTabIds = new Set<string>();
  const refRegistry = new RefRegistry({ maxRefs: 400 });
  const markers = new Map<string, string[]>();
  const essentialsCaptures = new EssentialsStateStore();
  const tabLocks = new Map<string, Promise<unknown>>();

  let dialogSeq = 0;
  const dialogWaiters = new Set<() => void>();
  const noteDialogShown = (): void => {
    dialogSeq += 1;
    for (const waiter of [...dialogWaiters]) {
      try { waiter(); } catch { /* Wake-up only. */ }
    }
    dialogWaiters.clear();
  };

  const idForTab = (tab: any): string => {
    if (!tab) return "";
    let id = tabIds.get(tab);
    if (!id) {
      id = `tab-${Math.random().toString(36).slice(2, 10)}`;
      tabIds.set(tab, id);
      tabsById.set(id, tab);
    }
    return id;
  };

  const pruneTabIds = (): void => {
    for (const [id, tab] of tabsById) {
      if (!tab.isConnected || tab.closing) {
        tabsById.delete(id);
        closedTabIds.add(id);
      }
    }
    while (closedTabIds.size > 256) {
      const first = closedTabIds.values().next().value;
      if (first === undefined) break;
      closedTabIds.delete(first);
    }
  };

  const serializeTab = <T>(tabId: string, work: () => Promise<T>): Promise<T> => {
    const previous = tabLocks.get(tabId) ?? Promise.resolve();
    const run = previous.then(work, work);
    tabLocks.set(tabId, run);
    const release = (): void => {
      if (tabLocks.get(tabId) === run) tabLocks.delete(tabId);
    };
    void run.then(release, release);
    return run;
  };

  const markersFor = (tabId: string): string[] => markers.get(tabId) ?? [];
  const rememberMarkers = (tabId: string, list: string[]): void => {
    if (list.length) markers.set(tabId, list.slice(-20));
    else markers.delete(tabId);
  };

  const workspaces = (): any => {
    const manager = win.gZenWorkspaces;
    if (!manager) throw new OpsError("zen_not_ready", "Zen workspaces are not available yet");
    return manager;
  };
  const spacesEnabled = (): boolean => {
    try { return !!win.gZenWorkspaces?.shouldHaveWorkspaces; } catch { return false; }
  };
  const assertSpacesEnabled = (): void => {
    if (!spacesEnabled()) {
      throw new OpsError("spaces_unavailable", "Spaces are disabled in this Zen window.");
    }
  };
  const listSpaces = (): any[] => (spacesEnabled() ? workspaces().getWorkspaces() : []);
  const findSpace = (target: string | undefined): any => {
    if (!target) return win.gZenWorkspaces?.getActiveWorkspaceFromCache?.() ?? null;
    const needle = target.trim().toLowerCase();
    if (!needle) return null;
    return listSpaces().find(
      (space: any) => space.uuid === target || String(space.name ?? "").toLowerCase() === needle
    ) ?? null;
  };
  const requireSpace = (target: string, action: string): any => {
    const space = findSpace(target);
    if (!space) {
      const names = listSpaces().map((s: any) => s.name).filter(Boolean).slice(0, 12);
      throw new OpsError(
        "space_not_found",
        `Could not ${action}: no space matches "${target}". Known spaces: ${names.length ? names.join(", ") : "(none)"}.`
      );
    }
    return space;
  };
  const spaceName = (spaceId: string | null): string | null => {
    if (!spaceId) return null;
    return listSpaces().find((s: any) => s.uuid === spaceId)?.name ?? null;
  };

  const collectTabs = (): any[] => {
    pruneTabIds();
    const seen = new Set<any>();
    const tabs: any[] = [];
    const add = (tab: any): void => {
      if (!tab || seen.has(tab) || tab.closing) return;
      seen.add(tab);
      tabs.push(tab);
    };
    for (const tab of win.document.querySelectorAll("tab.tabbrowser-tab")) add(tab);
    try {
      for (const tab of win.gZenWorkspaces?.allStoredTabs ?? []) add(tab);
    } catch { /* Workspaces may still be initializing. */ }
    for (const tab of win.gBrowser?.tabs ?? []) add(tab);
    return tabs;
  };
  const realTabs = (): any[] =>
    collectTabs().filter((tab: any) => !tab.hasAttribute("zen-empty-tab"));

  const tabUrl = (tab: any): string => {
    try {
      return tab.linkedBrowser?.currentURI?.spec ?? tab.getAttribute("zen-url") ?? "";
    } catch {
      return "";
    }
  };
  const tabTitle = (tab: any): string => {
    const label = tab?.label || tab?.linkedBrowser?.contentTitle;
    return String(label || tabUrl(tab) || "(untitled tab)");
  };
  const containerIdOf = (tab: any): number =>
    Number(tab.userContextId ?? tab.getAttribute("usercontextid") ?? 0) || 0;
  const isEssential = (tab: any): boolean =>
    tab.hasAttribute("zen-essential") || tab.getAttribute("zen-essential") === "true";
  const folderOf = (tab: any): any => {
    const group = tab?.group;
    if (!group) return null;
    return group.isZenFolder || String(group.tagName ?? "").toLowerCase() === "zen-folder" ? group : null;
  };
  const collectFolders = (): any[] =>
    Array.from(win.document.querySelectorAll("zen-folder")).filter((f: any) => !f.closing) as any[];

  const tabInfo = (tab: any, index: number): TabInfo => {
    const spaceId: string | null = tab.getAttribute("zen-workspace-id") || null;
    const folder = folderOf(tab);
    return {
      id: idForTab(tab),
      windowId,
      spaceId,
      spaceName: spaceName(spaceId),
      title: tabTitle(tab),
      url: tabUrl(tab),
      requestedUrl: tabUrl(tab),
      pinned: !!tab.pinned,
      essential: isEssential(tab),
      active: !!tab.selected,
      audible: tab.hasAttribute("soundplaying"),
      muted: !!tab.muted || tab.hasAttribute("muted"),
      loading: tab.hasAttribute("busy"),
      folderId: folder?.id ?? null,
      folderLabel: folder?.label ?? null,
      index,
      lastAccessed: Number(tab.lastAccessed) || null,
      containerId: containerIdOf(tab),
      splitView: !!tab.splitView,
    };
  };
  const allSpaceInfo = (): SpaceInfo[] => {
    const tabs = realTabs();
    const folders = collectFolders();
    return listSpaces().map((space: any, index: number) => {
      const spaceTabs = tabs.filter((tab: any) => tab.getAttribute("zen-workspace-id") === space.uuid);
      return {
        id: space.uuid,
        name: space.name,
        icon: space.icon ?? null,
        active: space.uuid === win.gZenWorkspaces.activeWorkspace,
        index,
        containerTabId: space.containerTabId ?? 0,
        tabCount: spaceTabs.length,
        pinnedCount: spaceTabs.filter((tab: any) => tab.pinned).length,
        folderCount: folders.filter((f: any) => f.getAttribute("zen-workspace-id") === space.uuid).length,
      };
    });
  };
  const spaceInfoFor = (space: any): Space => ({
    id: space.uuid,
    name: space.name,
    icon: space.icon ?? null,
    active: space.uuid === win.gZenWorkspaces?.activeWorkspace,
    index: Math.max(0, listSpaces().findIndex((s: any) => s.uuid === space.uuid)),
    containerTabId: space.containerTabId ?? 0,
  });
  const folderInfo = (folder: any): FolderInfo => ({
    id: folder.id,
    label: folder.label ?? "",
    spaceId: folder.getAttribute("zen-workspace-id") ?? "",
    collapsed: !!folder.collapsed,
    parentId: folder.parentElement?.closest("zen-folder")?.id ?? null,
    tabIds: (folder.tabs ?? [])
      .filter((tab: any) => !tab.hasAttribute("zen-empty-tab") && !tab.closing)
      .map((tab: any) => idForTab(tab)),
    liveFolder: !!folder.isLiveFolder,
  });

  const resolveTabs = (ids: string[]): any[] => {
    const tabs: any[] = [];
    for (const id of ids) {
      const tab = tabsById.get(id);
      if (!tab || !tab.isConnected || tab.closing) {
        throw new OpsError(
          "tab_not_found",
          `No open tab matches id "${id}". Tab ids are stable only while the tab is open; call tabs.list again.`
        );
      }
      tabs.push(tab);
    }
    return tabs;
  };

  const normalizeUrl = (input: string): string => {
    const trimmed = String(input ?? "").trim();
    if (!trimmed) throw new OpsError("invalid_url", "Empty URL");
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new OpsError("invalid_url", `Not a valid URL: ${input}`);
    }
    if (!["http:", "https:", "about:"].includes(parsed.protocol)) {
      throw new OpsError("invalid_url", `Refusing to open ${parsed.protocol} URLs.`);
    }
    return parsed.href;
  };

  /* ---------------- containers ---------------- */
  const contextualIdentityService = (): any => {
    try { if (win.ContextualIdentityService) return win.ContextualIdentityService; } catch { /* next */ }
    try { if (typeof ContextualIdentityService !== "undefined") return ContextualIdentityService; } catch { /* next */ }
    return null;
  };
  const containerIdentities = (): ContainerInfo[] => {
    const service = contextualIdentityService();
    if (!service || typeof service.getPublicIdentities !== "function") return [];
    try {
      const identities = service.getPublicIdentities() ?? [];
      if (!Array.isArray(identities)) return [];
      return identities.map((identity: any) => {
        const userContextId = Number(identity?.userContextId ?? 0) || 0;
        return {
          userContextId,
          name: String(identity?.name ?? ""),
          icon: String(identity?.icon ?? ""),
          color: String(identity?.color ?? ""),
          public: userContextId > 0 && identity?.public !== false,
        };
      });
    } catch {
      return [];
    }
  };
  const resolveContainer = (target: unknown): ContainerInfo => {
    const identities = containerIdentities();
    const names = identities.filter((i) => i.userContextId > 0).map((i) => i.name || `#${i.userContextId}`);
    const known = names.length ? names.join(", ") : "(none)";
    if (!identities.length) {
      throw new OpsError("container_not_found", `Firefox containers are not available in this window. Known containers: ${known}.`);
    }
    const raw = String(target ?? "").trim();
    let match: ContainerInfo | undefined;
    if (/^\d+$/.test(raw)) {
      const id = Number(raw);
      match = identities.find((i) => i.userContextId === id);
    }
    if (!match && raw) match = identities.find((i) => i.name.toLowerCase() === raw.toLowerCase());
    if (!match) throw new OpsError("container_not_found", `No container matches "${raw}". Known containers: ${known}.`);
    return match;
  };

  /* ---------------- content actor / frames ---------------- */
  const contentActor = (context: any): any => {
    const global = context?.currentWindowGlobal;
    if (!global) throw new OpsError("tab_not_loaded", "The page has no loaded window global yet.");
    const actor = typeof global.getActor === "function" ? global.getActor("MarionetteCommands") : null;
    if (!actor) {
      throw new OpsError(
        "actor_unavailable",
        "This Zen window does not expose background page access. Restart Zen through the MCP harness."
      );
    }
    return actor;
  };
  const pageActor = (tab: any): any => {
    const context = tab?.linkedBrowser?.browsingContext;
    if (!context) throw new OpsError("tab_not_loaded", `The tab "${tabTitle(tab)}" has no loaded page yet.`);
    return contentActor(context);
  };
  const childContexts = (context: any): any[] => {
    try { return Array.from(context?.children ?? []); } catch { return []; }
  };
  const frameUrlOf = (context: any): string => {
    try {
      const spec = context?.currentWindowGlobal?.documentURI?.spec;
      return typeof spec === "string" ? spec : "";
    } catch { return ""; }
  };
  const frameNameOf = (context: any): string => {
    try { return String(context?.name ?? ""); } catch { return ""; }
  };
  const requireFramePath = (raw: unknown): number[] => {
    const path = normalizeFramePath(raw);
    if (!path) {
      throw new OpsError(
        "invalid_frame",
        `framePath must be an array of at most ${MAX_FRAME_DEPTH_LOCAL} non-negative child frame indexes.`
      );
    }
    return path;
  };
  const assertActionUrlAllowed = (url: string, domains: string[] | undefined, action: string): void => {
    if (!url || !domains?.length) return;
    if (isUrlAllowed(url, domains)) return;
    throw new OpsError("domain_not_allowed", `Blocked by domain allowlist: ${action} ${url}.`);
  };
  const resolveFrame = (tab: any, path: number[], domains: string[] | undefined): FrameInfo => {
    let context = tab?.linkedBrowser?.browsingContext;
    if (!context) throw new OpsError("tab_not_loaded", `The tab "${tabTitle(tab)}" has no loaded page yet.`);
    for (const index of path) {
      const children = childContexts(context);
      if (index >= children.length) {
        throw new OpsError("frame_not_found", `Frame path [${path.join(", ")}] does not exist.`);
      }
      context = children[index];
    }
    const url = frameUrlOf(context);
    if (!url) throw new OpsError("frame_not_loaded", `The frame at [${path.join(", ")}] has not loaded.`);
    if (!isHttpUrl(url)) {
      throw new OpsError(
        "unsupported_frame",
        `Only http(s) frames can be read${isPrivilegedUrl(url) ? "; this frame is browser-internal" : ""}.`
      );
    }
    assertActionUrlAllowed(url, domains, "reading frame");
    return { actor: contentActor(context), path: [...path], url, name: frameNameOf(context) };
  };
  const currentFrameUrl = (tab: any, path: number[]): string | null => {
    let context = tab?.linkedBrowser?.browsingContext;
    for (const index of path) {
      if (!context) return null;
      context = childContexts(context)[index];
    }
    return frameUrlOf(context) || null;
  };
  const listFrames = (tab: any, domains: string[] | undefined): { frames: PageFrame[]; skipped: number; truncated: boolean } => {
    const frames: PageFrame[] = [];
    let skipped = 0;
    let truncated = false;
    const walk = (context: any, prefix: number[]): void => {
      for (const [index, child] of childContexts(context).entries()) {
        if (frames.length >= MAX_FRAMES) {
          truncated = true;
          return;
        }
        const path = [...prefix, index];
        const url = frameUrlOf(child);
        const visible = isHttpUrl(url) && (!domains?.length || isUrlAllowed(url, domains));
        if (!visible) {
          skipped += 1;
          continue;
        }
        frames.push({ path, url, name: frameNameOf(child) });
        if (path.length < MAX_FRAME_DEPTH_LOCAL) walk(child, path);
      }
    };
    const root = tab?.linkedBrowser?.browsingContext;
    if (root) walk(root, []);
    return { frames, skipped, truncated };
  };

  const execute = (actor: any, script: string, args: unknown[] = [], timeoutMs = 15_000): Promise<unknown> =>
    actor.sendQuery("MarionetteCommandsParent:executeScript", {
      script,
      args,
      opts: { timeout: timeoutMs },
    });

  const contentTypeOf = (tab: any): string | null => {
    try {
      const value = tab?.linkedBrowser?.contentDocument?.contentType;
      return value ? String(value) : null;
    } catch { return null; }
  };
  const isPdfTab = (tab: any): boolean => {
    const type = contentTypeOf(tab);
    if (type && type.toLowerCase().includes("pdf")) return true;
    return tabUrl(tab).split("#")[0].split("?")[0].toLowerCase().endsWith(".pdf");
  };

  const requireActionTab = (tabId: string, action: string): any => {
    if (!tabId) throw new OpsError("no_tab", `Provide the tabId to ${action}.`);
    const [tab] = resolveTabs([tabId]);
    const url = tabUrl(tab);
    if (!isHttpUrl(url)) {
      throw new OpsError(
        isPrivilegedUrl(url) ? "privileged_page" : "unsupported_page",
        "Only http(s) pages can be read or driven. Browser-internal and local-file pages are never touched."
      );
    }
    if (isPdfTab(tab)) throw new OpsError("unsupported_page", "The PDF viewer cannot be driven. Open the page as HTML.");
    return tab;
  };

  /* ---------------- target resolution ---------------- */
  const resolvePageTarget = async (
    tab: any,
    params: any,
    domains: string[] | undefined
  ): Promise<{ target: TargetProbe; actor: any; framePath: number[]; frameUrl: string | null; legacy: boolean; kind: NormalizedTarget["kind"] }> => {
    let normalized: NormalizedTarget;
    try {
      normalized = normalizeTargetInput(params ?? {}) as NormalizedTarget;
    } catch (error) {
      const err = error as Error & { code?: string; details?: Record<string, unknown> };
      throw new OpsError(err.code ?? "invalid_target", err.message, err.details);
    }

    if (normalized.kind === "ref") {
      const ref = normalized.value ?? "";
      const parsed = parseFrameRef(ref);
      if (!parsed) {
        throw new OpsError("invalid_target", `"${ref}" is not a read ref. Use e1, f0-e3 or f0.1-e2.`);
      }
      const frame = parsed.path.length ? resolveFrame(tab, parsed.path, domains) : null;
      const actor = frame?.actor ?? pageActor(tab);
      const stored: ResolvedRef | null = refRegistry.resolve(ref, idForTab(tab), parsed.path);
      if (!stored) {
        throw new OpsError(
          normalized.legacy ? "element_not_found" : "stale_reference",
          `Ref "${ref}" is not in the current snapshot. Read the page again and use a new ref.`,
          { ref, reason: "unknown_ref", category: "stale_reference" }
        );
      }
      let inspected: TargetProbe | null = null;
      try {
        // The fixed inspect script returns the descriptor fields directly. Do
        // not re-coerce here: its label budget must match the one used when the
        // snapshot digest was captured, or a long label looks like a change.
        inspected = (await execute(actor, inspectElementScript(), [stored.element], 10_000)) as TargetProbe | null;
      } catch {
        inspected = null;
      }
      if (!inspected || inspected.found !== true || !inspected.element) {
        throw new OpsError(
          normalized.legacy ? "element_not_found" : "stale_reference",
          `Ref "${ref}" was removed or replaced after it was read. Read the page again.`,
          { ref, reason: "element_removed", category: "stale_reference" }
        );
      }
      if (documentChanged(stored.root, inspected.root)) {
        throw new OpsError(
          normalized.legacy ? "element_not_found" : "document_changed",
          `Ref "${ref}" belongs to a document that was replaced by a navigation.`,
          { ref, reason: "document_replaced", category: "document_changed" }
        );
      }
      // The fixed read script computes its own descriptor digest. Its field
      // set differs from the inspect probe's, so compare the stable fields
      // directly instead of recomputing a digest with a different recipe.
      const sameText = (left: string | null | undefined, right: string | null | undefined): boolean =>
        String(left ?? "").slice(0, 200) === String(right ?? "").slice(0, 200);
      if (
        !sameText(stored.descriptor.tag, inspected.tag) ||
        !sameText(stored.descriptor.role, inspected.role) ||
        !sameText(stored.descriptor.href, inspected.href)
      ) {
        throw new OpsError(
          normalized.legacy ? "element_not_found" : "stale_reference",
          `Ref "${ref}" points to an element whose role or link changed.`,
          { ref, reason: "descriptor_changed", category: "stale_reference" }
        );
      }
      return {
        target: { ...inspected, element: stored.element },
        actor,
        framePath: parsed.path,
        frameUrl: frame?.url ?? null,
        legacy: normalized.legacy === true,
        kind: normalized.kind,
      };
    }

    const actor = pageActor(tab);
    let raw: unknown;
    try {
      raw = await execute(actor, semanticTargetScript(normalized), [], 10_000);
    } catch (error) {
      throw new OpsError(
        "target_not_found",
        `Could not resolve the target: ${String((error as Error)?.message ?? error)}`,
        { kind: normalized.kind, reason: "resolution_failed" }
      );
    }
    const probe = coerceSemanticTarget(raw) as TargetProbe | null;
    // The coercer deliberately mirrors only a small descriptor. Link and edit
    // state are needed for policy checks, so read them from the fixed script's
    // own result (data, never evaluated code).
    if (probe && raw && typeof raw === "object") {
      const fields = raw as Record<string, unknown>;
      if (typeof fields.href === "string") probe.href = fields.href;
      if (typeof fields.readOnly === "boolean") probe.readOnly = fields.readOnly;
      if (typeof fields.editable === "boolean") probe.editable = fields.editable;
    }
    if (!probe || probe.invalidSelector) {
      throw new OpsError("invalid_target", "The CSS selector is not valid in this document.", { kind: normalized.kind });
    }
    if (probe.truncated) {
      throw new OpsError(
        "unsupported_operation",
        "The target search hit its node limit before uniqueness could be proven.",
        { kind: normalized.kind, reason: "scan_limit" }
      );
    }
    if (probe.ambiguous) {
      throw new OpsError(
        "target_ambiguous",
        `${describeTarget(normalized)} matches ${probe.count ?? 0} elements. Use a ref or a more specific target.`,
        { kind: normalized.kind, count: probe.count, candidates: (probe.candidates ?? []).slice(0, 5) }
      );
    }
    if (!probe.found || !probe.element) {
      throw new OpsError(
        normalized.legacy ? "element_not_found" : "target_not_found",
        `No element matches the ${describeTarget(normalized)} target.`,
        { kind: normalized.kind }
      );
    }
    return { target: probe, actor, framePath: [], frameUrl: null, legacy: normalized.legacy === true, kind: normalized.kind };
  };

  const targetInfo = (target: TargetProbe): PageActionTargetInfo => ({
    tag: String(target.tag ?? ""),
    role: String(target.role ?? "generic"),
    label: String(target.label ?? ""),
    type: typeof target.type === "string" ? target.type : null,
    sensitive: target.sensitive === true || isSensitiveDescriptor(target) === true,
  });

  const captureSignature = async (actor: any, timeoutMs: number): Promise<any | null> => {
    try {
      return coercePageSignature(await execute(actor, pageSignatureScript(), [], timeoutMs));
    } catch {
      return null;
    }
  };

  const observeActionEffect = async (
    tab: any,
    framePath: number[],
    domains: string[] | undefined,
    before: any | null
  ): Promise<PageActionEffect> => {
    const started = Date.now();
    let after: any | null = null;
    let waitedMs = 0;
    if (!before) {
      await sleep(ACTION_PROBE_INTERVAL_MS * 2);
      waitedMs = Date.now() - started;
    }
    while (before && waitedMs < ACTION_SETTLE_MS) {
      await sleep(Math.min(ACTION_PROBE_INTERVAL_MS, ACTION_SETTLE_MS - waitedMs));
      try {
        const actor = framePath.length ? resolveFrame(tab, framePath, domains).actor : pageActor(tab);
        after = await captureSignature(actor, ACTION_PROBE_TIMEOUT_MS);
      } catch {
        after = null;
      }
      waitedMs = Date.now() - started;
      if (before && after && documentChanged(before.root, after.root)) {
        if (after.readyState === "complete") break;
        continue;
      }
      if (before && after && (diffHasChanges(comparePageSignatures(before, after)) ||
          buildPageDelta(before, after, false).hasChanges)) {
        break;
      }
    }
    if (!before || !after) {
      const currentUrl = framePath.length ? "" : tabUrl(tab);
      const urlChanged = !!before && !!currentUrl && currentUrl !== before.url;
      return {
        changed: urlChanged, urlChanged, titleChanged: false, domChanged: false,
        valueChanged: false, waitedMs, probeFailed: true,
        ...(urlChanged ? { navigation: true } : {}),
        ...(after ? { readyState: after.readyState } : {}),
      };
    }
    const diff = comparePageSignatures(before, after) ?? {};
    const documentReplaced = documentChanged(before.root, after.root);
    const built = buildPageDelta(before, after, documentReplaced);
    const delta = built.delta;
    return {
      changed: documentReplaced || diffHasChanges(diff) || built.hasChanges,
      urlChanged: diff.urlChanged === true,
      titleChanged: diff.titleChanged === true,
      domChanged: !documentReplaced && diff.domChanged === true,
      valueChanged: !documentReplaced && diff.valueChanged === true,
      waitedMs,
      ...(diff.urlChanged ? { navigation: true } : {}),
      ...(documentReplaced ? { documentReplaced: true } : {}),
      readyState: after.readyState,
      attribution: "observed_after_action_not_proven",
      delta,
    };
  };

  /* ---------------- PDF helper ---------------- */
  const readPdfTab = async (tab: any, maxChars: number, offset: number): Promise<PageReadResult> => {
    const unavailable = "Could not extract text from this PDF. It may still be loading, password protected, or unavailable.";
    let app: any = null;
    const deadline = Date.now() + PDF_WAIT_MS;
    while (!app && Date.now() < deadline) {
      try {
        const candidate = tab?.linkedBrowser?.contentWindow?.PDFViewerApplication;
        if (candidate?.pdfDocument) app = candidate;
      } catch { /* Cross-process viewer initializing. */ }
      if (!app) await sleep(200);
    }
    if (!app) throw new OpsError("pdf_unreadable", unavailable);
    try {
      const document = app.pdfDocument;
      const pageCount = Math.max(0, Number(document?.numPages) || 0);
      const pages: string[] = [];
      for (let number = 1; number <= pageCount; number += 1) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        const items = Array.isArray(content?.items) ? content.items : [];
        const text = items.map((item: any) => String(item?.str ?? "")).join(" ")
          .replace(/[ \t\u00a0]+/g, " ").trim();
        if (text) pages.push(text);
      }
      const full = pages.join("\n\n");
      if (!full) throw new Error("empty");
      const start = Math.min(Math.max(0, offset), full.length);
      const body = full.slice(start, start + maxChars);
      const nextOffset = start + body.length < full.length ? start + body.length : null;
      return {
        title: String(app.documentTitle || app.metadata?.info?.Title || tabTitle(tab)),
        url: tabUrl(tab), selectedText: "", text: body, truncated: nextOffset !== null,
        length: full.length, offset: start, nextOffset, description: null,
        format: "text", contentType: "application/pdf", selector: null,
      };
    } catch {
      throw new OpsError("pdf_unreadable", unavailable);
    }
  };

  const openTab = (url: string, inBackground: boolean, userContextId?: number): any => {
    const options: Record<string, unknown> = {
      inBackground,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    };
    if (typeof userContextId === "number" && userContextId > 0) options.userContextId = userContextId;
    return win.gBrowser.addTab(url, options);
  };

  const essentialsRestoreHost = (): EssentialsRestoreHost => {
    const workspaceManager = win.gZenWorkspaces;
    const browser = win.gBrowser;
    return {
      moveTabsToWorkspace:
        workspaceManager && typeof workspaceManager.moveTabsToWorkspace === "function"
          ? (tabs, spaceId) => workspaceManager.moveTabsToWorkspace(tabs, spaceId)
          : undefined,
      pinTab: browser && typeof browser.pinTab === "function" ? (tab) => browser.pinTab(tab) : undefined,
      unpinTab: browser && typeof browser.unpinTab === "function" ? (tab) => browser.unpinTab(tab) : undefined,
    };
  };
  const describeEssentialsLimitations = (notes: Map<string, Set<string>>): string | undefined => {
    if (!notes.size) return undefined;
    return [...notes].map(([tabId, reasons]) => {
      const tab = tabsById.get(tabId);
      const label = tab ? `"${tabTitle(tab)}" (${tabId})` : `(${tabId})`;
      return `The tab ${label} ${[...reasons].join(", ")}.`;
    }).join(" ");
  };

  const waitForSplitGone = async (members: any[], timeoutMs = SPLIT_CLOSE_TIMEOUT_MS): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    const gone = (): boolean => members.every((m) => !m || !m.isConnected || !m.splitView);
    while (!gone()) {
      if (Date.now() >= deadline) return false;
      await sleep(100);
    }
    return true;
  };

  const getPlaces = (): any =>
    ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs").PlacesUtils;

  /* ---------------------------------------------------------------- *
   * The fixed method map
   * ---------------------------------------------------------------- */
  const handlers: Record<string, (params: any) => any> = {
    status: () => {
      const tabs = realTabs();
      const active = win.gBrowser?.selectedTab;
      const folder = active ? folderOf(active) : null;
      let profile = "";
      try {
        profile = Services.dirsvc.get("ProfD", Components.interfaces.nsIFile).path;
      } catch { /* Profile path is optional. */ }
      return {
        appName: Services.appinfo.name,
        appVersion: Services.appinfo.version,
        buildId: Services.appinfo.appBuildID,
        platform: Services.appinfo.OS,
        profile,
        windowId,
        focused: win.document.hasFocus(),
        workspacesEnabled: spacesEnabled(),
        activeSpaceId: spacesEnabled() ? win.gZenWorkspaces.activeWorkspace : null,
        activeTab: active ? {
          id: idForTab(active), title: tabTitle(active), url: tabUrl(active),
          spaceId: active.getAttribute("zen-workspace-id") || null,
          folderId: folder?.id ?? null,
        } : null,
        spaces: allSpaceInfo(),
        tabCount: tabs.length,
        folderCount: collectFolders().length,
      } satisfies BridgeStatus;
    },

    "spaces.list": () => ({
      activeSpaceId: spacesEnabled() ? win.gZenWorkspaces.activeWorkspace : null,
      spaces: allSpaceInfo(),
      workspacesEnabled: spacesEnabled(),
    }),

    "spaces.create": async (params: any) => {
      assertSpacesEnabled();
      const name = String(params?.name ?? "").trim();
      if (!name) throw new OpsError("invalid_name", "Space name cannot be empty");
      if (name.length > 64) throw new OpsError("invalid_name", "Space name must be 64 characters or fewer");
      if (findSpace(name)) throw new OpsError("space_exists", `A space named "${name}" already exists.`);
      const switchTo = params.switchTo === true;
      const data = await workspaces().createAndSaveWorkspace(
        name,
        params.icon ? String(params.icon) : undefined,
        !switchTo,
        Number.isFinite(params?.containerTabId) ? Number(params.containerTabId) : 0
      );
      if (!data) throw new OpsError("space_create_failed", "Zen refused to create the space");
      await sleep(120);
      return {
        created: true,
        space: spaceInfoFor(data),
        activeSpaceId: win.gZenWorkspaces.activeWorkspace,
        switched: win.gZenWorkspaces.activeWorkspace === data.uuid,
      };
    },

    "spaces.switch": async (params: any) => {
      assertSpacesEnabled();
      const space = requireSpace(String(params?.space ?? ""), "switch spaces");
      if (win.gZenWorkspaces.activeWorkspace !== space.uuid) {
        await workspaces().changeWorkspaceWithID(space.uuid);
      }
      return { space: spaceInfoFor(space), activeSpaceId: win.gZenWorkspaces.activeWorkspace };
    },

    "spaces.delete": async (params: any) => {
      assertSpacesEnabled();
      const space = requireSpace(String(params?.space ?? ""), "delete spaces");
      if (win.gZenWorkspaces.activeWorkspace === space.uuid) {
        const fallback = listSpaces().find((s: any) => s.uuid !== space.uuid);
        if (fallback) await workspaces().changeWorkspaceWithID(fallback.uuid);
      }
      await workspaces().removeWorkspace(space.uuid);
      return {
        deleted: true, spaceId: space.uuid, spaceName: space.name,
        activeSpaceId: win.gZenWorkspaces.activeWorkspace ?? null,
      };
    },

    "tabs.list": (params: any) => {
      const limit = clamp(params?.limit ?? 500, 1, 2_000);
      const query = String(params?.query ?? "").trim().toLowerCase();
      const requestedSpace = params?.space ? requireSpace(params.space, "filter tabs") : null;
      const tabs = realTabs()
        .map((tab: any, index: number) => tabInfo(tab, index))
        .filter((tab: TabInfo) => {
          if (requestedSpace && tab.spaceId !== requestedSpace.uuid) return false;
          if (params?.pinnedOnly && !tab.pinned && !tab.folderId) return false;
          if (query && !`${tab.title}\n${tab.url}`.toLowerCase().includes(query)) return false;
          return true;
        });
      return {
        windowId,
        activeSpaceId: spacesEnabled() ? win.gZenWorkspaces.activeWorkspace : null,
        total: tabs.length,
        tabs: tabs.slice(0, limit),
      };
    },

    "tabs.open": async (params: any) => {
      assertSpacesEnabled();
      const incoming = Array.isArray(params?.urls) ? params.urls : [];
      if (!incoming.length) throw new OpsError("no_urls", "Provide at least one URL to open");
      if (incoming.length > MAX_TABS_PER_OPEN) {
        throw new OpsError("too_many_urls", `Opening ${incoming.length} tabs at once is too many (max ${MAX_TABS_PER_OPEN}).`);
      }
      const urls = [...new Set(incoming.map((url: string) => normalizeUrl(url)))];
      const container = params?.container === undefined || params?.container === null || params?.container === ""
        ? null : resolveContainer(params.container);
      const targetSpace = params?.space ? requireSpace(params.space, "open tabs") : findSpace(undefined);
      if (!targetSpace) throw new OpsError("no_space", "There is no space to open tabs in");
      const background = params.background !== false;
      const opened: any[] = [];
      const requested = new Map<any, string>();
      try {
        for (const url of urls) {
          const target = String(url);
          const tab = openTab(target, background, Number(container?.userContextId ?? 0) || undefined);
          opened.push(tab);
          requested.set(tab, target);
        }
      } catch (error) {
        for (const tab of opened) {
          try { win.gBrowser.removeTab(tab, { closeWindowWithLastTab: false }); } catch { /* cleanup */ }
        }
        throw error;
      }
      if (targetSpace.uuid !== win.gZenWorkspaces.activeWorkspace) {
        win.gZenWorkspaces.moveTabsToWorkspace(opened, targetSpace.uuid);
      }
      if (params.folderId) {
        const folder = collectFolders().find((f: any) => f.id === params.folderId);
        if (!folder) throw new OpsError("folder_not_found", `No folder matches id "${params.folderId}"`);
        if (folder.getAttribute("zen-workspace-id") !== targetSpace.uuid) {
          throw new OpsError("mixed_spaces", "The folder and the target space must be the same space");
        }
        for (const tab of opened) if (!tab.pinned) win.gBrowser.pinTab(tab);
        folder.addTabs(opened);
      }
      const switchTo = params.switchTo === true;
      if (switchTo) {
        await workspaces().changeWorkspaceWithID(targetSpace.uuid);
        if (opened[0]?.isConnected) win.gBrowser.selectedTab = opened[0];
      }
      await sleep(switchTo ? 260 : 160);
      return {
        space: spaceInfoFor(targetSpace),
        tabs: opened.filter((tab) => tab?.isConnected && !tab.closing).map((tab, index) => ({
          ...tabInfo(tab, index), requestedUrl: requested.get(tab) ?? tabUrl(tab),
        })),
        background,
      };
    },

    "tabs.close": (params: any) => {
      const ids = Array.isArray(params?.tabIds) ? params.tabIds : [];
      if (!ids.length) throw new OpsError("no_tabs", "Provide tabIds to close");
      const tabs = resolveTabs(ids);
      const closed: string[] = [];
      for (const tab of tabs) {
        const id = tabIds.get(tab);
        if (id) refRegistry.clearTab(id);
        if (!tab.isConnected || tab.closing || !id) continue;
        win.gBrowser.removeTab(tab, { closeWindowWithLastTab: false });
        closed.push(id);
      }
      return { closed: closed.length, tabIds: closed };
    },

    "tabs.select": async (params: any) => {
      const [tab] = resolveTabs([String(params?.tabId ?? "")]);
      const focusWindow = params?.focusWindow === true;
      let outcome: TabActivationOutcome;
      try {
        outcome = await activateTab(win, tab, { focusWindow });
      } catch (error) {
        throw new OpsError("select_failed", `Could not select the tab: ${String((error as Error)?.message ?? error)}`);
      }
      if (!outcome.active) {
        const current = win.gBrowser?.selectedTab;
        const currentLabel = current && current !== tab
          ? `"${tabTitle(current)}" (id ${tabIds.get(current) ?? "unknown"})`
          : "another tab";
        throw new OpsError(
          "select_failed",
          `The tab "${tabTitle(tab)}" did not become active after ${outcome.attempts} attempt(s); ${currentLabel} is still active.`
        );
      }
      const result: Record<string, unknown> = {
        tab: tabInfo(tab, realTabs().indexOf(tab)),
        activeSpaceId: spacesEnabled() ? win.gZenWorkspaces.activeWorkspace : null,
      };
      if (focusWindow && outcome.windowFocused !== undefined) result.windowFocused = outcome.windowFocused;
      return result;
    },

    "tabs.pin": (params: any) => {
      const ids = Array.isArray(params?.tabIds) ? params.tabIds : [];
      if (!ids.length) throw new OpsError("no_tabs", "Provide tabIds to pin or unpin");
      if (typeof params?.pinned !== "boolean") throw new OpsError("invalid_params", "`pinned` must be true or false");
      const tabs = resolveTabs(ids);
      const changed: string[] = [];
      for (const tab of tabs) {
        if (isEssential(tab) || !!tab.pinned === params.pinned || !tab.isConnected || tab.closing) continue;
        if (params.pinned) win.gBrowser.pinTab(tab);
        else win.gBrowser.unpinTab(tab);
        changed.push(idForTab(tab));
      }
      return { tabIds: changed, changed: changed.length };
    },

    "tabs.read": async (params: any) => {
      const [tab] = resolveTabs([String(params?.tabId ?? "")]);
      const listedUrl = tabUrl(tab);
      if (!isHttpUrl(listedUrl)) {
        throw new OpsError(
          isPrivilegedUrl(listedUrl) ? "privileged_page" : "unsupported_page",
          "Only http(s) pages can be read."
        );
      }
      const format = typeof params?.format === "string" ? params.format : undefined;
      const isSnapshot = format === "snapshot";
      const isSemantic = format === "semantic";
      const isCompact = isSnapshot || isSemantic;
      const isControls = format === "interactive" || isCompact;
      const maxChars = isCompact ? SNAPSHOT_TEXT_CHARS : clamp(params?.maxChars ?? 24_000, 500, 60_000);
      const maxElements = isCompact
        ? isSemantic
          ? Math.min(120, clampSnapshotElements(params?.maxElements))
          : clampSnapshotElements(params?.maxElements)
        : MAX_PAGE_ELEMENTS;
      const requestedOffset = Number(params?.offset);
      const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
      const selector = params?.selector ? String(params.selector).trim() : undefined;
      const framePath = requireFramePath(params?.framePath);
      const domains: string[] | undefined = params?.allowedDomains;
      const notes: string[] = [];

      if (params?.maxElements !== undefined && !isCompact) notes.push("maxElements only applies to snapshot and semantic reads.");
      if (isCompact && params?.maxChars !== undefined && Math.floor(Number(params.maxChars)) !== SNAPSHOT_TEXT_CHARS) {
        notes.push(`maxChars is ignored for ${format} reads.`);
      }
      if (isSemantic && selector) notes.push("Semantic reads search only the selected subtree.");
      if (isControls && isPdfTab(tab)) {
        throw new OpsError("unsupported_page", "Interactive, snapshot and semantic views of the PDF viewer are not available.");
      }
      if (isPdfTab(tab)) {
        if (framePath.length) throw new OpsError("unsupported_frame", "PDF text is only read from the top document.");
        return readPdfTab(tab, maxChars, offset);
      }

      const frame = framePath.length ? resolveFrame(tab, framePath, domains) : null;
      const contentType = frame ? null : contentTypeOf(tab);
      const runRead = (actor: any, prefix: string): Promise<unknown> =>
        execute(actor, readScript({
          maxChars,
          offset,
          ...(format ? { format } : {}),
          ...(selector ? { selector } : {}),
          ...(isCompact ? { maxElements } : {}),
          ...(prefix ? { refPrefix: prefix } : {}),
        }), [], 15_000);

      let raw: unknown;
      try {
        raw = await runRead(frame?.actor ?? pageActor(tab), frameRefPrefix(framePath));
      } catch (error) {
        throw new OpsError("read_failed", `Could not read "${tabTitle(tab)}": ${String((error as Error)?.message ?? error)}`);
      }
      const outcome = coercePageSnapshot(raw) as ReadOutcomeLike | null;
      if (!outcome) throw new OpsError("read_failed", `The tab "${tabTitle(tab)}" did not return page content.`);
      if (selector && (raw as { selectorMatched?: unknown } | null)?.selectorMatched === false) {
        throw new OpsError("selector_not_found", `No element matches selector "${selector}"`);
      }
      const result = outcome.result;

      const listed = listFrames(tab, domains);
      const refTabId = idForTab(tab);
      const storeDocument = (path: number[], record: ReadOutcomeLike): void => {
        if (!isControls) return;
        refRegistry.beginSnapshot(refTabId, path, record.snapshotId, record.root);
        for (const ref of record.refs) {
          if (!ref.ref || ref.element === undefined || ref.element === null) continue;
          const descriptor: RefDescriptor = {
            tag: String(ref.tag ?? ""),
            role: String(ref.role ?? "generic"),
            type: ref.type ?? null,
            label: String(ref.label ?? ""),
            href: ref.href ?? null,
          };
          refRegistry.register(
            refTabId, path, ref.ref, descriptor, ref.element,
            ref.digest ?? elementDigest(descriptor)
          );
        }
      };
      if (isControls) storeDocument(framePath, outcome);

      if (isControls && !selector && !isSemantic) {
        const descendants = listed.frames.filter(
          (candidate) => candidate.path.length > framePath.length &&
            framePath.every((index, position) => candidate.path[position] === index)
        );
        const scanned = descendants.slice(0, MAX_FRAME_SCANS);
        const mergeCap = isSnapshot ? maxElements : MAX_PAGE_ELEMENTS;
        const merged: any[] = [...(result.elements ?? [])].map((element) =>
          framePath.length ? { ...element, framePath: [...framePath], frameUrl: frame?.url ?? null } : element
        );
        let elementsTotal = result.elementsTotal ?? result.elements?.length ?? 0;
        let truncated = result.elementsTruncated === true;
        const frameOutcomes = await Promise.all(scanned.map(async (candidate) => {
          try {
            const context = resolveFrame(tab, candidate.path, domains);
            const frameRaw = await runRead(context.actor, frameRefPrefix(candidate.path));
            return { frame: candidate, outcome: coercePageSnapshot(frameRaw) as ReadOutcomeLike | null };
          } catch {
            return { frame: candidate, outcome: null };
          }
        }));
        let failed = 0;
        for (const entry of frameOutcomes) {
          if (!entry.outcome) { failed += 1; continue; }
          storeDocument(entry.frame.path, entry.outcome);
          const elements = entry.outcome.result.elements ?? [];
          elementsTotal += entry.outcome.result.elementsTotal ?? elements.length;
          if (entry.outcome.result.elementsTruncated) truncated = true;
          for (const element of elements) {
            if (merged.length >= mergeCap) { truncated = true; break; }
            merged.push({ ...element, framePath: [...entry.frame.path], frameUrl: entry.frame.url });
          }
        }
        result.elements = merged;
        result.elementsTruncated = truncated;
        result.elementsTotal = elementsTotal;
        if (isSnapshot) {
          const framesComplete = descendants.length <= scanned.length && failed === 0 &&
            !listed.truncated && listed.skipped === 0;
          result.framesComplete = framesComplete;
          result.snapshotComplete = framesComplete && !truncated;
          if (!framesComplete) {
            result.limitations = [
              ...(result.limitations ?? []),
              "Some frames could not be fully inspected for this snapshot.",
            ];
          }
        } else {
          if (descendants.length > scanned.length) notes.push(`Only the first ${MAX_FRAME_SCANS} frames were scanned for controls.`);
          if (failed > 0) notes.push(`${failed} frame(s) could not be read.`);
        }
      } else if (isSemantic) {
        const nested = listed.frames.filter(
          (candidate) => candidate.path.length > framePath.length &&
            framePath.every((index, position) => candidate.path[position] === index)
        );
        if (nested.length) notes.push("Child frames are not part of the semantic model; read a frame with framePath.");
        if (result.semantic?.coverage) {
          result.semantic.coverage.complete =
            result.semantic.coverage.complete && nested.length === 0 && !listed.truncated;
        }
      } else if (isSnapshot) {
        result.framesComplete = true;
        result.snapshotComplete = !result.elementsTruncated;
      }

      if (!isSnapshot) {
        if (listed.skipped > 0) notes.push(`${listed.skipped} frame(s) were skipped because they are not http(s) or are off-list.`);
        if (listed.truncated) notes.push(`Only the first ${MAX_FRAMES} frames are listed.`);
      }
      if (isCompact && notes.length) result.limitations = [...(result.limitations ?? []), ...notes];
      result.frames = listed.frames;
      if (framePath.length) result.framePath = framePath;
      if (contentType !== null && !result.contentType) result.contentType = contentType;
      if (!isCompact && notes.length) {
        const note = notes.join(" ");
        result.limitation = result.limitation ? `${result.limitation} ${note}` : note;
      }
      return result;
    },

    "tabs.click": async (params: any): Promise<ClickElementResult> => {
      const tabId = String(params?.tabId ?? "");
      const tab = requireActionTab(tabId, "click");
      assertActionUrlAllowed(tabUrl(tab), params?.allowedDomains, "clicking in");
      const resolved = await resolvePageTarget(tab, params ?? {}, params?.allowedDomains);
      const target = resolved.target;
      if (!resolved.legacy && target.visible === false) {
        throw new OpsError("target_not_actionable", `The target "${target.label || target.tag}" is not visible.`, { reason: "hidden" });
      }
      if (target.disabled) {
        throw new OpsError(resolved.legacy ? "element_disabled" : "target_not_actionable", `The target "${target.label || target.tag}" is disabled.`);
      }
      if (target.href) assertActionUrlAllowed(target.href, params?.allowedDomains, "following a link to");
      const before = await captureSignature(resolved.actor, SIGNATURE_BEFORE_TIMEOUT_MS);
      try {
        await resolved.actor.sendQuery("MarionetteCommandsParent:clickElement", {
          elem: target.element,
          capabilities: { "moz:accessibilityChecks": false, "moz:webdriverClick": true },
        });
      } catch (error) {
        throw new OpsError("click_failed", `Could not click "${target.label || target.tag}": ${String((error as Error)?.message ?? error)}`);
      }
      const effect = await observeActionEffect(tab, resolved.framePath, params?.allowedDomains, before);
      const url = tabUrl(tab);
      return {
        clicked: true,
        tabId,
        url: isHttpUrl(url) ? url : "",
        title: tabTitle(tab),
        target: targetInfo(target),
        effect,
        ...(resolved.framePath.length ? {
          framePath: resolved.framePath,
          frameUrl: currentFrameUrl(tab, resolved.framePath) ?? resolved.frameUrl,
        } : {}),
      };
    },

    "tabs.type": async (params: any): Promise<TypeTextResult> => {
      const tabId = String(params?.tabId ?? "");
      const tab = requireActionTab(tabId, "type into");
      const text = String(params?.text ?? "");
      const clear = params?.clear === true;
      if (!text && !clear) throw new OpsError("invalid_args", "Provide text to type, or set clear=true.");
      if (text.length > 10_000) throw new OpsError("invalid_args", "text must be 10,000 characters or fewer.");
      assertActionUrlAllowed(tabUrl(tab), params?.allowedDomains, "typing into");
      const resolved = await resolvePageTarget(tab, params ?? {}, params?.allowedDomains);
      const target = resolved.target;
      if (!resolved.legacy && target.visible === false) throw new OpsError("target_not_actionable", "The target is not visible.");
      if (target.disabled) throw new OpsError(resolved.legacy ? "element_disabled" : "target_not_actionable", "The target is disabled.");
      if (target.readOnly) throw new OpsError(resolved.legacy ? "element_readonly" : "target_not_actionable", "The target is read-only.");
      if (target.tag === "input" && target.type === "file") {
        throw new OpsError("target_not_actionable", "Files cannot be attached. Ask the user to choose the file in Zen.");
      }
      if (!resolved.legacy && target.editable !== true) throw new OpsError("target_not_actionable", "The target is not editable.");
      const before = await captureSignature(resolved.actor, SIGNATURE_BEFORE_TIMEOUT_MS);
      try {
        if (clear) {
          await resolved.actor.sendQuery("MarionetteCommandsParent:clearElement", { elem: target.element });
        }
        await resolved.actor.sendQuery("MarionetteCommandsParent:sendKeysToElement", {
          elem: target.element,
          text,
          capabilities: { "moz:webdriverClick": true, strictFileInteractability: false },
        });
      } catch (error) {
        throw new OpsError("type_failed", `Could not type into "${target.label || target.tag}": ${String((error as Error)?.message ?? error)}`);
      }
      let observed: { compared: boolean; matchesInput: boolean | null; sensitive: boolean } = {
        compared: false, matchesInput: null, sensitive: target.sensitive === true,
      };
      try {
        const probe = coerceTypedValueProbe(
          await execute(resolved.actor, verifyTypedValueScript(text, clear ? "exact" : "suffix"), [target.element], 5_000)
        );
        observed = {
          compared: !!probe?.compared,
          matchesInput: typeof probe?.matchesInput === "boolean" ? probe.matchesInput : null,
          sensitive: !!probe?.sensitive || target.sensitive === true,
        };
      } catch { /* Verification is best effort. */ }
      const limitation = observed.compared
        ? observed.matchesInput === false
          ? "The field value did not match the typed text exactly; the page may have reformatted it."
          : undefined
        : observed.sensitive
          ? "This field is classified sensitive. The text was not read back."
          : "The typed value could not be read back; the field may have navigated.";
      const effect = await observeActionEffect(tab, resolved.framePath, params?.allowedDomains, before);
      const url = tabUrl(tab);
      return {
        typed: text.length, cleared: clear, tabId,
        url: isHttpUrl(url) ? url : "", title: tabTitle(tab), target: targetInfo(target),
        effect, observed,
        ...(resolved.framePath.length ? {
          framePath: resolved.framePath,
          frameUrl: currentFrameUrl(tab, resolved.framePath) ?? resolved.frameUrl,
        } : {}),
        ...(limitation ? { limitation } : {}),
      };
    },

    "tabs.waitFor": async (params: any): Promise<WaitForResult> => {
      const tabId = String(params?.tabId ?? "");
      if (!tabId) throw new OpsError("no_tab", "Provide the tabId to wait in.");
      const value = (input: unknown): string => (typeof input === "string" ? input.trim() : "");
      const until = params?.until === "absent" ? "absent" : "present";
      const selector = value(params?.selector);
      const text = value(params?.text);
      const urlContains = value(params?.urlContains);
      const titleContains = value(params?.titleContains);
      const state: WaitElementState =
        params?.state === "visible" || params?.state === "enabled" ? params.state : "present";
      if (params?.state !== undefined && !selector) throw new OpsError("invalid_args", "state requires a selector condition.");
      const documentChangedWait = params?.documentChanged === true;
      const requestedDocumentId = value(params?.documentId);
      const newTab = params?.newTab === true;
      const tabClosed = params?.tabClosed === true;
      const dialog = params?.dialog === true;

      const candidates: Array<[WaitCondition, string]> = [];
      if (selector) candidates.push(["selector", selector]);
      if (text) candidates.push(["text", text]);
      if (urlContains) candidates.push(["urlContains", urlContains]);
      if (titleContains) candidates.push(["titleContains", titleContains]);
      if (documentChangedWait || requestedDocumentId) candidates.push(["document", requestedDocumentId || "document"]);
      if (newTab) candidates.push(["newTab", "newTab"]);
      if (tabClosed) candidates.push(["tabClosed", tabId]);
      if (dialog) candidates.push(["dialog", "dialog"]);
      if (candidates.length !== 1) {
        throw new OpsError("invalid_args", "Provide exactly one wait condition.");
      }
      const [condition, query] = candidates[0];
      if (query.length > 2_000) throw new OpsError("invalid_args", "The condition text must be 2,000 characters or fewer.");
      if (until === "absent" && ["document", "newTab", "tabClosed", "dialog"].includes(condition)) {
        throw new OpsError("invalid_args", "until absent is only supported for selector, text, URL and title conditions.");
      }

      let tab: any;
      try {
        tab = requireActionTab(tabId, "wait in");
      } catch (error) {
        const known = tabsById.get(tabId);
        const closed = closedTabIds.has(tabId) || (known !== undefined && (!known.isConnected || known.closing));
        if (tabClosed && closed) {
          return {
            matched: true, waitedMs: 0, condition: "tabClosed", until, query: tabId, tabId,
            url: "", title: "", limitation: "The tab was already closed when the wait started.",
          };
        }
        throw error;
      }
      const framePath = requireFramePath(params?.framePath);
      if (framePath.length && condition === "document") throw new OpsError("invalid_args", "Document identity applies to the top document.");
      const domains: string[] | undefined = params?.allowedDomains;
      assertActionUrlAllowed(tabUrl(tab), domains, "waiting in");
      const requestedTimeout = Number(params?.timeoutMs);
      const timeoutMs = clamp(
        Number.isFinite(requestedTimeout) && requestedTimeout >= 0 ? requestedTimeout : WAIT_DEFAULT_TIMEOUT_MS,
        0, WAIT_MAX_TIMEOUT_MS
      );
      const requestedPoll = Number(params?.pollMs);
      const pollMs = clamp(
        Number.isFinite(requestedPoll) && requestedPoll > 0 ? requestedPoll : 250, 100, 2_000
      );
      const pageCondition = ["selector", "text", "urlContains", "titleContains"].includes(condition);

      const startDocumentId = documentIdForTab(tab);
      const documentBaseline = requestedDocumentId || startDocumentId;
      const startTabIds = new Set(realTabs().map((entry) => idForTab(entry)));
      let openedTabId = "";
      let closedTab = false;
      const dialogBaseline = dialogSeq;
      let wake: (() => void) | null = null;
      const signal = (): void => {
        const waiter = wake;
        wake = null;
        waiter?.();
      };
      const sleepOrWake = (ms: number): Promise<void> => new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          wake = null;
          clearTimeout(timer);
          resolve();
        };
        wake = finish;
        const timer = setTimeout(finish, ms);
      });

      const container = win.gBrowser?.tabContainer;
      const onOpen = (event: any): void => {
        try {
          const id = idForTab(event?.target);
          if (!openedTabId && !startTabIds.has(id)) openedTabId = id;
        } catch { /* Still wake the loop. */ }
        signal();
      };
      const onClose = (event: any): void => {
        try { if (idForTab(event?.target) === tabId) closedTab = true; } catch { /* next */ }
        signal();
      };
      const dialogWaiter = (): void => signal();
      const watchingTabs = condition === "newTab" || condition === "tabClosed";
      try {
        if (watchingTabs && container?.addEventListener) {
          container.addEventListener("TabOpen", onOpen);
          container.addEventListener("TabClose", onClose);
        }
        if (condition === "dialog") dialogWaiters.add(dialogWaiter);

        let matched = false;
        let lastError = "";
        const started = Date.now();
        let waitedMs = 0;
        for (;;) {
          if (!tab.isConnected && (pageCondition || condition === "document")) {
            lastError = "the tab closed";
            break;
          }
          if (pageCondition) {
            try {
              assertActionUrlAllowed(tabUrl(tab), domains, "waiting in");
            } catch (error) {
              if (error instanceof OpsError && error.code === "domain_not_allowed") {
                lastError = "the page left the domain allowlist";
                break;
              }
              throw error;
            }
            let actor: any = null;
            try {
              actor = framePath.length ? resolveFrame(tab, framePath, domains).actor : pageActor(tab);
            } catch (error) {
              lastError = String((error as Error)?.message ?? error);
            }
            if (actor) {
              try {
                const raw = await execute(actor, waitProbeScript({
                  condition,
                  [condition]: query,
                  ...(condition === "selector" ? { state } : {}),
                }), [], 2_500);
                const probe = coerceWaitProbe(raw);
                matched = probe ? (until === "absent" ? probe.matched === false : probe.matched === true) : false;
                if (!probe) lastError = "the probe returned no document state";
              } catch (error) {
                matched = false;
                lastError = String((error as Error)?.message ?? error);
              }
            }
          } else if (condition === "document") {
            const current = tab.isConnected ? documentIdForTab(tab) : "";
            matched = current !== "" && documentBaseline !== "" &&
              (documentChangedWait ? current !== documentBaseline : current === documentBaseline);
          } else if (condition === "newTab") {
            if (!openedTabId) {
              for (const entry of realTabs()) {
                const id = idForTab(entry);
                if (!startTabIds.has(id)) { openedTabId = id; break; }
              }
            }
            matched = openedTabId.length > 0;
          } else if (condition === "tabClosed") {
            if (!closedTab) {
              closedTab = !realTabs().some((entry) => idForTab(entry) === tabId);
            }
            matched = closedTab;
          } else if (condition === "dialog") {
            matched = dialogSeq > dialogBaseline;
          }
          waitedMs = Date.now() - started;
          if (matched || waitedMs >= timeoutMs) break;
          const remaining = Math.min(pollMs, timeoutMs - waitedMs);
          if (watchingTabs || condition === "dialog") await sleepOrWake(remaining);
          else await sleep(remaining);
        }

        const finalDocumentId = tab.isConnected ? documentIdForTab(tab) : "";
        const finalUrl = tab.isConnected ? tabUrl(tab) : "";
        const finalAllowed = isHttpUrl(finalUrl) && isUrlAllowed(finalUrl, domains);
        let limitation: string | undefined;
        if (!matched) {
          if (lastError && (pageCondition || condition === "document")) {
            limitation = `The document could not be inspected after ${waitedMs} ms: ${lastError}`;
          } else if (condition === "document") {
            limitation = documentBaseline
              ? `The document identity did not ${documentChangedWait ? "change" : "match"} within ${waitedMs} ms.`
              : `The document identity was not available after ${waitedMs} ms.`;
          } else if (condition === "newTab") limitation = `No new tab opened within ${waitedMs} ms.`;
          else if (condition === "tabClosed") limitation = `The tab was still open after ${waitedMs} ms.`;
          else if (condition === "dialog") limitation = `No browser dialog was observed within ${waitedMs} ms.`;
          else limitation = `The condition did not hold within ${waitedMs} ms.`;
        } else if (condition === "tabClosed") {
          limitation = "The tab closed during the wait; its final page state was not read.";
        }
        return {
          matched, waitedMs, condition, until, query, tabId,
          url: finalAllowed ? finalUrl : "", title: finalAllowed ? tabTitle(tab) : "",
          ...(condition === "selector" ? { state } : {}),
          ...(finalDocumentId ? { documentId: finalDocumentId } : {}),
          ...(openedTabId ? { newTabId: openedTabId } : {}),
          ...(framePath.length ? {
            framePath,
            frameUrl: finalAllowed ? currentFrameUrl(tab, framePath) ?? null : null,
          } : {}),
          ...(limitation ? { limitation } : {}),
        };
      } finally {
        if (watchingTabs && container?.removeEventListener) {
          container.removeEventListener("TabOpen", onOpen);
          container.removeEventListener("TabClose", onClose);
        }
        dialogWaiters.delete(dialogWaiter);
      }
    },

    "tabs.findText": async (params: any): Promise<TextSearchResult> => {
      const tabId = String(params?.tabId ?? "");
      const query = typeof params?.query === "string" ? params.query.trim() : "";
      if (!tabId) throw new OpsError("no_tab", "Provide the tabId to search.");
      if (!query) throw new OpsError("invalid_query", "Provide the text to find.");
      if (query.length > 2_000) throw new OpsError("query_too_large", "Refusing to search for more than 2,000 characters.");
      const [tab] = resolveTabs([tabId]);
      const listedUrl = tabUrl(tab);
      const listedTitle = tabTitle(tab);
      const failed = (code: EvidenceErrorCode, message: string): TextSearchResult => ({
        ok: false, tabId, url: listedUrl, title: listedTitle, query,
        matches: [], totalMatches: 0, truncated: false, error: { code, message },
      });
      if (!isHttpUrl(listedUrl)) return failed(isPrivilegedUrl(listedUrl) ? "PRIVILEGED_PAGE" : "UNSUPPORTED_PAGE", "Text search only inspects http(s) pages.");
      if (isPdfTab(tab)) return failed("UNSUPPORTED_PAGE", "PDF documents expose no HTML text.");
      let snapshot: EvidenceIndexLike | null = null;
      try {
        snapshot = coerceEvidenceIndex(
          await execute(pageActor(tab), evidenceIndexScript({ maxChars: EVIDENCE_MAX_TEXT }), [], 15_000)
        ) as EvidenceIndexLike | null;
      } catch (error) {
        const err = error as Error & { code?: string };
        if (err.code === "actor_unavailable") return failed("ACTOR_UNAVAILABLE", err.message);
        if (err.code === "tab_not_loaded") return failed("PAGE_STILL_LOADING", err.message);
        return failed("PAGE_NOT_FOUND", `Could not read the page in tab "${listedTitle}".`);
      }
      if (!snapshot) return failed("PAGE_NOT_FOUND", `The tab "${listedTitle}" did not return readable content.`);
      if (snapshot.readyState === "loading") return failed("PAGE_STILL_LOADING", "The page is still loading.");
      if (snapshot.contentType && !/html|xml/i.test(snapshot.contentType)) return failed("UNSUPPORTED_PAGE", `The page is served as ${snapshot.contentType}.`);
      const outcome = findLiteralMatches(snapshot.text, {
        query,
        caseSensitive: params?.caseSensitive === true,
        maxMatches: params?.maxMatches,
        contextChars: params?.contextChars,
      });
      const limitations: string[] = [];
      if (snapshot.truncated) limitations.push(`Only the first ${snapshot.text.length} characters of the page were searched.`);
      if (outcome.totalMatches > outcome.matches.length) limitations.push(`Showing ${outcome.matches.length} of ${outcome.totalMatches} matches.`);
      if (outcome.scanStopped) limitations.push("The page contains more matches than the scan limit, so the total is a lower bound.");
      return {
        ok: true, tabId,
        url: isHttpUrl(snapshot.url) ? snapshot.url : listedUrl,
        title: snapshot.title || listedTitle,
        query,
        matches: outcome.matches,
        totalMatches: outcome.totalMatches,
        truncated: snapshot.truncated === true || outcome.scanStopped === true || outcome.totalMatches > outcome.matches.length,
        ...(limitations.length ? { limitation: limitations.join(" ") } : {}),
      };
    },

    "tabs.evidence": async (params: any): Promise<EvidenceOpResult> => {
      const tabId = String(params?.tabId ?? "");
      const quote = typeof params?.quote === "string" ? params.quote.replace(/\r\n?/g, "\n").trim() : "";
      if (!tabId) throw new OpsError("no_tab", "Provide the tabId that holds the evidence.");
      if (!quote) throw new OpsError("invalid_quote", "Provide the quote to locate.");
      if (quote.length > 20_000) throw new OpsError("quote_too_large", "Refusing to search for a quote longer than 20,000 characters.");
      return serializeTab(tabId, async () => {
        const [tab] = resolveTabs([tabId]);
        const listedUrl = tabUrl(tab);
        const listedTitle = tabTitle(tab);
        const failed = (code: EvidenceErrorCode, message: string): EvidenceOpResult => ({
          ok: false, tabId, url: listedUrl, title: listedTitle, error: { code, message },
        });
        if (!isHttpUrl(listedUrl)) return failed(isPrivilegedUrl(listedUrl) ? "PRIVILEGED_PAGE" : "UNSUPPORTED_PAGE", "Evidence Mode only inspects http(s) pages.");
        if (isPdfTab(tab)) return failed("UNSUPPORTED_PAGE", "PDF documents expose no HTML text.");

        const deadline = Date.now() + EVIDENCE_WAIT_MS;
        let state: EvidenceStateLike | null = null;
        let lastError: (Error & { code?: string }) | null = null;
        while (Date.now() < deadline) {
          try {
            state = coerceEvidenceState(await execute(pageActor(tab), evidenceStateScript(), [], 5_000)) as EvidenceStateLike | null;
            lastError = null;
          } catch (error) {
            state = null;
            lastError = error as Error & { code?: string };
          }
          if (state && isHttpUrl(state.url) && state.readyState && state.readyState !== "loading") break;
          await sleep(EVIDENCE_POLL_MS);
        }
        if (!state) {
          if (lastError?.code === "actor_unavailable") return failed("ACTOR_UNAVAILABLE", lastError.message);
          return failed("PAGE_NOT_FOUND", `Could not reach the page in tab "${listedTitle}".`);
        }
        if (!state.readyState || state.readyState === "loading") {
          return failed("PAGE_STILL_LOADING", `The page "${state.title || listedTitle}" is still loading.`);
        }
        if (!isHttpUrl(state.url)) return failed(isPrivilegedUrl(state.url) ? "PRIVILEGED_PAGE" : "UNSUPPORTED_PAGE", `The tab ended up on ${state.url || "an unsupported page"}.`);
        if (state.contentType && !/html|xml/i.test(state.contentType)) return failed("UNSUPPORTED_PAGE", `The page is served as ${state.contentType}.`);
        await sleep(EVIDENCE_SETTLE_MS);

        const context = typeof params?.context === "string" ? params.context : undefined;
        const minConfidence = typeof params?.minConfidence === "number" && Number.isFinite(params.minConfidence)
          ? params.minConfidence : undefined;
        const highlightMs = clamp(params?.highlightMs ?? EVIDENCE_HIGHLIGHT_MS, 1_000, 120_000);
        const scroll = params?.scroll !== false;
        let current: EvidenceIndexLike | null = null;
        try {
          current = coerceEvidenceIndex(
            await execute(pageActor(tab), evidenceIndexScript({ maxChars: EVIDENCE_MAX_TEXT }), [], 15_000)
          ) as EvidenceIndexLike | null;
        } catch (error) {
          if ((error as Error & { code?: string }).code === "actor_unavailable") return failed("ACTOR_UNAVAILABLE", (error as Error).message);
          return failed("PAGE_NOT_FOUND", `Could not read the page in tab "${state.title || listedTitle}".`);
        }
        if (!current) return failed("PAGE_NOT_FOUND", `The tab "${state.title || listedTitle}" did not return readable content.`);
        if (current.readyState === "loading") return failed("PAGE_STILL_LOADING", "The page is still loading.");
        if (current.contentType && !/html|xml/i.test(current.contentType)) return failed("UNSUPPORTED_PAGE", `The page is served as ${current.contentType}.`);
        const base = {
          tabId,
          url: isHttpUrl(current.url) ? current.url : state.url,
          title: current.title || state.title || listedTitle,
        };
        if (!current.text.trim()) return {
          ...base, ok: false,
          error: { code: "QUOTE_NOT_FOUND" as const, message: "The page exposes no readable text to search." },
        };

        const marker = createMarker();
        for (let attempt = 0; attempt < EVIDENCE_MAX_ATTEMPTS; attempt += 1) {
          const match = findEvidenceQuote(current.text, {
            quote,
            ...(context ? { context } : {}),
            ...(minConfidence !== undefined ? { minConfidence } : {}),
          }) as {
            ok: boolean; method?: any; confidence?: number; start: number; end: number;
            matchedQuote?: string; occurrences: number; ambiguous?: boolean;
            errorCode?: string; message?: string; occurrencesTruncated?: boolean;
          };
          if (!match.ok) {
            if (match.errorCode === "AMBIGUOUS_MATCH" || match.ambiguous === true) {
              return {
                ...base, ok: false, occurrences: match.occurrences,
                error: { code: "AMBIGUOUS_MATCH", message: match.message ?? "Several passages matched the quote." },
                limitation: `${match.occurrences} occurrences matched; add surrounding context. No highlight was added.`,
              };
            }
            if (match.errorCode === "LOW_MATCH_CONFIDENCE") {
              const confidence = Number(match.confidence ?? 0);
              return {
                ...base, ok: false, confidence,
                error: { code: "LOW_MATCH_CONFIDENCE", message: match.message ?? "The closest passage scored too low." },
                limitation: `The closest passage scored ${confidence.toFixed(3)} against the threshold. No highlight was added.`,
              };
            }
            return {
              ...base, ok: false,
              error: { code: "QUOTE_NOT_FOUND", message: match.message ?? "The quote was not found in this page." },
              ...(current.truncated ? { limitation: `Only the first ${current.text.length} characters were searched.` } : {}),
            };
          }
          const candidate = {
            start: match.start,
            end: match.end,
            method: match.method ?? "exact",
            confidence: Number(match.confidence ?? 1),
            occurrences: match.occurrences,
          };
          const expectedText = match.matchedQuote || current.text.slice(candidate.start, candidate.end);
          let report: HighlightLike | null = null;
          let scriptFailed = false;
          try {
            report = coerceEvidenceHighlight(await execute(pageActor(tab), evidenceHighlightScript({
              start: candidate.start, end: candidate.end, expectedText,
              ttlMs: highlightMs, scroll, marker, clearMarkers: markersFor(tabId),
            }), [], 15_000)) as HighlightLike | null;
          } catch (error) {
            scriptFailed = true;
            report = {
              ok: false, stale: false, highlighted: false, scrolled: false, inView: false,
              rects: 0, scrollY: 0, reason: String((error as Error)?.message ?? error).slice(0, 200),
            };
          }
          if (report?.stale) {
            await sleep(EVIDENCE_POLL_MS);
            try {
              const refreshed = coerceEvidenceIndex(
                await execute(pageActor(tab), evidenceIndexScript({ maxChars: EVIDENCE_MAX_TEXT }), [], 15_000)
              ) as EvidenceIndexLike | null;
              if (refreshed) {
                current = refreshed;
                base.url = isHttpUrl(refreshed.url) ? refreshed.url : base.url;
                base.title = refreshed.title || base.title;
              }
            } catch { /* Keep the previous snapshot. */ }
            continue;
          }
          if (!report?.highlighted) {
            if (!scriptFailed) rememberMarkers(tabId, []);
            return {
              ...base, ok: false, matchedQuote: expectedText, matchMethod: candidate.method,
              confidence: candidate.confidence, occurrences: candidate.occurrences,
              scrolled: false, highlighted: false, verified: false,
              limitation: "The passage has no visible pixels in the page, so no highlight was added.",
              error: { code: "HIGHLIGHT_FAILED", message: "The matched passage is hidden or has no visible area." },
            };
          }
          rememberMarkers(tabId, [marker]);
          const limitations: string[] = [];
          if (candidate.method === "normalized" && candidate.confidence < 0.99) {
            limitations.push("The quote matched after Unicode normalization, so wording differs slightly from the page.");
          }
          if (candidate.method === "fuzzy") {
            limitations.push("Fuzzy match: the page wording differs from the quote and should be checked.");
          }
          if (!report.inView) limitations.push("The passage is outside the visible viewport.");
          if (current.truncated) limitations.push(`Only the first ${current.text.length} characters were searched.`);
          return {
            ...base, ok: true,
            verified: candidate.method !== "fuzzy" && report.inView,
            matchedQuote: expectedText, matchMethod: candidate.method,
            confidence: candidate.confidence, occurrences: candidate.occurrences,
            scrolled: scroll ? report.scrolled : false, highlighted: true,
            ...(limitations.length ? { limitation: limitations.join(" ") } : {}),
          };
        }
        return {
          ...base, ok: false,
          limitation: "The page kept changing while Zen MCP located the passage, so no highlight was added.",
          error: { code: "HIGHLIGHT_FAILED", message: "The page changed before the passage could be marked. Try again once it settles." },
        };
      });
    },

    "tabs.evidenceClear": async (params: any): Promise<EvidenceClearResult> => {
      const tabId = String(params?.tabId ?? "");
      if (!tabId) throw new OpsError("no_tab", "Provide the tabId whose marks to clear.");
      return serializeTab(tabId, async () => {
        const [tab] = resolveTabs([tabId]);
        const markers = markersFor(tabId);
        if (!markers.length) return { tabId, removed: 0 };
        let removed = 0;
        for (const marker of markers) {
          try {
            const report = coerceEvidenceClear(
              await execute(pageActor(tab), evidenceClearScript(marker), [], 10_000)
            );
            removed += Number(report?.removed ?? 0) || 0;
          } catch { /* A stale marker may no longer exist in the page. */ }
        }
        rememberMarkers(tabId, []);
        return { tabId, removed };
      });
    },

    "folders.list": () => ({ folders: collectFolders().map(folderInfo) }),

    "folders.create": async (params: any) => {
      const label = String(params?.label ?? "").trim();
      if (!label) throw new OpsError("invalid_name", "Folder name cannot be empty");
      const tabs = Array.isArray(params.tabIds) ? resolveTabs(params.tabIds) : [];
      if (tabs.some((tab: any) => tab.group)) throw new OpsError("tab_already_grouped", "One or more tabs already belong to a folder or split view.");
      let workspaceId: string | null = params.space ? requireSpace(params.space, "create a folder").uuid : null;
      if (!workspaceId && tabs.length) workspaceId = tabs[0].getAttribute("zen-workspace-id") || null;
      if (!workspaceId) workspaceId = win.gZenWorkspaces.activeWorkspace;
      if (tabs.some((tab: any) => tab.getAttribute("zen-workspace-id") !== workspaceId)) {
        throw new OpsError("mixed_spaces", "All tabs in a folder must belong to the same space");
      }
      const folder = win.gZenFolders.createFolder(tabs, {
        workspaceId, label, collapsed: params.collapsed === true,
      });
      await sleep(160);
      return { created: true, folder: folderInfo(folder) };
    },

    "folders.addTabs": (params: any) => {
      const folder = collectFolders().find((f: any) => f.id === params?.folderId);
      if (!folder) throw new OpsError("folder_not_found", `No folder matches "${params?.folderId}"`);
      const tabs = resolveTabs(Array.isArray(params.tabIds) ? params.tabIds : []);
      if (!tabs.length) throw new OpsError("no_tabs", "Provide tabIds to add");
      if (tabs.some((tab: any) => tab.group)) throw new OpsError("tab_already_grouped", "One or more tabs already belong to a folder or split view");
      const folderSpace = folder.getAttribute("zen-workspace-id");
      if (tabs.some((tab: any) => tab.getAttribute("zen-workspace-id") !== folderSpace)) {
        throw new OpsError("mixed_spaces", "Tabs must be in the same space as the folder");
      }
      for (const tab of tabs) if (!tab.pinned) win.gBrowser.pinTab(tab);
      folder.addTabs(tabs);
      return { folder: folderInfo(folder), added: tabs.length };
    },

    "essentials.add": async (params: any) => {
      const manager = win.gZenPinnedTabManager;
      if (!manager || typeof manager.addToEssentials !== "function") {
        throw new OpsError("essentials_unavailable", "Zen essentials are not available in this window.");
      }
      const tabs = resolveTabs(Array.isArray(params?.tabIds) ? params.tabIds : []);
      if (!tabs.length) throw new OpsError("no_tabs", "Provide tabIds to add to essentials");
      const changed: string[] = [];
      const tracked: Array<{ tab: any; tabId: string; capture: EssentialsCapture }> = [];
      for (const tab of tabs) {
        if (isEssential(tab)) continue;
        const tabId = idForTab(tab);
        const capture = captureEssentialsState(essentialsCaptures, tabId, tab);
        const added = await Promise.resolve(manager.addToEssentials(tab));
        if (added === true) {
          changed.push(tabId);
          tracked.push({ tab, tabId, capture });
        }
      }
      const notes = new Map<string, Set<string>>();
      const note = (tabId: string, reasons: string[]): void => {
        if (!reasons.length) return;
        const existing = notes.get(tabId) ?? new Set<string>();
        for (const reason of reasons) existing.add(reason);
        notes.set(tabId, existing);
      };
      let restored = 0;
      if (tracked.length) {
        await sleep(LAYOUT_SETTLE_MS);
        for (const entry of tracked) {
          const report = restoreEssentialsState(entry.capture, entry.tab, essentialsRestoreHost(), { restorePinned: false });
          if (report.applied && report.spaceRestored) restored += 1;
          note(entry.tabId, report.reasons);
        }
        await sleep(LAYOUT_SETTLE_MS);
        for (const entry of tracked) {
          note(entry.tabId, verifyEssentialsState(entry.capture, entry.tab, { restorePinned: false }).reasons);
        }
      }
      const limitation = describeEssentialsLimitations(notes);
      return { tabIds: changed, changed: changed.length, ...(tracked.length ? { restored } : {}), ...(limitation ? { limitation } : {}) };
    },

    "essentials.remove": async (params: any) => {
      const manager = win.gZenPinnedTabManager;
      if (!manager || typeof manager.removeEssentials !== "function") {
        throw new OpsError("essentials_unavailable", "Zen essentials are not available in this window.");
      }
      const tabs = resolveTabs(Array.isArray(params?.tabIds) ? params.tabIds : []);
      if (!tabs.length) throw new OpsError("no_tabs", "Provide tabIds to remove from essentials");
      const changed: string[] = [];
      const tracked: Array<{ tab: any; tabId: string; capture: EssentialsCapture | undefined }> = [];
      for (const tab of tabs) {
        if (!isEssential(tab)) continue;
        const tabId = idForTab(tab);
        const removed = await Promise.resolve(manager.removeEssentials(tab));
        if (removed !== false) {
          changed.push(tabId);
          tracked.push({ tab, tabId, capture: essentialsCaptures.take(tabId) });
        }
      }
      const notes = new Map<string, Set<string>>();
      const note = (tabId: string, reasons: string[]): void => {
        if (!reasons.length) return;
        const existing = notes.get(tabId) ?? new Set<string>();
        for (const reason of reasons) existing.add(reason);
        notes.set(tabId, existing);
      };
      let restored = 0;
      const withCapture = tracked.filter(
        (entry): entry is typeof entry & { capture: EssentialsCapture } => entry.capture !== undefined
      );
      if (withCapture.length) {
        await sleep(LAYOUT_SETTLE_MS);
        for (const entry of withCapture) {
          const report = restoreEssentialsState(entry.capture, entry.tab, essentialsRestoreHost());
          if (report.applied && report.spaceRestored && report.pinnedRestored) restored += 1;
          note(entry.tabId, report.reasons);
        }
        await sleep(LAYOUT_SETTLE_MS);
        for (const entry of withCapture) note(entry.tabId, verifyEssentialsState(entry.capture, entry.tab).reasons);
      }
      const limitation = describeEssentialsLimitations(notes);
      return { tabIds: changed, changed: changed.length, ...(withCapture.length ? { restored } : {}), ...(limitation ? { limitation } : {}) };
    },

    "containers.list": () => ({ containers: containerIdentities() }),

    "glance.open": async (params: any) => {
      const sourceTab = params?.tabId ? resolveTabs([String(params.tabId)])[0] : null;
      let rawUrl: string;
      let userContextId: number | undefined;
      if (sourceTab) {
        rawUrl = tabUrl(sourceTab);
        if (!rawUrl) throw new OpsError("invalid_url", `The tab "${tabTitle(sourceTab)}" has no URL to preview.`);
        const id = containerIdOf(sourceTab);
        userContextId = id > 0 ? id : undefined;
      } else {
        rawUrl = normalizeUrl(String(params?.url ?? ""));
        if (params?.container !== undefined && params?.container !== null && params?.container !== "") {
          const container = resolveContainer(params.container);
          userContextId = container.userContextId > 0 ? container.userContextId : undefined;
        }
      }
      const preview = normalizeWebUrl(rawUrl);
      if (!preview) throw new OpsError("invalid_url", `Refusing to preview "${rawUrl}". Glance only opens http(s) URLs.`);
      const url = preview.href;
      const domains = Array.isArray(params?.allowedDomains) ? params.allowedDomains.filter((d: unknown) => typeof d === "string") : [];
      if (!isUrlAllowed(url, domains)) throw new OpsError("domain_not_allowed", `Refusing to preview ${preview.hostname}, which is outside the domain allowlist.`);
      const manager = win.gZenGlanceManager;
      if (!manager || typeof manager.openGlance !== "function") {
        return { opened: false, url, mode: "none", message: "Zen glance is not available in this window." };
      }
      let triggeringPrincipal: unknown;
      try {
        triggeringPrincipal = Services.scriptSecurityManager.createContentPrincipal(
          Services.io.newURI(url), userContextId ? { userContextId } : {}
        );
      } catch (error) {
        throw new OpsError("glance_failed", `Could not prepare the preview: ${String((error as Error)?.message ?? error)}`);
      }
      const width = clamp(Number(params?.width ?? 960), 240, 4_096);
      const height = clamp(Number(params?.height ?? 720), 240, 4_096);
      let result: any = null;
      try {
        result = await manager.openGlance({
          url, clientX: 200, clientY: 120, width, height, triggeringPrincipal,
          ...(userContextId ? { userContextId } : {}),
        });
      } catch (error) {
        throw new OpsError("glance_failed", `Could not open glance: ${String((error as Error)?.message ?? error)}`);
      }
      if (!result) return { opened: false, url, mode: "none", message: "Zen declined to open the glance view." };
      const closePreview = (): void => {
        try { manager.closeGlance?.({ noAnimation: true, skipPermitUnload: true }); } catch { /* best effort */ }
      };
      const glanceUrl = (): string | undefined => {
        const spec = result?.linkedBrowser?.currentURI?.spec;
        return typeof spec === "string" && spec && spec !== "about:blank" ? spec : undefined;
      };
      let loadedUrl = glanceUrl();
      const deadline = Date.now() + GLANCE_SETTLE_MS;
      while (!loadedUrl && Date.now() < deadline) {
        await sleep(50);
        loadedUrl = glanceUrl();
      }
      if (!loadedUrl) {
        closePreview();
        throw new OpsError("glance_failed", "The preview opened but its URL could not be verified, so it was closed.");
      }
      const loaded = normalizeWebUrl(loadedUrl);
      if (!loaded) {
        closePreview();
        throw new OpsError("invalid_url", `The preview loaded "${loadedUrl}", which is not an http(s) URL.`);
      }
      if (!isUrlAllowed(loaded.href, domains)) {
        closePreview();
        throw new OpsError("domain_not_allowed", `The preview redirected to ${loaded.hostname}, which is outside the allowlist, so it was closed.`);
      }
      const browser = result?.linkedBrowser;
      if (browser && typeof browser.addEventListener === "function") {
        const check = (): void => {
          const current = glanceUrl();
          if (!current) return;
          const parsed = normalizeWebUrl(current);
          if (parsed && isUrlAllowed(parsed.href, domains)) return;
          try { browser.removeEventListener?.("locationchange", check, true); } catch { /* gone */ }
          closePreview();
        };
        try { browser.addEventListener("locationchange", check, true); } catch { /* final URL was checked above */ }
      }
      return { opened: true, url: loaded.href, mode: "glance" };
    },

    "split.open": async (params: any) => {
      const ids = [...new Set(Array.isArray(params?.tabIds) ? params.tabIds : [])] as string[];
      if (ids.length < 2 || ids.length > 4) throw new OpsError("invalid_split", "A split view needs between 2 and 4 tabs.");
      const tabs = resolveTabs(ids);
      const active = win.gZenWorkspaces?.activeWorkspace ?? null;
      for (const tab of tabs) {
        if ((tab.getAttribute("zen-workspace-id") || null) !== active) throw new OpsError("mixed_spaces", "Split views can only contain tabs from the active space.");
        if (isEssential(tab)) throw new OpsError("essential_tab", `The tab "${tabTitle(tab)}" is an essential and cannot join a split view.`);
      }
      const splitter = win.gZenViewSplitter;
      if (!splitter || typeof splitter.splitTabs !== "function") throw new OpsError("split_unavailable", "Zen split views are not available in this window.");
      let existingGroup: any = null;
      for (const tab of tabs) {
        const group = tab.group && !folderOf(tab) ? tab.group : null;
        if (!group) continue;
        if (existingGroup && group !== existingGroup) throw new OpsError("tab_already_split", "One or more tabs already belong to a different split view.");
        existingGroup = group;
      }
      if (existingGroup && tabs.some((tab: any) => tab.group !== existingGroup)) {
        throw new OpsError("tab_already_split", "One or more tabs already belong to a different split view.");
      }
      const gridType = ["grid", "hsep", "vsep"].includes(String(params?.gridType)) ? String(params.gridType) : "grid";
      const created = await Promise.resolve(splitter.splitTabs(tabs, gridType, params?.activate === false ? -1 : 0));
      if (!created) throw new OpsError("split_failed", "Zen did not create the split view.");
      return { split: true, tabIds: tabs.map((tab: any) => idForTab(tab)), gridType };
    },

    "split.close": async (params: any) => {
      const splitter = win.gZenViewSplitter;
      if (!splitter) throw new OpsError("split_unavailable", "Zen split views are not available in this window.");
      const tab = params?.tabId ? resolveTabs([String(params.tabId)])[0] : win.gBrowser?.selectedTab ?? null;
      if (!tab) throw new OpsError("tab_not_found", "No tab is selected to unsplit.");
      const beforeSnapshot = collectTabs().map((candidate: any) => ({
        id: idForTab(candidate), url: tabUrl(candidate), title: tabTitle(candidate),
      }));
      const beforeIds = beforeSnapshot.map((entry: any) => entry.id);
      const beforeById = new Map(beforeSnapshot.map((entry: any) => [entry.id, entry]));
      const groups: any[] = Array.isArray(splitter._data) ? splitter._data : [];
      let index = groups.findIndex((group: any) => Array.isArray(group?.tabs) && group.tabs.includes(tab));
      let groupTabs: any[] = [];
      if (index >= 0) {
        groupTabs = groups[index].tabs.filter((member: any) => member?.isConnected && !member.closing);
      } else if (tab.splitView) {
        groupTabs = [tab];
      }
      const groupIds = groupTabs.map((member: any) => idForTab(member));
      const groupUrls = [...new Set(groupTabs.map((member: any) => tabUrl(member)).filter(Boolean))];
      if (!groupIds.length) {
        return { unsplit: false, tabIds: [], limitation: `No split view contains the tab "${tabTitle(tab)}".` };
      }
      const targetIsCurrent = win.gBrowser?.selectedTab === tab || !!tab.selected;
      let cleared = false;
      let usedCurrentView = false;
      if (typeof splitter.unsplitCurrentView === "function" && targetIsCurrent) {
        try {
          win.gBrowser.selectedTab = tab;
          splitter.unsplitCurrentView();
          usedCurrentView = true;
        } catch { /* verify below */ }
        cleared = await waitForSplitGone(groupTabs);
      }
      if (!cleared && typeof splitter.removeGroup === "function") {
        const currentGroups: any[] = Array.isArray(splitter._data) ? splitter._data : [];
        const currentIndex = currentGroups.findIndex((group: any) => Array.isArray(group?.tabs) && group.tabs.includes(tab));
        if (currentIndex >= 0) {
          try {
            splitter.removeGroup(currentIndex);
            cleared = await waitForSplitGone(groupTabs);
          } catch { /* try the last path */ }
        }
      }
      if (!cleared && !usedCurrentView && typeof splitter.unsplitCurrentView === "function") {
        try {
          win.gBrowser.selectedTab = tab;
          splitter.unsplitCurrentView();
        } catch { /* report failure below */ }
        cleared = await waitForSplitGone(groupTabs);
      }
      if (!cleared) throw new OpsError("split_close_failed", `Zen did not close the split view for "${tabTitle(tab)}".`);
      await sleep(LAYOUT_SETTLE_MS);
      const candidates = collectTabs().map((candidate: any) => ({
        id: idForTab(candidate), url: tabUrl(candidate), title: tabTitle(candidate),
        empty: candidate.hasAttribute("zen-empty-tab"), windowId,
      }));
      const plan = planSplitCleanup({ beforeTabIds: beforeIds, groupUrls, windowId }, candidates);
      const limitations: string[] = [];
      if (plan.limitation) limitations.push(plan.limitation);
      let closedResidue = 0;
      for (const residueId of plan.closeTabIds) {
        const residue = tabsById.get(residueId);
        if (!residue || !residue.isConnected || residue.closing) continue;
        try {
          await Promise.resolve(win.gBrowser.removeTab(residue));
          closedResidue += 1;
        } catch {
          limitations.push(`Could not close the leftover tab "${tabTitle(residue)}" (${residueId}).`);
        }
      }
      if (plan.closeTabIds.length) {
        await sleep(LAYOUT_SETTLE_MS);
        const stillOpen = plan.closeTabIds.filter((residueId: string) => {
          const residue = tabsById.get(residueId);
          return residue && residue.isConnected && !residue.closing;
        });
        if (stillOpen.length) limitations.push(`Zen did not close ${stillOpen.length} leftover tab(s): ${stillOpen.join(", ")}.`);
      }
      const missing = groupIds.filter((groupId: string) => {
        const member = tabsById.get(groupId);
        return !member || !member.isConnected || member.closing;
      });
      if (missing.length) {
        const listed = missing.map((groupId: string) => {
          const entry = beforeById.get(groupId);
          return entry ? `"${entry.title}" (${groupId})` : groupId;
        }).join(", ");
        limitations.push(`Zen closed ${missing.length} tab(s) from the split: ${listed}. Reopen them if needed.`);
      }
      return {
        unsplit: true, tabIds: groupIds, closedResidue,
        ...(limitations.length ? { limitation: limitations.join(" ") } : {}),
      };
    },

    "history.search": async (params: any) => {
      const limit = clamp(params?.limit ?? 25, 1, MAX_RESULTS);
      const query = String(params?.query ?? "").trim();
      const domainFilter = String(params?.domain ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
      const sinceDays = Number(params?.sinceDays ?? 0);
      const sinceMicros = sinceDays > 0 ? (Date.now() - sinceDays * 86_400_000) * 1_000 : 0;
      const db = await getPlaces().promiseDBConnection();
      const rows = await db.executeCached(
        `SELECT p.url AS url, p.title AS title, p.last_visit_date AS last_visit_date, p.visit_count AS visit_count
           FROM moz_places p
          WHERE p.hidden = 0 AND p.last_visit_date IS NOT NULL AND p.last_visit_date >= :since
            AND (:query = '' OR p.url LIKE :pattern ESCAPE '\\' OR p.title LIKE :pattern ESCAPE '\\')
          ORDER BY p.last_visit_date DESC LIMIT :limit`,
        { query, pattern: likePattern(query), since: sinceMicros, limit: HISTORY_SCAN_LIMIT }
      );
      const matched = (domain: string): boolean =>
        !domainFilter || domain === domainFilter || domain.endsWith(`.${domainFilter}`);
      const entries: any[] = [];
      for (const row of rows) {
        const url = String(row.getResultByName("url") ?? "");
        if (!url) continue;
        const domain = hostnameOf(url);
        if (!matched(domain)) continue;
        entries.push({
          title: row.getResultByName("title") ?? "",
          url,
          lastVisited: toIso(row.getResultByName("last_visit_date")),
          visitCount: Number(row.getResultByName("visit_count") ?? 0),
          domain,
        });
        if (entries.length >= limit) break;
      }
      const result: Record<string, unknown> = { entries };
      if (params?.groupByDomain) {
        const groups = new Map<string, any[]>();
        for (const entry of entries) {
          const key = entry.domain || "(other)";
          const list = groups.get(key);
          if (list) list.push(entry);
          else groups.set(key, [entry]);
        }
        result.groups = [...groups.entries()]
          .map(([domain, list]) => ({ domain, entries: list }))
          .sort((a, b) => b.entries.length - a.entries.length || a.domain.localeCompare(b.domain));
      }
      return result;
    },

    "bookmarks.search": async (params: any) => {
      const limit = clamp(params?.limit ?? 25, 1, MAX_RESULTS);
      const query = String(params?.query ?? "").trim();
      const db = await getPlaces().promiseDBConnection();
      const rows = await db.executeCached(
        `SELECT b.title AS title, p.url AS url, b.dateAdded AS date_added
           FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk
          WHERE b.type = 1 AND p.hidden = 0
            AND (:query = '' OR p.url LIKE :pattern ESCAPE '\\' OR b.title LIKE :pattern ESCAPE '\\')
          ORDER BY b.dateAdded DESC LIMIT :limit`,
        { query, pattern: likePattern(query), limit }
      );
      const seen = new Set<string>();
      const entries: any[] = [];
      for (const row of rows) {
        const url = row.getResultByName("url");
        if (!url || seen.has(url)) continue;
        seen.add(url);
        entries.push({
          title: row.getResultByName("title") || url,
          url,
          dateAdded: toIso(row.getResultByName("date_added")),
        });
      }
      return { entries };
    },

    "history.recentlyClosed": () => {
      const store = win.SessionStore;
      if (!store || typeof store.getClosedTabData !== "function") return { entries: [] };
      let raw: unknown;
      try {
        raw = store.getClosedTabData({
          sourceWindow: win, closedTabsFromAllWindows: false, closedTabsFromClosedWindows: false,
        });
      } catch {
        try { raw = store.getClosedTabData(win); } catch { return { entries: [] }; }
      }
      if (typeof raw === "string") {
        try { raw = JSON.parse(raw); } catch { return { entries: [] }; }
      }
      const closed: any[] = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.closedTabs) ? (raw as any).closedTabs : [];
      const entries: any[] = [];
      const pushState = (state: any, fallbackClosedAt: unknown): void => {
        if (!state || typeof state !== "object") return;
        const stateEntries = Array.isArray(state.entries) ? state.entries : null;
        let entry: any = null;
        if (stateEntries?.length) {
          const index = Number.isInteger(state.index) ? state.index : -1;
          entry = stateEntries[index] ?? stateEntries[0] ?? null;
        } else if (typeof state.url === "string") {
          entry = state;
        }
        if (!entry) return;
        const url = String(entry.url ?? state.url ?? "");
        if (!/^https?:/i.test(url)) return;
        const closedAt = Number(state.closedAt ?? fallbackClosedAt);
        entries.push({
          title: String(entry.title || state.title || url),
          url,
          closedAt: Number.isFinite(closedAt) && closedAt > 0 ? new Date(closedAt).toISOString() : null,
        });
      };
      for (const item of closed) {
        if (Array.isArray(item?.tabs)) {
          for (const tab of item.tabs) pushState(tab, item?.closedAt);
        } else {
          pushState(item?.state ?? item, item?.closedAt);
        }
      }
      return { entries: entries.slice(0, 50) };
    },

    "clipboard.write": async (params: any) => {
      const text = params?.text;
      if (typeof text !== "string") throw new OpsError("invalid_text", "clipboard.write expects a string in `text`.");
      if (text.length > MAX_CLIPBOARD_CHARS) throw new OpsError("text_too_large", "Refusing to copy more than 1 MB of text.");
      let written = false;
      try {
        const helper = Components.classes["@mozilla.org/widget/clipboardhelper;1"].getService(Components.interfaces.nsIClipboardHelper);
        helper.copyString(text);
        written = true;
      } catch { /* Fall through to the async API. */ }
      if (!written) {
        try {
          await win.navigator?.clipboard?.writeText(text);
          written = true;
        } catch (error) {
          throw new OpsError("clipboard_failed", `Could not write to the clipboard: ${String((error as Error)?.message ?? error)}`);
        }
      }
      return { written, length: text.length };
    },
  };

  return {
    dispatch(method: string, params?: unknown): Promise<unknown> {
      const handler = handlers[method];
      if (!handler) {
        return Promise.reject(
          new OpsError("unknown_method", `Unknown bridge method "${method}". Re-launch Zen to update the bridge.`)
        );
      }
      try {
        return Promise.resolve(handler(params));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    tabIdFor: idForTab,
    noteDialogShown,
    tabIds(): string[] {
      pruneTabIds();
      return [...tabsById.keys()];
    },
  };
}
