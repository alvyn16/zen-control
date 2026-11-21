import { z } from "zod";
import {
  AGENT_EVENT_KINDS,
  BROWSER_EVENT_PHASES,
  WAIT_CONDITIONS,
  type AnswerStatus,
  type AskOutcomeStatus,
  type BrowserEventPhase,
  type PageClassification,
  type ReadFormat,
  type WaitElementState,
  type WaitUntil,
} from "../shared/protocol.js";

/**
 * Structured-output contracts. Every shape is deliberately permissive: browser
 * payloads use loose objects so a newer bridge may add fields, and only fields
 * a handler always sets are required. Tool handlers return these values both as
 * text and as structuredContent.
 */

const READ_FORMATS = [
  "text", "markdown", "links", "tables", "metadata", "outline",
  "interactive", "snapshot", "semantic",
] as const satisfies readonly ReadFormat[];

const READ_FORMATS_SIMPLE = [
  "text", "markdown", "links", "tables", "metadata", "outline", "interactive",
] as const satisfies readonly ReadFormat[];

const CLASSIFICATIONS = [
  "article", "search-results", "product", "listing", "dashboard", "login",
  "form", "documentation", "discussion", "generic",
] as const satisfies readonly PageClassification[];

const ELEMENT_STATES = ["present", "visible", "enabled"] as const satisfies readonly WaitElementState[];
const WAIT_UNTILS = ["present", "absent"] as const satisfies readonly WaitUntil[];
const TONES = ["info", "success", "warning"] as const;
const ANSWER_STATUSES = ["answered", "deferred", "pending", "unavailable"] as const satisfies readonly AskOutcomeStatus[];
const WATCH_MODES = ["change", "appear", "disappear"] as const;
const CATEGORIES = [
  "not_found", "stale_reference", "document_changed", "ambiguous",
  "not_actionable", "invalid_target", "unsupported", "permission", "browser",
  "action_failed", "internal",
] as const;

const readFormat = z.enum(READ_FORMATS);
const tone = z.enum(TONES);
const answerStatus = z.enum(ANSWER_STATUSES);

const space = z.looseObject({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable().optional(),
  active: z.boolean().optional(),
  index: z.number().optional(),
  containerTabId: z.number().optional(),
});

const spaceInfo = z.looseObject({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable().optional(),
  active: z.boolean().optional(),
  index: z.number().optional(),
  containerTabId: z.number().optional(),
  tabCount: z.number().optional(),
  pinnedCount: z.number().optional(),
  folderCount: z.number().optional(),
});

const tab = z.looseObject({
  id: z.string(),
  windowId: z.string().optional(),
  spaceId: z.string().nullable().optional(),
  spaceName: z.string().nullable().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  requestedUrl: z.string().optional(),
  pinned: z.boolean().optional(),
  essential: z.boolean().optional(),
  active: z.boolean().optional(),
  folderId: z.string().nullable().optional(),
  folderLabel: z.string().nullable().optional(),
  index: z.number().optional(),
});

const openedTab = z.looseObject({
  id: z.string(),
  title: z.string().optional(),
  url: z.string(),
  requestedUrl: z.string().optional(),
  spaceId: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
  folderId: z.string().nullable().optional(),
});

const folder = z.looseObject({
  id: z.string(),
  label: z.string(),
  spaceId: z.string().optional(),
  collapsed: z.boolean().optional(),
  parentId: z.string().nullable().optional(),
  tabIds: z.array(z.string()).optional(),
  liveFolder: z.boolean().optional(),
});

const container = z.looseObject({
  userContextId: z.number(),
  name: z.string(),
  icon: z.string().optional(),
  color: z.string().optional(),
  public: z.boolean().optional(),
});

const historyEntry = z.looseObject({
  title: z.string(),
  url: z.string(),
  lastVisited: z.string().nullable().optional(),
  visitCount: z.number().optional(),
  domain: z.string().optional(),
});

const bookmarkEntry = z.looseObject({
  title: z.string(),
  url: z.string(),
  dateAdded: z.string().nullable().optional(),
});

