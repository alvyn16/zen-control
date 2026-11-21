/**
 * The typed contract between the MCP server and the injected browser bridge.
 * All layers import from here; no module defines its own wire types.
 */

export const BRIDGE_PATH = "/bridge";

/* ------------------------------------------------------------------ *
 * UI messages
 * ------------------------------------------------------------------ */

export interface UiOption { label: string; value?: string; description?: string }
export interface UiQuestion {
  id: string; question: string; context?: string; options: UiOption[];
  allowFreeform: boolean; multiSelect: boolean; createdAt: number;
}
export type ActivityTone = "info" | "success" | "warning";
export interface UiActivityAction { id: string; label: string; kind: "space" | "tab"; target: string }
export interface UiActivity {
  id: string; title: string; detail?: string; tone: ActivityTone;
  actions: UiActivityAction[]; autoHideMs: number;
}
export interface UiProgress {
  id: string; title: string; step?: string; detail?: string; progress?: number;
  tone: ActivityTone; startedAt: number; stoppable: boolean; stopRequested?: boolean;
}
export type AnswerStatus = "answered" | "deferred";
export type AskOutcomeStatus = "answered" | "deferred" | "pending" | "unavailable";
export interface UiConsent {
  id: string; title: string; detail: string; allowLabel: string; denyLabel: string;
}
export type BannerState = "pending" | "active" | "paused";
export type UpdateNoticeState = "prompt" | "icon" | "installing" | "installed" | "failed";
export interface UiUpdateNotice {
  state: UpdateNoticeState; currentVersion: string; latestVersion: string; message?: string;
}
export interface UiBanner {
  state: BannerState; text: string; detail?: string; update?: UiUpdateNotice | null;
}

/* ------------------------------------------------------------------ *
 * Wire messages
 * ------------------------------------------------------------------ */

export interface ServerAuthChallenge { type: "auth.challenge"; nonce: string }
export interface BridgeAuthResponse { type: "auth.response"; nonce: string; proof: string }
export interface ServerAuthConfirm { type: "auth.confirm"; nonce: string; proof: string }
export interface BridgeHello {
  type: "hello"; protocol: number; bridgeVersion: string; windowId: string;
  focused: boolean; appVersion: string; platform: string;
}
export interface BridgePong { type: "bridge.pong"; ts: number }
export interface BridgeFocus { type: "bridge.focus"; focused: boolean; ts: number }
export interface BrowserEventMessage { type: "browser.event"; event: BrowserEventPayload }
export interface UiAnswer {
  type: "ui.answer"; id: string; status: AnswerStatus; answer?: string;
  selectedLabels?: string[]; freeform?: boolean;
}
export interface UiActionEvent {
  type: "ui.action"; activityId: string; actionId: string; ok: boolean; error?: string;
}
export interface UiStop { type: "ui.stop"; progressId: string; ts: number }
export interface UiConsentResult { type: "ui.consentResult"; id: string; granted: boolean }
export interface UiBannerAction { type: "ui.bannerAction"; action: "pause" | "resume"; ts: number }
export interface UiUpdateAction { type: "ui.updateAction"; action: "install" | "dismiss" | "expand"; ts: number }
export interface BridgeResponse {
  type: "res"; id: string; ok: boolean; result?: unknown;
  error?: { code?: string; message: string; details?: Record<string, unknown> };
}
export type BridgeToServer =
  | BridgeAuthResponse | BridgeHello | BridgePong | BridgeFocus | BrowserEventMessage
  | UiAnswer | UiActionEvent | UiStop | UiConsentResult | UiBannerAction | UiUpdateAction
  | BridgeResponse | { type: "bridge.error"; message: string };