const sessionInfo = z.looseObject({
  ownsBrowser: z.boolean().optional(),
  browserPid: z.number().nullable().optional(),
  profile: z.string().nullable().optional(),
  launchedAt: z.number().nullable().optional(),
  lockedDown: z.boolean().optional(),
  paused: z.boolean().optional(),
  consent: z.enum(["none", "pending", "granted", "denied"]).optional(),
});

const injection = z.looseObject({
  windows: z.number().optional(),
  injected: z.number().optional(),
  reused: z.number().optional(),
  reconnected: z.number().optional(),
  pending: z.number().optional(),
  errors: z.array(z.string()).optional(),
});

const uiOption = z.looseObject({
  label: z.string(),
  value: z.string().optional(),
  description: z.string().optional(),
});

const uiQuestion = z.looseObject({
  id: z.string(),
  question: z.string(),
  context: z.string().optional(),
  options: z.array(uiOption),
  allowFreeform: z.boolean().optional(),
  multiSelect: z.boolean().optional(),
  createdAt: z.number().optional(),
});

const answerRecord = z.looseObject({
  question: uiQuestion,
  status: answerStatus,
  askedAt: z.number().optional(),
  answeredAt: z.number().optional(),
  answer: z.string().optional(),
  selectedLabels: z.array(z.string()).optional(),
  freeform: z.boolean().optional(),
});

const pageLink = z.looseObject({ text: z.string(), url: z.string() });
const pageTable = z.looseObject({
  caption: z.string().nullable().optional(),
  headers: z.array(z.string()).optional(),
  rows: z.array(z.array(z.string())).optional(),
});
const pageHeading = z.looseObject({ level: z.number(), text: z.string() });
const pageMetadata = z.looseObject({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  canonical: z.string().nullable().optional(),
  lang: z.string().nullable().optional(),
  published: z.string().nullable().optional(),
  siteName: z.string().nullable().optional(),
});
const pageElement = z.looseObject({
  ref: z.string(),
  tag: z.string().optional(),
  role: z.string().optional(),
  type: z.string().nullable().optional(),
  label: z.string().optional(),
  value: z.string().nullable().optional(),
  sensitive: z.boolean().optional(),
  editable: z.boolean().optional(),
  valuePresent: z.boolean().optional(),
  framePath: z.array(z.number()).optional(),
});
const pageFrame = z.looseObject({
  path: z.array(z.number()),
  url: z.string().optional(),
  name: z.string().optional(),
});

const semanticPage = z.looseObject({
  classification: z.enum(CLASSIFICATIONS),
  confidence: z.number().optional(),
  signals: z.array(z.string()).optional(),
  primaryRegion: z.string().nullable().optional(),
  regions: z.array(z.looseObject({ id: z.string(), role: z.string() })).optional(),
  headings: z.array(pageHeading).optional(),
  collections: z.array(z.looseObject({ regionId: z.string(), kind: z.string(), count: z.number() })).optional(),
  dialogs: z.array(z.looseObject({ ref: z.string(), label: z.string().optional(), modal: z.boolean().optional() })).optional(),
  coverage: z.looseObject({ complete: z.boolean().optional() }).optional(),
  limitations: z.array(z.string()).optional(),
});

/** Optional delta-read fields shared by the single and batch read outputs. */
const deltaFields = {
  deltaToken: z.string().optional(),
  changed: z.boolean().optional(),
  delta: z.object({
    added: z.string(),
    removed: z.string(),
    truncated: z.boolean(),
  }).optional(),
};

const pageReadShape = {
  ...deltaFields,
  title: z.string(),
  url: z.string(),
  text: z.string().optional(),
  selectedText: z.string().optional(),
  truncated: z.boolean().optional(),
  length: z.number().optional(),
  offset: z.number().optional(),
  nextOffset: z.number().nullable().optional(),
  limitation: z.string().optional(),
  description: z.string().nullable().optional(),
  format: readFormat.optional(),
  contentType: z.string().nullable().optional(),
  selector: z.string().nullable().optional(),
  markdown: z.string().optional(),
  links: z.array(pageLink).optional(),
  tables: z.array(pageTable).optional(),
  metadata: pageMetadata.optional(),
  outline: z.array(pageHeading).optional(),
  elements: z.array(pageElement).optional(),
  semantic: semanticPage.optional(),
  snapshotId: z.string().optional(),
  elementsTruncated: z.boolean().optional(),
  elementsTotal: z.number().optional(),
  snapshotComplete: z.boolean().optional(),
  textTruncated: z.boolean().optional(),
  limitations: z.array(z.string()).optional(),
  frames: z.array(pageFrame).optional(),
  framePath: z.array(z.number()).optional(),
};

const pageReadSummary = z.looseObject({
  title: z.string().optional(),
  url: z.string().optional(),
  text: z.string().optional(),
  markdown: z.string().optional(),
  format: readFormat.optional(),
  truncated: z.boolean().optional(),
  length: z.number().optional(),
  offset: z.number().optional(),
  nextOffset: z.number().nullable().optional(),
  limitation: z.string().optional(),
});

const evidenceFailure = z.looseObject({ code: z.string(), message: z.string() });
const textMatch = z.looseObject({
  start: z.number(),
  end: z.number(),
  text: z.string().optional(),
  excerpt: z.string().optional(),
});

const evidenceOp = {
  ok: z.boolean(),
  tabId: z.string().nullable().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  matchedQuote: z.string().optional(),
  matchMethod: z.string().optional(),
  confidence: z.number().optional(),
  occurrences: z.number().optional(),
  scrolled: z.boolean().optional(),
  highlighted: z.boolean().optional(),
  verified: z.boolean().optional(),
  limitation: z.string().optional(),
  error: evidenceFailure.optional(),
};

const evidenceShow = z.looseObject({
  ...evidenceOp,
  tabReused: z.boolean().optional(),
  focused: z.boolean().optional(),
  sourceUrl: z.string().optional(),
  claim: z.string().optional(),
});

const textSearch = {
  ok: z.boolean(),
  tabId: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  query: z.string().optional(),
  matches: z.array(textMatch).optional(),
  totalMatches: z.number().optional(),
  truncated: z.boolean().optional(),
  limitation: z.string().optional(),
  error: evidenceFailure.optional(),
};

const waitForShape = {
  matched: z.boolean(),
  waitedMs: z.number().optional(),
  condition: z.enum(WAIT_CONDITIONS).optional(),
  until: z.enum(WAIT_UNTILS).optional(),
  query: z.string().optional(),
  tabId: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  framePath: z.array(z.number()).optional(),
  frameUrl: z.string().nullable().optional(),
  state: z.enum(ELEMENT_STATES).optional(),
  documentId: z.string().optional(),
  newTabId: z.string().optional(),
  limitation: z.string().optional(),
};

const watchInfo = z.looseObject({
  id: z.string(),
  tabId: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  spaceId: z.string().nullable().optional(),
  mode: z.enum(WATCH_MODES).optional(),
  selector: z.string().nullable().optional(),
  contains: z.string().nullable().optional(),
  label: z.string().optional(),
  intervalSeconds: z.number().optional(),
  createdAt: z.number().optional(),
  expiresAt: z.number().optional(),
  lastCheckedAt: z.number().nullable().optional(),
  lastError: z.string().nullable().optional(),
  changes: z.number().optional(),
});

const sessionSummary = z.looseObject({
  name: z.string(),
  createdAt: z.string().optional(),
  spaceCount: z.number().optional(),
  tabCount: z.number().optional(),
  essentialCount: z.number().optional(),
});

const templateDetail = z.looseObject({
  name: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().nullable().optional(),
  builtIn: z.boolean().optional(),
  createdAt: z.string().optional(),
  folders: z.array(z.looseObject({ label: z.string(), urls: z.array(z.string()) })).optional(),
  looseUrls: z.array(z.string()).optional(),
});