export interface ServerWelcome { type: "welcome"; protocol: number; serverVersion: string }
export interface ServerPing { type: "server.ping"; ts: number }
export interface AskUiMessage { type: "ui.ask"; question: UiQuestion }
export interface CancelUiMessage { type: "ui.cancel"; id: string }
export interface ActivityUiMessage { type: "ui.activity"; activity: UiActivity }
export interface ProgressUiMessage { type: "ui.progress"; progress: UiProgress | null }
export interface ConsentUiMessage { type: "ui.consent"; consent: UiConsent }
export interface CancelConsentUiMessage { type: "ui.consentCancel"; id: string }
export interface BannerUiMessage { type: "ui.banner"; banner: UiBanner | null }
export interface ShutdownMessage { type: "shutdown"; reason?: string }
export interface BridgeRequest { type: "req"; id: string; method: string; params?: unknown }
export type ServerToBridge =
  | ServerAuthChallenge | ServerAuthConfirm | ServerWelcome | ServerPing | AskUiMessage
  | CancelUiMessage | ActivityUiMessage | ProgressUiMessage | ConsentUiMessage
  | CancelConsentUiMessage | BannerUiMessage | ShutdownMessage | BridgeRequest;

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export const BROWSER_EVENT_KINDS = ["tab", "navigation", "document", "dialog"] as const;
export type BrowserEventKind = (typeof BROWSER_EVENT_KINDS)[number];
export const BROWSER_EVENT_PHASES = [
  "opened", "closed", "selected", "started", "committed", "completed", "failed",
  "redirect", "same_document", "replaced", "shown", "hidden",
] as const;
export type BrowserEventPhase = (typeof BROWSER_EVENT_PHASES)[number];
export const AGENT_EVENT_KINDS = [
  "stop", "pause", "resume", "watch", "question", ...BROWSER_EVENT_KINDS,
] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

export interface AgentEvent {
  id: number; kind: AgentEventKind; at: number; title: string; detail?: string;
  windowId?: string; tabId?: string; watchId?: string; questionId?: string;
  phase?: BrowserEventPhase; url?: string; documentId?: string; source?: "server" | "browser";
}
export interface EventsResult {
  events: AgentEvent[]; cursor: number; stopped: boolean; paused: boolean;
  lastEventAt: number | null; missed: number; oldestCursor: number | null;
  dropped: number; filtered: number;
}
export interface BrowserEventPayload {
  kind: BrowserEventKind; phase: BrowserEventPhase; tabId?: string; url?: string;
  title?: string; detail?: string; documentId?: string; label?: string;
}

/* ------------------------------------------------------------------ *
 * Browser entities
 * ------------------------------------------------------------------ */

export interface Space {
  id: string; name: string; icon: string | null; active: boolean;
  index: number; containerTabId: number;
}
export interface SpaceInfo extends Space { tabCount: number; pinnedCount: number; folderCount: number }
export interface FolderInfo {
  id: string; label: string; spaceId: string; collapsed: boolean;
  parentId: string | null; tabIds: string[]; liveFolder: boolean;
}
export interface TabInfo {
  id: string; windowId: string; spaceId: string | null; spaceName: string | null;
  title: string; url: string; requestedUrl?: string; pinned: boolean; essential: boolean;
  active: boolean; audible: boolean; muted: boolean; loading: boolean;
  folderId: string | null; folderLabel: string | null; index: number;
  lastAccessed?: number | null; containerId?: number | null; splitView?: boolean;
}
export interface HistoryEntry {
  title: string; url: string; lastVisited: string | null; visitCount: number; domain?: string;
}
export interface BookmarkEntry { title: string; url: string; dateAdded: string | null }
export interface HistoryGroup { domain: string; entries: HistoryEntry[] }
export interface ContainerInfo {
  userContextId: number; name: string; icon: string; color: string; public: boolean;
}
export interface BridgeStatus {
  appName: string; appVersion: string; buildId: string; platform: string; profile: string;
  windowId: string; focused: boolean; workspacesEnabled: boolean;
  activeSpaceId: string | null;
  activeTab: { id: string | null; title: string; url: string; spaceId: string | null; folderId: string | null } | null;
  spaces: SpaceInfo[]; tabCount: number; folderCount: number;
}

/* ------------------------------------------------------------------ *
 * Reads and semantics
 * ------------------------------------------------------------------ */

export type ReadFormat =
  | "text" | "markdown" | "links" | "tables" | "metadata" | "outline"
  | "interactive" | "snapshot" | "semantic";
export interface PageLink { text: string; url: string }
export interface PageTable { caption: string | null; headers: string[]; rows: string[][] }
export interface PageHeading { level: number; text: string }
export type PageClassification =
  | "article" | "search-results" | "product" | "listing" | "dashboard"
  | "login" | "form" | "documentation" | "discussion" | "generic";
export type SemanticRegionRole =
  | "banner" | "navigation" | "main" | "complementary" | "contentinfo" | "search"
  | "form" | "article" | "section" | "dialog" | "table" | "list";
export type SemanticCollectionKind = "cards" | "results" | "links" | "items";
export interface SemanticRegion {
  id: string; role: SemanticRegionRole; label?: string | null;
  labelSource?: "aria" | "html" | "heading" | "inferred"; heading?: string | null;
  parent?: string | null; ref?: string | null; controls?: number; links?: number;
  items?: number | null; itemKind?: SemanticCollectionKind | null;
}
export interface SemanticCollection {
  regionId: string; kind: SemanticCollectionKind; count: number;
  sample: Array<{ ref: string; label: string }>;
}
export interface SemanticHeading { level: number; text: string; ref: string | null }
export interface SemanticDialog { ref: string; label: string; modal: boolean }
export interface SemanticCoverage {
  complete: boolean; nodes: number; regions: number; regionsTruncated: boolean;
  controls: number; links: number; headings: number; tables: number; images: number;
  missingAlt: number; shadowRoots: number;
}
export interface SemanticPage {
  classification: PageClassification; confidence: number; signals: string[];
  primaryRegion: string | null; regions: SemanticRegion[]; headings: SemanticHeading[];
  collections: SemanticCollection[]; dialogs: SemanticDialog[];
  coverage: SemanticCoverage; limitations: string[];
}
export interface PageElement {
  ref: string; tag: string; role: string; type: string | null; label: string;
  value?: string | null; placeholder: string | null; href: string | null;
  disabled: boolean; checked: boolean | null; readOnly: boolean; sensitive: boolean;
  editable: boolean; valuePresent?: boolean; autocomplete?: string | null;
  selected?: boolean | null; form?: string | null; framePath?: number[]; frameUrl?: string | null;
}
export interface PageFrame { path: number[]; url: string; name: string }
export interface PageMetadata {
  title: string; description: string | null; canonical: string | null; lang: string | null;
  author: string | null; published: string | null; siteName: string | null;
  image: string | null; og: Record<string, string>; twitter: Record<string, string>;
}
export interface PageReadResult {
  title: string; url: string; selectedText: string; text: string; truncated: boolean;
  length: number; offset: number; nextOffset: number | null; limitation?: string;
  description: string | null; format?: ReadFormat; contentType?: string | null;
  selector?: string | null; markdown?: string; links?: PageLink[]; tables?: PageTable[];
  metadata?: PageMetadata; outline?: PageHeading[]; elements?: PageElement[];
  semantic?: SemanticPage; elementsTruncated?: boolean; snapshotId?: string;
  elementsTotal?: number; snapshotComplete?: boolean; textTruncated?: boolean;
  outlineTruncated?: boolean; framesComplete?: boolean; limitations?: string[];
  framePath?: number[]; frames?: PageFrame[];
}

/* ------------------------------------------------------------------ *
 * Evidence and search
 * ------------------------------------------------------------------ */

export type EvidenceMatchMethod = "exact" | "normalized" | "context" | "fuzzy";
export type EvidenceErrorCode =
  | "PAGE_NOT_FOUND" | "PAGE_STILL_LOADING" | "QUOTE_NOT_FOUND" | "AMBIGUOUS_MATCH"
  | "LOW_MATCH_CONFIDENCE" | "HIGHLIGHT_FAILED" | "PRIVILEGED_PAGE"
  | "ACTOR_UNAVAILABLE" | "UNSUPPORTED_PAGE";