/** Structured error variant used only by zen_click and zen_type. */
const toolError = z.looseObject({
  code: z.string(),
  message: z.string(),
  category: z.enum(CATEGORIES),
  retryable: z.boolean(),
  stateChanged: z.boolean().nullable(),
  recovery: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const actionTarget = z.looseObject({
  tag: z.string().optional(),
  role: z.string().optional(),
  label: z.string().optional(),
  type: z.string().nullable().optional(),
  sensitive: z.boolean().optional(),
});

const actionEffect = z.looseObject({
  changed: z.boolean().optional(),
  urlChanged: z.boolean().optional(),
  titleChanged: z.boolean().optional(),
  domChanged: z.boolean().optional(),
  valueChanged: z.boolean().optional(),
  waitedMs: z.number().optional(),
  attribution: z.literal("observed_after_action_not_proven").optional(),
  delta: z.looseObject({}).optional(),
  limitation: z.string().optional(),
});

const clickOutput = z.looseObject({
  error: toolError.optional(),
  clicked: z.boolean().optional(),
  tabId: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  target: actionTarget.optional(),
  effect: actionEffect.optional(),
  framePath: z.array(z.number()).optional(),
  frameUrl: z.string().nullable().optional(),
  limitation: z.string().optional(),
});

const typeOutput = z.looseObject({
  error: toolError.optional(),
  typed: z.number().optional(),
  cleared: z.boolean().optional(),
  tabId: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  target: actionTarget.optional(),
  effect: actionEffect.optional(),
  observed: z.looseObject({
    compared: z.boolean().optional(),
    matchesInput: z.boolean().nullable().optional(),
    sensitive: z.boolean().optional(),
  }).optional(),
  framePath: z.array(z.number()).optional(),
  frameUrl: z.string().nullable().optional(),
  limitation: z.string().optional(),
});

export const TOOL_OUTPUT_SCHEMAS: Record<string, z.ZodRawShape | z.ZodType> = {
  /* Browser */
  zen_status: {
    appName: z.string().optional(),
    appVersion: z.string().optional(),
    buildId: z.string().optional(),
    platform: z.string().optional(),
    profile: z.string().optional(),
    windowId: z.string().optional(),
    focused: z.boolean().optional(),
    workspacesEnabled: z.boolean().optional(),
    activeSpaceId: z.string().nullable().optional(),
    activeTab: z.looseObject({}).nullable().optional(),
    spaces: z.array(spaceInfo).optional(),
    tabCount: z.number().optional(),
    folderCount: z.number().optional(),
    bridge: z.looseObject({}).optional(),
  },
  zen_launch: {
    launched: z.boolean().optional(),
    injection: injection.optional(),
    windowId: z.string().optional(),
    appVersion: z.string().optional(),
    spaces: z.number().optional(),
    activeSpaceId: z.string().nullable().optional(),
    session: sessionInfo.optional(),
    message: z.string().optional(),
  },

  /* Spaces */
  zen_spaces_list: {
    activeSpaceId: z.string().nullable().optional(),
    spaces: z.array(spaceInfo),
    workspacesEnabled: z.boolean().optional(),
  },
  zen_space_create: {
    created: z.boolean().optional(),
    space,
    activeSpaceId: z.string().nullable().optional(),
    switched: z.boolean().optional(),
  },
  zen_space_switch: {
    space,
    activeSpaceId: z.string().nullable().optional(),
  },
  zen_space_delete: {
    deleted: z.boolean().optional(),
    spaceId: z.string().optional(),
    spaceName: z.string().optional(),
    activeSpaceId: z.string().nullable().optional(),
  },

  /* Tabs */
  zen_tabs_list: {
    windowId: z.string().optional(),
    activeSpaceId: z.string().nullable().optional(),
    total: z.number().optional(),
    tabs: z.array(tab),
  },
  zen_tabs_open: {
    space: space.optional(),
    tabs: z.array(openedTab),
    background: z.boolean().optional(),
  },
  zen_tabs_close: {
    closed: z.number().optional(),
    tabIds: z.array(z.string()),
  },
  zen_tab_select: {
    tab,
    activeSpaceId: z.string().nullable().optional(),
    windowFocused: z.boolean().optional(),
  },
  zen_glance: {
    opened: z.boolean().optional(),
    url: z.string().optional(),
    mode: z.enum(["glance", "none"]).optional(),
    message: z.string().optional(),
  },
  zen_split_view: {
    split: z.boolean().optional(),
    tabIds: z.array(z.string()).optional(),
    gridType: z.string().optional(),
  },
  zen_split_close: {
    unsplit: z.boolean().optional(),
    tabIds: z.array(z.string()).optional(),
    closedResidue: z.number().optional(),
    limitation: z.string().optional(),
  },
  zen_pin_tabs: {
    tabIds: z.array(z.string()).optional(),
    changed: z.number().optional(),
  },
  zen_essentials: {
    tabIds: z.array(z.string()).optional(),
    changed: z.number().optional(),
    restored: z.number().optional(),
    limitation: z.string().optional(),
  },
  zen_containers_list: {
    containers: z.array(container),
  },
  zen_folders_list: {
    folders: z.array(folder),
  },
  zen_folder_create: {
    created: z.boolean().optional(),
    folder,
  },
  zen_folder_add_tabs: {
    folder,
    added: z.number().optional(),
  },

  /* History and bookmarks */
  zen_history_search: {
    entries: z.array(historyEntry),
    groups: z.array(z.looseObject({ domain: z.string(), entries: z.array(historyEntry) })).optional(),
  },
  zen_history_recently_closed: {
    entries: z.array(z.looseObject({
      title: z.string().optional(),
      url: z.string(),
      closedAt: z.string().nullable().optional(),
    })),
  },
  zen_bookmarks_search: {
    entries: z.array(bookmarkEntry),
  },

  /* Reading */
  zen_read_page: pageReadShape,
  zen_read_pages: {
    ...deltaFields,
    pages: z.array(z.looseObject({
      ...deltaFields,
      tabId: z.string(),
      ok: z.boolean(),
      title: z.string().optional(),
      url: z.string().optional(),
      page: pageReadSummary.optional(),
      error: z.string().optional(),
    })),
  },
  zen_find_text: textSearch,
  zen_search_tabs: {
    query: z.string().optional(),
    tabsSearched: z.number().optional(),
    tabsMatched: z.number().optional(),
    totalMatches: z.number().optional(),
    skipped: z.number().optional(),
    truncated: z.boolean().optional(),
    results: z.array(z.looseObject({
      tabId: z.string(),
      ok: z.boolean().optional(),
      url: z.string().optional(),
      title: z.string().optional(),
      matches: z.array(textMatch).optional(),
      totalMatches: z.number().optional(),
      truncated: z.boolean().optional(),
      limitation: z.string().optional(),
      error: evidenceFailure.optional(),
    })).optional(),
  },
  zen_wait_for: waitForShape,
  zen_click: clickOutput,
  zen_type: typeOutput,

  /* Evidence */
  zen_show_evidence: z.looseObject({
    ...evidenceOp,
    tabReused: z.boolean().optional(),
    focused: z.boolean().optional(),
    sourceUrl: z.string().optional(),
    claim: z.string().optional(),
  }),
  zen_show_evidence_batch: {
    ok: z.boolean().optional(),
    total: z.number().optional(),
    matched: z.number().optional(),
    verified: z.number().optional(),
    failed: z.number().optional(),
    openedTabs: z.number().optional(),
    reusedTabs: z.number().optional(),
    focused: z.boolean().optional(),
    results: z.array(evidenceShow).optional(),
    limitation: z.string().optional(),
    error: evidenceFailure.optional(),
  },
  zen_clear_evidence: {
    cleared: z.boolean().optional(),
    removed: z.number().optional(),
    tabId: z.string().nullable().optional(),
    error: evidenceFailure.optional(),
  },

  /* Organization */
  zen_tabs_audit: {
    totals: z.looseObject({}).optional(),
    bySpace: z.array(z.looseObject({})).optional(),
    duplicates: z.array(z.looseObject({})).optional(),
    staleTabs: z.array(z.looseObject({})).optional(),
    domains: z.array(z.looseObject({})).optional(),
  },
  zen_tabs_group: {
    spaceId: z.string().optional(),
    planned: z.number().optional(),
    created: z.array(z.looseObject({
      folderId: z.string().optional(),
      label: z.string().optional(),
      tabs: z.number().optional(),
    })).optional(),
    groupedTabs: z.number().optional(),
  },
  zen_clipboard_write: {
    written: z.boolean().optional(),
    length: z.number().optional(),
  },

  /* Coordination */
  zen_progress: {
    delivered: z.boolean().optional(),
    windowId: z.string().optional(),
    progress: z.looseObject({}).nullable().optional(),
  },
  zen_events: {
    events: z.array(z.looseObject({
      id: z.number(),
      kind: z.enum(AGENT_EVENT_KINDS),
      at: z.number().optional(),
      title: z.string().optional(),
      detail: z.string().optional(),
      phase: z.enum(BROWSER_EVENT_PHASES).optional(),
      url: z.string().optional(),
      source: z.enum(["server", "browser"]).optional(),
    })).optional(),
    cursor: z.number().optional(),
    stopped: z.boolean().optional(),
    paused: z.boolean().optional(),
    lastEventAt: z.number().nullable().optional(),
    missed: z.number().optional(),
    oldestCursor: z.number().nullable().optional(),
    dropped: z.number().optional(),
    filtered: z.number().optional(),
  },
  zen_watch_add: z.looseObject({ id: z.string() }),
  zen_watch_list: {
    watches: z.array(watchInfo),
    minIntervalSeconds: z.number().optional(),
  },
  zen_watch_remove: {
    watchId: z.string().optional(),
    removed: z.boolean().optional(),
  },
  zen_ask: {
    status: answerStatus.optional(),
    questionId: z.string().optional(),
    answer: z.string().optional(),
    selectedLabels: z.array(z.string()).optional(),
    freeform: z.boolean().optional(),
    waitedSeconds: z.number().optional(),
    message: z.string().optional(),
  },
  zen_answers: {
    pending: z.array(answerRecord).optional(),
    answered: z.array(answerRecord).optional(),
  },
  zen_notify: {
    delivered: z.boolean().optional(),
    windowId: z.string().optional(),
  },

  /* Policy and audit */
  zen_config: {
    server: z.string().optional(),
    version: z.string().optional(),
    readOnly: z.boolean().optional(),
    allowedDomains: z.array(z.string()).optional(),
    auditLog: z.boolean().optional(),
    auditPath: z.string().optional(),
    dataDir: z.string().optional(),
    profileMode: z.enum(["custom", "default", "dedicated"]).optional(),
    profilePath: z.string().nullable().optional(),
    requireConsent: z.boolean().optional(),
    session: sessionInfo.optional(),
    ownership: z.string().optional(),
    autoLaunch: z.boolean().optional(),
    autoAttachWindows: z.boolean().optional(),
    toolSurface: z.string().optional(),
    exposedToolCount: z.number().optional(),
    availableToolCount: z.number().optional(),
    askTimeoutSeconds: z.number().optional(),
    consentTimeoutSeconds: z.number().optional(),
    watchMinIntervalSeconds: z.number().optional(),
    sessions: z.number().optional(),
    userTemplates: z.number().optional(),
  },
  zen_doctor: {
    ok: z.boolean(),
    checks: z.array(z.object({
      name: z.string(),
      ok: z.boolean(),
      detail: z.string(),
      fix: z.string().optional(),
    })),
    surface: z.string(),
    counts: z.object({
      tools: z.number(),
      resources: z.number(),
      prompts: z.number(),
    }),
    policy: z.object({
      readOnly: z.boolean(),
      auditLog: z.boolean(),
      requireConsent: z.boolean(),
      allowedDomains: z.array(z.string()),
    }),
    session: sessionInfo.optional(),
  },
  zen_audit_tail: {
    path: z.string().optional(),
    entries: z.array(z.looseObject({
      at: z.string().optional(),
      tool: z.string().optional(),
      ok: z.boolean().optional(),
      executed: z.boolean().optional(),
      durationMs: z.number().optional(),
      citationsVerified: z.number().optional(),
      citationsFailed: z.number().optional(),
      outcome: z.enum(["success", "partial", "failed"]).optional(),
      args: z.unknown().optional(),
      error: z.looseObject({ code: z.string().optional(), message: z.string().optional() }).optional(),
      urls: z.array(z.string()).optional(),
    })).optional(),
  },

  /* Sessions and templates */
  zen_session_save: {
    name: z.string().optional(),
    createdAt: z.string().optional(),
    spaces: z.number().optional(),
    tabs: z.number().optional(),
    essentials: z.number().optional(),
    path: z.string().optional(),
  },
  zen_session_list: {
    sessions: z.array(sessionSummary),
    path: z.string().optional(),
  },
  zen_session_restore: {
    name: z.string().optional(),
    spacesCreated: z.number().optional(),
    spacesReused: z.number().optional(),
    tabsOpened: z.number().optional(),
    tabsSkipped: z.number().optional(),
    foldersCreated: z.number().optional(),
    essentialsAdded: z.number().optional(),
    warnings: z.array(z.string()).optional(),
  },
  zen_session_delete: {
    name: z.string().optional(),
    deleted: z.boolean().optional(),
  },
  zen_space_templates: {
    templates: z.array(z.looseObject({
      name: z.string(),
      label: z.string().optional(),
      description: z.string().optional(),
      icon: z.string().nullable().optional(),
      builtIn: z.boolean().optional(),
      folders: z.number().optional(),
      tabs: z.number().optional(),
    })).optional(),
    template: templateDetail.optional(),
    path: z.string().optional(),
  },
  zen_template_apply: {
    template: z.string().optional(),
    space: space.optional(),
    tabsOpened: z.number().optional(),
    foldersCreated: z.number().optional(),
    tabsFailed: z.number().optional(),
    warnings: z.array(z.string()).optional(),
  },
  zen_template_save: z.looseObject({
    name: z.string().optional(),
    label: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().nullable().optional(),
    builtIn: z.boolean().optional(),
    folders: z.array(z.looseObject({ label: z.string(), urls: z.array(z.string()) })).optional(),
    looseUrls: z.array(z.string()).optional(),
  }),
  zen_template_delete: {
    name: z.string().optional(),
    deleted: z.boolean().optional(),
  },

  /* Discovery (zen_tools_use has no output schema: its shape is the target's.) */
  zen_tools_search: {
    query: z.string().optional(),
    category: z.string().nullable().optional(),
    total: z.number().optional(),
    tools: z.array(z.looseObject({
      name: z.string(),
      summary: z.string().optional(),
      category: z.string().optional(),
      surfaces: z.array(z.string()).optional(),
      exposed: z.boolean().optional(),
      mutating: z.boolean().optional(),
    })).optional(),
    tool: z.looseObject({
      name: z.string(),
      summary: z.string().optional(),
      category: z.string().optional(),
      surfaces: z.array(z.string()).optional(),
      exposed: z.boolean().optional(),
      mutating: z.boolean().optional(),
      description: z.string().optional(),
      inputSchema: z.unknown().optional(),
    }).optional(),
  },
};

/* Referenced so unused type imports remain honest documentation of the wire. */
export type OutputSchemaCatalog = typeof TOOL_OUTPUT_SCHEMAS;
export type AnswerStatusValue = AnswerStatus;
export type EventPhaseValue = BrowserEventPhase;
export type SimpleReadFormat = (typeof READ_FORMATS_SIMPLE)[number];

/** Kept for the server's wait tool, so the literal arrays stay in one place. */
export const WAIT_ELEMENT_STATE_VALUES = ELEMENT_STATES;
export const WAIT_UNTIL_VALUES = WAIT_UNTILS;