export interface EvidenceFailure { code: EvidenceErrorCode; message: string }
export interface EvidenceShowParams {
  tabId: string; quote: string; context?: string; minConfidence?: number;
  highlightMs?: number; scroll?: boolean;
}
export interface EvidenceOpResult {
  ok: boolean; tabId: string | null; url: string; title: string;
  matchedQuote?: string; matchMethod?: EvidenceMatchMethod; confidence?: number;
  occurrences?: number; scrolled?: boolean; highlighted?: boolean; verified?: boolean;
  limitation?: string; error?: EvidenceFailure;
}
export interface EvidenceClearParams { tabId: string }
export interface EvidenceClearResult { tabId: string; removed: number }
export interface EvidenceShowResult extends EvidenceOpResult {
  tabReused: boolean; focused: boolean; sourceUrl: string; claim?: string;
}
export interface EvidenceClearOutcome {
  cleared: boolean; tabId: string | null; removed: number; error?: EvidenceFailure;
}
export interface EvidenceCitation {
  url: string; quote: string; claim?: string; context?: string;
  sourceTitle?: string; tabId?: string;
}
export interface EvidenceBatchOptions {
  citations: EvidenceCitation[]; focus?: boolean; minConfidence?: number;
  highlightMs?: number; concurrency?: number;
}
export interface EvidenceBatchResult {
  ok: boolean; total: number; matched: number; verified: number; failed: number;
  openedTabs: number; reusedTabs: number; focused: boolean; results: EvidenceShowResult[];
  limitation?: string; error?: EvidenceFailure;
}
export interface TextMatch { start: number; end: number; text: string; excerpt: string }
export interface TextSearchParams {
  tabId: string; query: string; caseSensitive?: boolean; maxMatches?: number; contextChars?: number;
}
export interface TextSearchResult {
  ok: boolean; tabId: string; url: string; title: string; query: string;
  matches: TextMatch[]; totalMatches: number; truncated: boolean;
  limitation?: string; error?: EvidenceFailure;
}
export interface SearchTabsParams {
  query: string; space?: string; tabIds?: string[]; maxTabs?: number;
  maxMatchesPerTab?: number; contextChars?: number; caseSensitive?: boolean;
}
export interface SearchTabsEntry {
  tabId: string; ok: boolean; url: string; title: string; matches: TextMatch[];
  totalMatches: number; truncated: boolean; limitation?: string; error?: EvidenceFailure;
}
export interface SearchTabsResult {
  query: string; tabsSearched: number; tabsMatched: number; totalMatches: number;
  skipped: number; truncated: boolean; results: SearchTabsEntry[];
}
export interface BatchReadParams {
  tabIds: string[]; maxChars?: number; format?: ReadFormat; selector?: string;
}
export interface BatchReadEntry {
  tabId: string; ok: boolean; title?: string; url?: string; page?: PageReadResult; error?: string;
}
export interface BatchReadResult { pages: BatchReadEntry[] }

/* ------------------------------------------------------------------ *
 * Actions and waits
 * ------------------------------------------------------------------ */

export interface PageTargetSpec {
  ref?: string; role?: string; name?: string; text?: string; label?: string;
  placeholder?: string; selector?: string; match?: "exact" | "contains";
}
export interface PageActionTarget { ref?: string; selector?: string; target?: PageTargetSpec }
export interface ClickElementParams extends PageActionTarget {
  tabId: string; allowedDomains?: string[];
}
export interface TypeTextParams extends PageActionTarget {
  tabId: string; text: string; clear?: boolean; allowedDomains?: string[];
}
export interface PageActionTargetInfo {
  tag: string; role: string; label: string; type: string | null; sensitive: boolean;
}
export interface ActionControlBrief { role: string; name: string; type: string | null }
export interface ActionControlChange extends ActionControlBrief { changes: string[] }
export interface PageActionDelta {
  addedControls: ActionControlBrief[]; removedControls: ActionControlBrief[];
  changedControls: ActionControlChange[]; addedHeadings: string[]; removedHeadings: string[];
  addedAlerts: string[]; removedAlerts: string[]; textChanged: boolean;
  textLengthDelta: number; readyState: string; limitation?: string;
}
export interface PageActionEffect {
  changed: boolean; urlChanged: boolean; titleChanged: boolean; domChanged: boolean;
  valueChanged: boolean; waitedMs: number; probeFailed?: boolean; navigation?: boolean;
  documentReplaced?: boolean; readyState?: string;
  attribution?: "observed_after_action_not_proven"; delta?: PageActionDelta;
}
export interface ClickElementResult {
  clicked: boolean; tabId: string; url: string; title: string; target: PageActionTargetInfo;
  framePath?: number[]; frameUrl?: string | null; limitation?: string; effect?: PageActionEffect;
}
export interface TypeObservation {
  compared: boolean; matchesInput: boolean | null; sensitive: boolean;
}
export interface TypeTextResult {
  typed: number; cleared: boolean; tabId: string; url: string; title: string;
  target: PageActionTargetInfo; framePath?: number[]; frameUrl?: string | null;
  limitation?: string; observed?: TypeObservation; effect?: PageActionEffect;
}
export const WAIT_CONDITIONS = [
  "selector", "text", "urlContains", "titleContains", "document", "newTab", "tabClosed", "dialog",
] as const;
export type WaitCondition = (typeof WAIT_CONDITIONS)[number];
export type WaitUntil = "present" | "absent";
export type WaitElementState = "present" | "visible" | "enabled";
export interface WaitForParams {
  tabId: string; selector?: string; state?: WaitElementState; text?: string;
  urlContains?: string; titleContains?: string; documentChanged?: boolean; documentId?: string;
  newTab?: boolean; tabClosed?: boolean; dialog?: boolean; until?: WaitUntil;
  timeoutMs?: number; pollMs?: number; framePath?: number[]; allowedDomains?: string[];
}
export interface WaitForResult {
  matched: boolean; waitedMs: number; condition: WaitCondition; until: WaitUntil;
  query: string; tabId: string; url: string; title: string; framePath?: number[];
  frameUrl?: string | null; state?: WaitElementState; documentId?: string;
  newTabId?: string; limitation?: string;
}

/* ------------------------------------------------------------------ *
 * Coordination
 * ------------------------------------------------------------------ */

export interface ProgressParams {
  title: string; step?: string; detail?: string; progress?: number;
  tone?: ActivityTone; stoppable?: boolean; done?: boolean;
}
export type WatchMode = "change" | "appear" | "disappear";
export interface WatchParams {
  tabId?: string; mode?: WatchMode; selector?: string; contains?: string;
  intervalSeconds?: number; maxMinutes?: number; label?: string; notify?: boolean;
}
export interface WatchInfo {
  id: string; tabId: string; title: string; url: string; spaceId: string | null;
  mode: WatchMode; selector: string | null; contains: string | null; label: string;
  intervalSeconds: number; createdAt: number; expiresAt: number;
  lastCheckedAt: number | null; lastError: string | null; changes: number;
}
export interface AskResult {
  status: AskOutcomeStatus; questionId: string; answer?: string; selectedLabels?: string[];
  freeform?: boolean; waitedSeconds?: number; message?: string;
}
export interface AnswerInboxEntry {
  question: UiQuestion; status: AskOutcomeStatus; askedAt: number; answeredAt?: number;
  answer?: string; selectedLabels?: string[]; freeform?: boolean;
}
export interface AnswersResult { pending: AnswerInboxEntry[]; answered: AnswerInboxEntry[] }
export interface ProgressResult { shown: boolean; stopRequested: boolean }

/* ------------------------------------------------------------------ *
 * Bridge operation params and results
 * ------------------------------------------------------------------ */

export interface CreateSpaceParams {
  name: string; icon?: string; containerTabId?: number; switchTo?: boolean;
}
export interface SwitchSpaceParams { space: string }
export interface SpaceTargetParams { space?: string }
export interface TabsListParams {
  space?: string; query?: string; pinnedOnly?: boolean; limit?: number;
}
export interface OpenTabsParams {
  urls: string[]; space?: string; background?: boolean; switchTo?: boolean;
  folderId?: string; container?: string | number;
}
export interface CloseTabsParams { tabIds: string[] }
export interface SelectTabParams { tabId: string; focusWindow?: boolean }
export interface PinTabsParams { tabIds: string[]; pinned: boolean }
export interface EssentialsParams { tabIds: string[] }
export interface TabReadParams {
  tabId: string; maxChars?: number; offset?: number; format?: ReadFormat; selector?: string;
  maxElements?: number; framePath?: number[]; allowedDomains?: string[];
}
export interface GlanceParams {
  url?: string; tabId?: string; container?: string | number; width?: number; height?: number;
  allowedDomains?: string[];
}
export interface SplitParams { tabIds: string[]; gridType?: "grid" | "hsep" | "vsep"; activate?: boolean }
export interface UnsplitParams { tabId?: string }
export interface CreateFolderParams {
  label: string; tabIds?: string[]; space?: string; collapsed?: boolean;
}
export interface AddTabsToFolderParams { folderId: string; tabIds: string[] }
export interface HistorySearchParams {
  query?: string; limit?: number; sinceDays?: number; domain?: string; groupByDomain?: boolean;
}
export interface BookmarksSearchParams { query?: string; limit?: number }
export interface ClipboardWriteParams { text: string }

export interface SpacesResult { activeSpaceId: string | null; spaces: SpaceInfo[]; workspacesEnabled: boolean }
export interface TabsResult { windowId: string; activeSpaceId: string | null; total: number; tabs: TabInfo[] }
export interface FoldersResult { folders: FolderInfo[] }
export interface HistoryResult { entries: HistoryEntry[]; groups?: HistoryGroup[] }
export interface BookmarksResult { entries: BookmarkEntry[] }
export interface ContainersResult { containers: ContainerInfo[] }
export interface CreateSpaceResult {
  created: boolean; space: Space; activeSpaceId: string | null; switched: boolean;
}
export interface SwitchSpaceResult { space: Space; activeSpaceId: string | null }
export interface DeleteSpaceResult { deleted: boolean; spaceId: string; spaceName: string; activeSpaceId: string | null }
export interface OpenedTab extends TabInfo { requestedUrl: string }
export interface OpenTabsResult { space: Space; tabs: OpenedTab[]; background: boolean }
export interface CloseTabsResult { closed: number; tabIds: string[] }
export interface SelectTabResult { tab: TabInfo; activeSpaceId: string | null; windowFocused?: boolean }
export interface PinTabsResult { tabIds: string[]; changed: number }
export interface EssentialsResult { tabIds: string[]; changed: number; restored?: number; limitation?: string }
export interface CreateFolderResult { created: boolean; folder: FolderInfo }
export interface AddTabsToFolderResult { folder: FolderInfo; added: number }
export interface GlanceResult { opened: boolean; url: string; mode: "glance" | "none"; message?: string }
export interface SplitResult { split: boolean; tabIds: string[]; gridType: string }
export interface UnsplitResult { unsplit: boolean; tabIds: string[]; closedResidue?: number; limitation?: string }
export interface RecentlyClosedEntry { title: string; url: string; closedAt: string | null }
export interface RecentlyClosedResult { entries: RecentlyClosedEntry[] }
export interface ClipboardWriteResult { written: boolean; length: number }
export interface EvidenceClearOutcomeBridge extends EvidenceClearResult {}

/** The fixed set of methods the bridge is willing to execute. */
export interface BridgeMethodMap {
  status: { params: undefined; result: BridgeStatus };
  "spaces.list": { params: undefined; result: SpacesResult };
  "spaces.create": { params: CreateSpaceParams; result: CreateSpaceResult };
  "spaces.switch": { params: SwitchSpaceParams; result: SwitchSpaceResult };
  "spaces.delete": { params: SpaceTargetParams; result: DeleteSpaceResult };
  "tabs.list": { params: TabsListParams | undefined; result: TabsResult };
  "tabs.open": { params: OpenTabsParams; result: OpenTabsResult };
  "tabs.close": { params: CloseTabsParams; result: CloseTabsResult };
  "tabs.select": { params: SelectTabParams; result: SelectTabResult };
  "tabs.pin": { params: PinTabsParams; result: PinTabsResult };
  "tabs.read": { params: TabReadParams; result: PageReadResult };
  "tabs.click": { params: ClickElementParams; result: ClickElementResult };
  "tabs.type": { params: TypeTextParams; result: TypeTextResult };
  "tabs.waitFor": { params: WaitForParams; result: WaitForResult };
  "tabs.evidence": { params: EvidenceShowParams; result: EvidenceOpResult };
  "tabs.evidenceClear": { params: EvidenceClearParams; result: EvidenceClearResult };
  "tabs.findText": { params: TextSearchParams; result: TextSearchResult };
  "folders.list": { params: undefined; result: FoldersResult };
  "folders.create": { params: CreateFolderParams; result: CreateFolderResult };
  "folders.addTabs": { params: AddTabsToFolderParams; result: AddTabsToFolderResult };
  "essentials.add": { params: EssentialsParams; result: EssentialsResult };
  "essentials.remove": { params: EssentialsParams; result: EssentialsResult };
  "containers.list": { params: undefined; result: ContainersResult };
  "glance.open": { params: GlanceParams; result: GlanceResult };
  "split.open": { params: SplitParams; result: SplitResult };
  "split.close": { params: UnsplitParams; result: UnsplitResult };
  "history.search": { params: HistorySearchParams; result: HistoryResult };
  "history.recentlyClosed": { params: undefined; result: RecentlyClosedResult };
  "bookmarks.search": { params: BookmarksSearchParams; result: BookmarksResult };
  "clipboard.write": { params: ClipboardWriteParams; result: ClipboardWriteResult };
}
export type BridgeMethod = keyof BridgeMethodMap;
