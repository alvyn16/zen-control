/**
 * Orchestration layer: owns the browser lifecycle, the bridge connection and
 * all high-level tool operations.
 *
 * Design rules kept here deliberately:
 *  - connect() is memoized and never re-attaches after lockdown;
 *  - all URL/policy checks happen here, not in the injected bridge;
 *  - all batching is bounded, and partial failures are returned rather than
 *    thrown so one slow or closed tab cannot spoil a whole research step.
 */

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  BridgeHub,
  BridgeRequestError,
  BridgeUnavailableError,
  type InjectionSummary,
} from "../bridge/host.js";
import { dataDirPath, type AppConfig } from "../config.js";
import type {
  ActivityTone,
  AgentEvent,
  AnswersResult,
  AskResult,
  BatchReadEntry,
  BatchReadResult,
  BridgeMethod,
  BridgeMethodMap,
  BridgeStatus,
  ClickElementResult,
  EvidenceBatchOptions,
  EvidenceBatchResult,
  EvidenceCitation,
  EvidenceClearOutcome,
  EvidenceFailure,
  EvidenceOpResult,
  EvidenceShowResult,
  EventsResult,
  PageReadResult,
  PageTargetSpec,
  ProgressResult,
  ReadFormat,
  SearchTabsEntry,
  SearchTabsResult,
  TabInfo,
  TextSearchResult,
  TypeTextResult,
  UiConsent,
  UiOption,
  UiUpdateNotice,
  WaitElementState,
  WaitForResult,
  WatchInfo,
  WatchParams,
} from "../shared/protocol.js";
import { hostOf, isUrlAllowed } from "../shared/url-policy.js";
import { createLogger, type Logger } from "../utils/logger.js";
import {
  isPortOpen,
  launchZen,
  resolvedProfilePath,
  terminateZenProcess,
  waitForProcessExit,
  ZenLaunchError,
} from "./launcher.js";
import { MarionetteClient } from "./marionette.js";
import { readActivePage, readTabPage } from "./page.js";
import { ReadDeltaStore, diffText } from "./read-deltas.js";
import {
  checkForUpdate,
  detectPackageManager,
  PACKAGE_NAME,
  readUpdatePromptState,
  runInstaller,
  shouldPromptUpdate,
  updateCommand,
  writeUpdatePromptState,
  type UpdateInfo,
} from "./updates.js";

const MAX_WATCH_SAMPLE_CHARS = 60_000;
const MAX_WATCHES = 50;
const MAX_BATCH_READ = 10;
const READ_CONCURRENCY = 3;
const AUTO_ATTACH_MS = 20_000;
const SEARCH_CONCURRENCY = 2;
const SEARCH_TAB_TIMEOUT_MS = 12_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_EVIDENCE_BATCH = 20;
const EVIDENCE_CONCURRENCY = 3;
const MAX_QUOTES_PER_SOURCE = 5;
const MAX_BATCH_CARD_FAILURES = 3;
const MAX_EVIDENCE_TARGETS = 20;

export interface ConnectResult {
  launched: boolean;
  injection: InjectionSummary;
}

export interface RuntimeOptions {
  config: AppConfig;
  bridgeScriptPath?: string;
  logger?: Logger;
  checkUpdate?: () => Promise<UpdateInfo>;
  installUpdate?: () => Promise<{ ok: boolean; message?: string }>;
}

export interface SessionInfo {
  ownsBrowser: boolean;
  browserPid: number | null;
  profile: string | null;
  launchedAt: number | null;
  lockedDown: boolean;
  paused: boolean;
  consent: "none" | "pending" | "granted" | "denied";
}

export interface AskOptions {
  waitSeconds?: number;
  context?: string;
  allowFreeform?: boolean;
  multiSelect?: boolean;
  windowId?: string;
}

export type NotifyAction =
  | { label: string; space: string }
  | { label: string; tab: string };

export interface NotifyOptions {
  title: string;
  detail?: string;
  tone?: ActivityTone;
  action?: NotifyAction;
  autoHideMs?: number;
  windowId?: string;
}

export interface ProgressOptions {
  title: string;
  step?: string;
  detail?: string;
  progress?: number;
  tone?: ActivityTone;
  stoppable?: boolean;
  done?: boolean;
}

export interface EventsOptions {
  after?: number;
  waitSeconds?: number;
}

export interface ShowEvidenceOptions {
  url: string;
  quote: string;
  claim?: string;
  context?: string;
  sourceTitle?: string;
  tabId?: string;
  minConfidence?: number;
  highlightMs?: number;
  focus?: boolean;
  signal?: AbortSignal;
}

export interface ShowEvidenceBatchOptions extends EvidenceBatchOptions {
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}

export interface ClearEvidenceOptions {
  tabId?: string;
}

export interface FindTextOptions {
  tabId: string;
  query: string;
  caseSensitive?: boolean;
  maxMatches?: number;
  contextChars?: number;
}

export interface SearchTabsOptions {
  query: string;
  space?: string;
  tabIds?: string[];
  maxTabs?: number;
  maxMatchesPerTab?: number;
  contextChars?: number;
  caseSensitive?: boolean;
}

export interface ReadPageOptions {
  windowId?: string;
  maxChars?: number;
  offset?: number;
  tabId?: string;
  format?: ReadFormat;
  selector?: string;
  maxElements?: number;
  framePath?: number[];
  /** Opaque token from a previous read; returns only what changed since then. */
  since?: string;
  signal?: AbortSignal;
}

export interface BatchReadOptions {
  tabIds: string[];
  windowId?: string;
  maxChars?: number;
  offset?: number;
  format?: ReadFormat;
  selector?: string;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}

export interface ClickOptions {
  tabId: string;
  ref?: string;
  selector?: string;
  target?: PageTargetSpec;
  windowId?: string;
  signal?: AbortSignal;
}

export interface TypeOptions extends ClickOptions {
  text: string;
  clear?: boolean;
}

export interface WaitOptions {
  tabId: string;
  selector?: string;
  state?: WaitElementState;
  text?: string;
  urlContains?: string;
  titleContains?: string;
  documentChanged?: boolean;
  documentId?: string;
  newTab?: boolean;
  tabClosed?: boolean;
  dialog?: boolean;
  until?: "present" | "absent";
  timeoutMs?: number;
  pollMs?: number;
  framePath?: number[];
  windowId?: string;
  signal?: AbortSignal;
}

interface EventInput {
  kind: AgentEvent["kind"];
  title: string;
  detail?: string;
  windowId?: string;
  tabId?: string;
  watchId?: string;
  questionId?: string;
  phase?: AgentEvent["phase"];
  url?: string;
  documentId?: string;
  source?: AgentEvent["source"];
}

interface Ownership {
  nonce: string;
  launchedPid: number;
  browserPid: number | null;
  profile: string | null;
  launchedAt: number;
}

interface EvidenceTarget {
  windowId: string;
  updatedAt: number;
}

interface WatchRuntime {
  info: WatchInfo;
  timer: NodeJS.Timeout | null;
  running: boolean;
  previousText: string | null;
  previousHash: string;
  previousFound: boolean;
  notify: boolean;
  windowId?: string;
}

/** The host-level (non-bridge-method) surface the runtime needs from the hub. */
interface HubOps {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly paused: boolean;
  readonly busy: boolean;
  readonly connectionCount: number;
  readonly consentState: "none" | "pending" | "granted" | "denied";
  connectedWindows(): Iterable<{ windowId: string; focused: boolean }>;
  ensureInjected(options?: { force?: boolean; waitMs?: number }): Promise<InjectionSummary>;
  request<T extends BridgeMethod>(
    method: T,
    params: BridgeMethodMap[T]["params"],
    options?: { windowId?: string; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<BridgeMethodMap[T]["result"]>;
  ask(question: string, options: UiOption[], askOptions?: AskOptions): Promise<AskResult>;
  notify(options: NotifyOptions): Promise<{ delivered: boolean; windowId?: string }>;
  progress(options: ProgressOptions): ProgressResult;
  events(options?: EventsOptions): Promise<EventsResult>;
  answers(): AnswersResult;
  pushEvent(input: EventInput): AgentEvent | null;
  setUpdateNotice(notice: UiUpdateNotice | null): void;
  configureActiveBanner(banner: { text: string; detail?: string }): void;
  grantAccess(): void;
  requestConsent(options: {
    consent: UiConsent;
    timeoutMs?: number;
  }): Promise<"granted" | "denied" | "pending" | "timeout">;
}

/** Local policy error whose code the MCP layer can map to a recovery hint. */
class ZenAccessError extends Error {
  override name = "ZenAccessError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

/** Reads a bridge error code without relying on class identity. */
function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const value = (error as { code?: unknown }).code;
    if (typeof value === "string") return value;
  }
  return "";
}

function clampInt(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function isHttpPage(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeEvidenceUrl(input: string): string | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Hash-insensitive, slash-insensitive URL identity for tab reuse. */
function comparableUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return String(value ?? "").trim();
  }
}

function tabMatchesUrl(tab: TabInfo, url: string): boolean {
  const wanted = comparableUrl(url);
  return [tab.url, tab.requestedUrl]
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .some((item) => comparableUrl(item) === wanted);
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function previewText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "(page text is now empty)";
  return `${compact.slice(0, 240)}${compact.length > 240 ? "..." : ""} (${text.length} chars)`;
}

function collapseText(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncateText(value: string, max: number): string {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function joinLimitation(current: string | undefined, extra: string): string {
  const base = current?.trim();
  return base ? `${base} ${extra}` : extra;
}

function evidenceFailureFromError(error: unknown): EvidenceFailure {
  const message = errorText(error);
  if (error instanceof BridgeUnavailableError) {
    return { code: "ACTOR_UNAVAILABLE", message };
  }
  const code = errorCodeOf(error);
  switch (code) {
    case "tab_not_found":
    case "no_tab":
      return { code: "PAGE_NOT_FOUND", message };
    case "tab_not_loaded":
      return { code: "PAGE_STILL_LOADING", message };
    case "actor_unavailable":
      return { code: "ACTOR_UNAVAILABLE", message };
    case "bridge_timeout":
      return { code: "PAGE_STILL_LOADING", message: `The page did not settle in time. ${message}` };
    case "bridge_disconnected":
      return { code: "PAGE_NOT_FOUND", message: `The browser session disconnected. ${message}` };
    case "unknown_method":
      return { code: "ACTOR_UNAVAILABLE", message: `${message} Re-run zen_launch to update the bridge.` };
    case "invalid_url":
    case "domain_not_allowed":
      return { code: "UNSUPPORTED_PAGE", message };
    default:
      return { code: "PAGE_NOT_FOUND", message };
  }
}

function searchEntry(result: TextSearchResult): SearchTabsEntry {
  return {
    tabId: result.tabId,
    ok: result.ok,
    url: result.url,
    title: result.title,
    matches: result.matches,
    totalMatches: result.totalMatches,
    truncated: result.truncated,
    ...(result.limitation ? { limitation: result.limitation } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

function evidenceCardTitle(result: EvidenceShowResult): string {
  const claim = result.claim ? collapseText(result.claim) : "";
  if (claim) return truncateText(claim, 140);
  if (result.ok) return "Evidence located";
  const titles: Partial<Record<EvidenceFailure["code"], string>> = {
    PAGE_NOT_FOUND: "Source page is unavailable",
    PAGE_STILL_LOADING: "Source page is still loading",
    QUOTE_NOT_FOUND: "Evidence not found",
    AMBIGUOUS_MATCH: "Evidence match is ambiguous",
    LOW_MATCH_CONFIDENCE: "Evidence match is too weak",
    HIGHLIGHT_FAILED: "Evidence could not be marked",
    PRIVILEGED_PAGE: "Source page cannot be inspected",
    ACTOR_UNAVAILABLE: "Browser bridge is unavailable",
    UNSUPPORTED_PAGE: "Source page is not supported",
  };
  return (result.error?.code ? titles[result.error.code] : undefined) ?? "Evidence check failed";
}

function evidenceCardDetail(
  result: EvidenceShowResult,
  quote: string,
  sourceTitle?: string
): string {
  const lines: string[] = [];
  const source = sourceTitle?.trim() || result.title?.trim() || result.sourceUrl;
  lines.push(`Source: ${truncateText(source, 160)}`);
  const excerpt = collapseText(result.matchedQuote || quote);
  if (excerpt) lines.push(`“${truncateText(excerpt, 220)}”`);
  if (result.ok) {
    lines.push(
      `Status: ${[
        result.matchMethod ? `${result.matchMethod} match` : "match",
        typeof result.confidence === "number"
          ? `${Math.round(result.confidence * 100)}% confidence`
          : "",
        result.occurrences && result.occurrences > 1 ? `${result.occurrences} occurrences` : "",
        result.highlighted ? "highlighted" : "not highlighted",
        result.scrolled ? "scrolled into view" : "",
      ]
        .filter(Boolean)
        .join(" · ")}`
    );
  } else {
    lines.push(`Status: ${result.error?.code ?? "FAILED"}`);
    if (result.error?.message) lines.push(truncateText(collapseText(result.error.message), 240));
  }
  if (result.limitation) lines.push(`Note: ${truncateText(collapseText(result.limitation), 240)}`);
  return lines.join("\n").slice(0, 800);
}

export class ZenRuntime {
  readonly config: AppConfig;
  readonly marionette: MarionetteClient;
  readonly hub: BridgeHub;

  readonly #logger: Logger;
  readonly #ops: HubOps;
  readonly #checkUpdate: () => Promise<UpdateInfo>;
  readonly #installUpdate?: () => Promise<{ ok: boolean; message?: string }>;

  #connectPromise: Promise<ConnectResult> | null = null;
  #closed = false;
  #ownership: Ownership | null = null;
  #identityVerified = false;
  #lockedDown = false;
  #autoAttachTimer: NodeJS.Timeout | null = null;
  #autoAttaching = false;
  readonly #watches = new Map<string, WatchRuntime>();
  #watchReservations = 0;
  readonly #evidenceTargets = new Map<string, EvidenceTarget>();
  readonly #deltas = new ReadDeltaStore();

  constructor(options: RuntimeOptions) {
    this.config = options.config;
    this.#logger = options.logger ?? createLogger("runtime");
    this.marionette = new MarionetteClient({
      port: options.config.marionettePort,
      logger: this.#logger,
    });
    this.#checkUpdate = options.checkUpdate ?? (() => checkForUpdate({ timeoutMs: 2_500 }));
    this.#installUpdate = options.installUpdate;
    this.hub = new BridgeHub({
      marionette: this.marionette,
      bridgeScriptPath: options.bridgeScriptPath,
      logger: this.#logger,
      allowedDomains: options.config.allowedDomains,
      installUpdate: options.installUpdate ?? (() => this.installUpdate()),
    });
    this.#ops = this.hub as unknown as HubOps;
  }

  async start(): Promise<void> {
    await this.#ops.start();
  }

  /** Memoized connection attempt. After lockdown there is no re-attach path. */
  connect(options: { allowLaunch?: boolean } = {}): Promise<ConnectResult> {
    if (this.#closed) return Promise.reject(new Error("Zen MCP has shut down"));
    if (!this.#connectPromise) {
      const allowLaunch =
        options.allowLaunch ?? (!this.config.readOnly && this.config.autoLaunch);
      this.#connectPromise = this.#connectOnce(allowLaunch).finally(() => {
        this.#connectPromise = null;
      });
    }
    return this.#connectPromise;
  }

  get paused(): boolean {
    return this.#ops.paused;
  }

  sessionInfo(): SessionInfo {
    return {
      ownsBrowser: this.#ownership !== null,
      browserPid: this.#ownership?.browserPid ?? null,
      profile: this.#ownership?.profile ?? null,
      launchedAt: this.#ownership?.launchedAt ?? null,
      lockedDown: this.#lockedDown,
      paused: this.#ops.paused,
      consent: this.#ops.consentState,
    };
  }

  async #connectOnce(allowLaunch: boolean): Promise<ConnectResult> {
    await this.#ops.start();
    let launched = false;

    if (!this.marionette.isConnected) {
      if (this.#ownership) {
        this.#ownership = null;
        this.#lockedDown = false;
        await this.marionette.disconnect().catch(() => undefined);
        throw new ZenLaunchError(
          "Zen MCP lost its Marionette session with the browser it started. " +
            "The port stays closed after lockdown, so this server cannot re-attach. " +
            "Quit that Zen window and launch again."
        );
      }
      if (await isPortOpen(this.config.marionettePort)) {
        throw new ZenLaunchError(
          `Marionette is listening on port ${this.config.marionettePort}, but this ` +
            "harness only controls a browser it launched itself. Quit that Zen " +
            "instance and try again."
        );
      }
      if (!allowLaunch) {
        throw new ZenLaunchError(
          "Zen is not running. Start it with zen_launch, or keep the MCP server " +
            "running with auto-launch enabled."
        );
      }
      await this.#launchOwnedBrowser();
      launched = true;
    }

    let injection: InjectionSummary;
    try {
      injection = await this.#ops.ensureInjected({ force: launched, waitMs: 30_000 });
      if (this.#ops.connectionCount === 0) {
        const detail = injection.errors.length ? ` Last error: ${injection.errors[0]}` : "";
        throw new Error(
          `Zen is running, but the agent bridge could not attach to a window.${detail}`
        );
      }
    } catch (error) {
      await this.#closeOwnedBrowser("the agent bridge could not attach");
      throw error;
    }

    await this.#ensureConsent();
    this.#startAutoAttach();
    return { launched, injection };
  }

  async #launchOwnedBrowser(): Promise<void> {
    const result = await launchZen({ config: this.config, wait: false });
    const ownership: Ownership = {
      nonce: result.nonce,
      launchedPid: result.pid,
      browserPid: null,
      profile: resolvedProfilePath(this.config),
      launchedAt: Date.now(),
    };
    this.#ownership = ownership;
    try {
      await this.#verifyOwnedSession(ownership);
    } catch (error) {
      if (this.#ownership === ownership) {
        await this.#closeOwnedBrowser("startup failed");
      }
      if (error instanceof ZenLaunchError) throw error;
      throw new ZenLaunchError(
        `Zen started, but ownership could not be established: ${errorText(error)}`
      );
    }
  }

  async #verifyOwnedSession(ownership: Ownership): Promise<void> {
    const deadline = Date.now() + this.config.launchTimeoutMs;
    let lastError: unknown = null;
    for (;;) {
      try {
        await this.marionette.connect();
        break;
      } catch (error) {
        lastError = error;
        if (Date.now() >= deadline) {
          throw new ZenLaunchError(
            `Zen started, but Marionette did not accept a session within ` +
              `${Math.round(this.config.launchTimeoutMs / 1000)}s: ${errorText(lastError)}`
          );
        }
        await sleep(250);
      }
    }

    let nonce: string | null = null;
    try {
      nonce = await this.marionette.executeChrome<string | null>(
        [
          'const env = typeof Services !== "undefined" && Services.env',
          "  ? Services.env",
          '  : typeof Cc !== "undefined" && typeof Ci !== "undefined"',
          '    ? Cc["@mozilla.org/process/environment;1"].getService(Ci.nsIEnvironment)',
          "    : null;",
          "if (!env) throw new Error('Chrome scope is unavailable for the nonce check');",
          'return env.get("ZEN_CONTROL_LAUNCH_NONCE") || null;',
        ].join("\n"),
        { timeoutMs: 10_000 }
      );
    } catch (error) {
      throw new ZenLaunchError(`The launch nonce could not be read: ${errorText(error)}`);
    }
    if (!nonce || nonce !== ownership.nonce) {
      throw new ZenLaunchError(
        "The browser answering on the Marionette port was not the one just " +
          "started, so it was not attached. Another process may be racing for the port."
      );
    }

    ownership.browserPid = this.marionette.browserProcessId;
    this.#identityVerified = true;

    const lockdown = await this.marionette.lockdown();
    if (!lockdown.ok) {
      throw new ZenLaunchError(`Marionette could not be locked down: ${lockdown.reason ?? lockdown.error ?? "unknown reason"}`);
    }
    this.#lockedDown = true;
    this.#logger.info(`took exclusive control of Zen (pid ${ownership.browserPid ?? "unknown"})`);
  }

  async #ensureConsent(): Promise<void> {
    this.#ops.configureActiveBanner({
      text: "Zen MCP is connected",
      detail: "Press Pause to block reads and changes immediately.",
    });
    if (this.#ops.consentState === "granted" || !this.config.requireConsent) {
      this.#ops.grantAccess();
      return;
    }

    const profile = resolvedProfilePath(this.config);
    const consent: UiConsent = {
      id: `c-${randomUUID().slice(0, 8)}`,
      title: "Let Zen MCP control Zen?",
      detail: [
        "This MCP session can read tabs, open pages and organize spaces when you ask it to.",
        profile
          ? "It runs in a separate agent profile, so your normal browsing profile stays isolated."
          : "It uses your normal Zen profile, so it can see pages where you are signed in.",
        "Only this session can connect: the Marionette port is closed to everything else. Press Pause at any time.",
      ].join("\n\n"),
      allowLabel: "Allow this session",
      denyLabel: "Not now",
    };
    const seconds = Math.max(1, this.config.consentTimeoutSeconds);
    const outcome = await this.#ops.requestConsent({
      consent,
      timeoutMs: seconds * 1000,
    });
    if (outcome === "granted") {
      this.#ops.grantAccess();
      return;
    }
    if (outcome === "denied") {
      await this.#closeOwnedBrowser("access was declined in the browser");
      throw new ZenAccessError(
        "consent_required",
        "Browser access was declined in Zen. The browser this server started was closed."
      );
    }
    throw new ZenAccessError(
      "consent_required",
      `Zen MCP is waiting for approval in Zen. Approve the card within ${seconds}s, then call the tool again.`
    );
  }

  async #closeOwnedBrowser(reason: string): Promise<void> {
    const ownership = this.#ownership;
    const verified = this.#identityVerified;
    const browserPid =
      (verified ? this.marionette.browserProcessId : null) ??
      ownership?.browserPid ??
      null;

    this.#ownership = null;
    this.#identityVerified = false;
    this.#lockedDown = false;

    try {
      if (this.marionette.isConnected) {
        if (verified) {
          await this.marionette.quit().catch(() => undefined);
          if (await waitForProcessExit(browserPid, 2_500)) return;
          await this.marionette.quit({ force: true }).catch(() => undefined);
          if (await waitForProcessExit(browserPid, 2_000)) return;
        }
        await this.marionette.disconnect().catch(() => undefined);
      }
      const pid = browserPid ?? ownership?.launchedPid ?? null;
      if (pid) {
        terminateZenProcess(pid);
        await waitForProcessExit(pid, 3_000);
      }
    } catch {
      // Best effort: the browser may already be gone.
    } finally {
      await this.marionette.disconnect().catch(() => undefined);
    }
    this.#logger.debug(`closed the agent browser (${reason})`);
  }

  #startAutoAttach(): void {
    if (this.#autoAttachTimer || !this.config.autoAttachWindows) return;
    this.#autoAttachTimer = setInterval(() => {
      if (this.#closed || this.#autoAttaching || this.#ops.busy) return;
      this.#autoAttaching = true;
      this.#ops
        .ensureInjected({ force: true, waitMs: 6_000 })
        .catch((error) => this.#logger.debug(`auto-attach failed: ${errorText(error)}`))
        .finally(() => {
          this.#autoAttaching = false;
        });
    }, AUTO_ATTACH_MS);
    this.#autoAttachTimer.unref?.();
  }

  async checkForUpdates(options: { statePath?: string } = {}): Promise<void> {
    if (process.env.ZEN_CONTROL_NO_UPDATE_CHECK === "1") {
      return;
    }
    let info: UpdateInfo;
    try {
      info = await this.#checkUpdate();
    } catch (error) {
      this.#logger.debug(`update check failed: ${errorText(error)}`);
      return;
    }
    if (!info.updateAvailable || !info.latestVersion) return;
    const path = options.statePath ?? join(dataDirPath(), "update.json");
    const prompt = shouldPromptUpdate(readUpdatePromptState(path).promptedVersion, info.latestVersion);
    if (prompt) writeUpdatePromptState(path, { promptedVersion: info.latestVersion });
    this.#ops.setUpdateNotice({
      state: prompt ? "prompt" : "icon",
      currentVersion: info.currentVersion,
      latestVersion: info.latestVersion,
    });
  }

  async installUpdate(): Promise<{ ok: boolean; message?: string }> {
    if (this.#installUpdate) return this.#installUpdate();
    const manager = detectPackageManager();
    const { command, args } = updateCommand(manager);
    this.#logger.info(`installing ${PACKAGE_NAME}@latest with ${manager}`);
    const code = await runInstaller(command, args, { stdio: "ignore" });
    return code === 0
      ? { ok: true }
      : { ok: false, message: `${command} ${args.join(" ")} exited with code ${code}.` };
  }

  request<T extends BridgeMethod>(
    method: T,
    params: BridgeMethodMap[T]["params"],
    options: {
      windowId?: string;
      timeoutMs?: number;
      allowLaunch?: boolean;
      signal?: AbortSignal;
    } = {}
  ): Promise<BridgeMethodMap[T]["result"]> {
    return this.connect({ allowLaunch: options.allowLaunch }).then(() =>
      this.#ops.request(method, params, {
        windowId: options.windowId,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      })
    );
  }

  async status(windowId?: string): Promise<BridgeStatus> {
    await this.connect();
    return this.#ops.request("status", undefined, { windowId });
  }

  async ask(
    question: string,
    options: UiOption[],
    askOptions: AskOptions = {}
  ): Promise<AskResult> {
    try {
      await this.connect();
    } catch (error) {
      this.#logger.warn(`cannot show question: ${errorText(error)}`);
      return {
        status: "unavailable",
        questionId: "",
        message: "Zen is not attached, so the question could not be shown in the browser.",
      };
    }
    return this.#ops.ask(question, options, askOptions);
  }

  async notify(options: NotifyOptions): Promise<{ delivered: boolean; windowId?: string }> {
    try {
      await this.connect();
    } catch {
      return { delivered: false };
    }
    return this.#ops.notify(options);
  }

  progress(options: ProgressOptions): ProgressResult {
    return this.#ops.progress(options);
  }

  events(options: EventsOptions = {}): Promise<EventsResult> {
    return this.#ops.events(options);
  }

  answers(): AnswersResult {
    return this.#ops.answers();
  }

  #urlPermitted(url: string): boolean {
    return isUrlAllowed(url, this.config.allowedDomains);
  }

  #assertUrlAllowed(url: string, action: string): void {
    if (this.#urlPermitted(url)) return;
    throw new ZenAccessError(
      "domain_not_allowed",
      `${action} ${hostOf(url) ?? url}, which is outside the configured domain allowlist.`
    );
  }

  async readPage(options: ReadPageOptions = {}): Promise<PageReadResult> {
    await this.connect();
    const format = options.format ?? "text";
    const supportsDelta = format === "text" || format === "markdown";

    if (options.since) {
      if (!supportsDelta || options.offset || options.selector || options.framePath?.length) {
        throw new BridgeRequestError(
          "invalid_args",
          "since only works with a full text or markdown read of one document."
        );
      }
      const baseline = this.#deltas.get(options.since);
      if (!baseline) {
        throw new BridgeRequestError(
          "invalid_args",
          "The since token is unknown or expired. Do a full read first and pass its deltaToken."
        );
      }
      const tabId = options.tabId ?? baseline.tabId;
      const signature = await this.hub.readSignature(
        { tabId },
        options.windowId,
        { signal: options.signal }
      );
      if (signature.documentId === baseline.documentId &&
          signature.textHash === baseline.textHash &&
          signature.textLength === baseline.textLength) {
        return {
          title: signature.title,
          url: signature.url,
          selectedText: "",
          text: "",
          truncated: false,
          length: signature.textLength,
          offset: 0,
          nextOffset: null,
          description: null,
          format,
          changed: false,
          deltaToken: options.since,
        };
      }
      const page = options.tabId
        ? await readTabPage(this.hub, tabId, { ...options, tabId, format })
        : await readActivePage(this.hub, { ...options, format });
      if (page.url) this.#assertUrlAllowed(page.url, "Refusing to return content from");
      for (const frame of page.frames ?? []) {
        if (frame.url) this.#assertUrlAllowed(frame.url, "Refusing to return frame content from");
      }
      const delta = diffText(baseline.text, page.text);
      const token = this.#deltas.create(
        tabId, page.text, signature.documentId, page.url,
        { textHash: signature.textHash, textLength: signature.textLength }
      );
      return {
        ...page,
        text: delta.added,
        truncated: delta.truncated,
        nextOffset: null,
        changed: true,
        deltaToken: token,
        delta,
      };
    }

    const page = options.tabId
      ? await readTabPage(this.hub, options.tabId, options)
      : await readActivePage(this.hub, options);
    if (page.url) this.#assertUrlAllowed(page.url, "Refusing to return content from");
    for (const frame of page.frames ?? []) {
      if (frame.url) this.#assertUrlAllowed(frame.url, "Refusing to return frame content from");
    }
    if (supportsDelta && page.text) {
      const tabId = options.tabId ?? (await this.hub.status(options.windowId)).activeTab?.id ?? "";
      try {
        const signature = await this.hub.readSignature(
          { tabId }, options.windowId, { signal: options.signal }
        );
        const token = this.#deltas.create(
          tabId, page.text, signature.documentId, page.url,
          { textHash: signature.textHash, textLength: signature.textLength }
        );
        return { ...page, deltaToken: token };
      } catch {
        // A failed signature probe must not fail the read itself.
      }
    }
    return page;
  }

  async readPages(options: BatchReadOptions): Promise<BatchReadResult> {
    await this.connect();
    const ids = [...new Set(options.tabIds.map((id) => String(id)))]
      .filter(Boolean)
      .slice(0, MAX_BATCH_READ);
    const pages: BatchReadEntry[] = new Array(ids.length);
    let next = 0;
    let completed = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= ids.length) return;
        const tabId = ids[index] as string;
        try {
          const page = await this.#ops.request(
            "tabs.read",
            {
              tabId,
              maxChars: options.maxChars,
              offset: options.offset,
              format: options.format,
              selector: options.selector,
              allowedDomains: this.config.allowedDomains,
            },
            { windowId: options.windowId, signal: options.signal }
          );
          if (page.url) this.#assertUrlAllowed(page.url, "Refusing to return content from");
          for (const frame of page.frames ?? []) {
            if (frame.url) this.#assertUrlAllowed(frame.url, "Refusing to return frame content from");
          }
          pages[index] = { tabId, ok: true, title: page.title, url: page.url, page };
        } catch (error) {
          pages[index] = { tabId, ok: false, error: errorText(error) };
        } finally {
          completed += 1;
          options.onProgress?.(completed, ids.length);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(READ_CONCURRENCY, ids.length) }, worker)
    );
    return { pages: pages.filter((entry): entry is BatchReadEntry => entry !== undefined) };
  }

  async clickElement(options: ClickOptions): Promise<ClickElementResult> {
    await this.connect();
    const tabId = String(options.tabId ?? "").trim();
    if (!tabId) throw new Error("tabId is required");
    const result = await this.#ops.request(
      "tabs.click",
      {
        tabId,
        ...(options.ref ? { ref: options.ref } : {}),
        ...(options.selector ? { selector: options.selector } : {}),
        ...(options.target ? { target: options.target } : {}),
        allowedDomains: this.config.allowedDomains,
      },
      { windowId: options.windowId, signal: options.signal }
    );
    if (result.url) this.#assertUrlAllowed(result.url, "Refusing to act on");
    if (result.frameUrl) this.#assertUrlAllowed(result.frameUrl, "Refusing to act in frame");
    return result;
  }

  async typeText(options: TypeOptions): Promise<TypeTextResult> {
    await this.connect();
    const tabId = String(options.tabId ?? "").trim();
    if (!tabId) throw new Error("tabId is required");
    const result = await this.#ops.request(
      "tabs.type",
      {
        tabId,
        text: String(options.text ?? ""),
        ...(options.ref ? { ref: options.ref } : {}),
        ...(options.selector ? { selector: options.selector } : {}),
        ...(options.target ? { target: options.target } : {}),
        ...(options.clear === true ? { clear: true } : {}),
        allowedDomains: this.config.allowedDomains,
      },
      { windowId: options.windowId, signal: options.signal }
    );
    if (result.url) this.#assertUrlAllowed(result.url, "Refusing to act on");
    if (result.frameUrl) this.#assertUrlAllowed(result.frameUrl, "Refusing to act in frame");
    return result;
  }

  async waitFor(options: WaitOptions): Promise<WaitForResult> {
    await this.connect();
    const tabId = String(options.tabId ?? "").trim();
    if (!tabId) throw new Error("tabId is required");
    const result = await this.#ops.request(
      "tabs.waitFor",
      {
        tabId,
        ...(options.selector ? { selector: options.selector } : {}),
        ...(options.state ? { state: options.state } : {}),
        ...(options.text ? { text: options.text } : {}),
        ...(options.urlContains ? { urlContains: options.urlContains } : {}),
        ...(options.titleContains ? { titleContains: options.titleContains } : {}),
        ...(options.documentChanged ? { documentChanged: true } : {}),
        ...(options.documentId ? { documentId: options.documentId } : {}),
        ...(options.newTab ? { newTab: true } : {}),
        ...(options.tabClosed ? { tabClosed: true } : {}),
        ...(options.dialog ? { dialog: true } : {}),
        ...(options.until ? { until: options.until } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
        ...(options.framePath ? { framePath: options.framePath } : {}),
        allowedDomains: this.config.allowedDomains,
      },
      { windowId: options.windowId, signal: options.signal }
    );
    if (result.url) this.#assertUrlAllowed(result.url, "Refusing to wait on");
    if (result.frameUrl) this.#assertUrlAllowed(result.frameUrl, "Refusing to wait in frame");
    return result;
  }

  /** Finds an open tab and the window that holds it. */
  async findTab(tabId: string): Promise<{ tab: TabInfo; windowId: string } | null> {
    for (const window of this.#ops.connectedWindows()) {
      try {
        const listing = await this.#ops.request("tabs.list", { limit: 2_000 }, {
          windowId: window.windowId,
        });
        const tab = listing.tabs.find((candidate) => candidate.id === tabId);
        if (tab) return { tab, windowId: window.windowId };
      } catch {
        // The window may have disappeared between enumeration and listing.
      }
    }
    return null;
  }

  async #findTabByUrl(url: string): Promise<{ tab: TabInfo; windowId: string } | null> {
    const wanted = comparableUrl(url);
    const windows = [...this.#ops.connectedWindows()].sort(
      (a, b) => Number(b.focused) - Number(a.focused)
    );
    let fallback: { tab: TabInfo; windowId: string } | null = null;
    for (const window of windows) {
      try {
        const listing = await this.#ops.request("tabs.list", { limit: 2_000 }, {
          windowId: window.windowId,
        });
        for (const tab of listing.tabs) {
          if (!tabMatchesUrl(tab, wanted)) continue;
          if (tab.active) return { tab, windowId: window.windowId };
          if (!fallback) fallback = { tab, windowId: window.windowId };
        }
      } catch {
        // Keep looking in the other windows.
      }
    }
    return fallback;
  }

  async findText(options: FindTextOptions): Promise<TextSearchResult> {
    await this.connect();
    const tabId = String(options.tabId ?? "").trim();
    const query = String(options.query ?? "").trim();
    if (!tabId) throw new Error("tabId is required");
    if (!query) throw new Error("query is required");
    const empty = (error: EvidenceFailure): TextSearchResult => ({
      ok: false,
      tabId,
      url: "",
      title: "",
      query,
      matches: [],
      totalMatches: 0,
      truncated: false,
      error,
    });

    const found = await this.findTab(tabId);
    if (!found) {
      return empty({
        code: "PAGE_NOT_FOUND",
        message: `No open tab matches id "${tabId}". Call zen_tabs_list for current ids.`,
      });
    }
    if (!this.#urlPermitted(found.tab.url)) {
      return {
        ...empty({
          code: "UNSUPPORTED_PAGE",
          message: "This tab is outside the configured domain allowlist, so its text was not searched.",
        }),
        url: found.tab.url,
        title: found.tab.title,
      };
    }
    try {
      return await this.#ops.request(
        "tabs.findText",
        {
          tabId,
          query,
          caseSensitive: options.caseSensitive === true,
          maxMatches: options.maxMatches,
          contextChars: options.contextChars,
        },
        { windowId: found.windowId, timeoutMs: 20_000 }
      );
    } catch (error) {
      return {
        ...empty(evidenceFailureFromError(error)),
        url: found.tab.url,
        title: found.tab.title,
      };
    }
  }

  async searchTabs(options: SearchTabsOptions): Promise<SearchTabsResult> {
    await this.connect();
    const query = String(options.query ?? "").trim();
    if (!query) throw new Error("query is required");
    const maxTabs = clampInt(options.maxTabs, 1, 30, 20);
    const perTab = clampInt(options.maxMatchesPerTab, 1, 20, 5);
    const contextChars = clampInt(options.contextChars, 0, 300, 80);
    const results: SearchTabsEntry[] = [];
    const candidates: Array<{ tab: TabInfo; windowId: string }> = [];
    let skipped = 0;

    const requested = Array.isArray(options.tabIds)
      ? [...new Set(options.tabIds.map((id) => String(id).trim()))].filter(Boolean).slice(0, maxTabs)
      : [];
    if (requested.length > 0) {
      for (const tabId of requested) {
        const found = await this.findTab(tabId);
        if (!found) {
          results.push({
            tabId,
            ok: false,
            url: "",
            title: "",
            matches: [],
            totalMatches: 0,
            truncated: false,
            error: { code: "PAGE_NOT_FOUND", message: `No open tab matches id "${tabId}".` },
          });
          continue;
        }
        if (!this.#urlPermitted(found.tab.url)) {
          skipped += 1;
          results.push({
            tabId,
            ok: false,
            url: found.tab.url,
            title: found.tab.title,
            matches: [],
            totalMatches: 0,
            truncated: false,
            error: {
              code: "UNSUPPORTED_PAGE",
              message: "This tab is outside the configured domain allowlist, so its text was not searched.",
            },
          });
          continue;
        }
        candidates.push(found);
      }
    } else {
      const windows = [...this.#ops.connectedWindows()].sort(
        (a, b) => Number(b.focused) - Number(a.focused)
      );
      for (const window of windows) {
        let listing;
        try {
          listing = await this.#ops.request("tabs.list", {
            space: options.space,
            limit: 2_000,
          }, { windowId: window.windowId });
        } catch {
          continue;
        }
        for (const tab of listing.tabs) {
          if (!isHttpPage(tab.url) || !this.#urlPermitted(tab.url)) {
            skipped += 1;
            continue;
          }
          candidates.push({ tab, windowId: window.windowId });
          if (candidates.length >= maxTabs) break;
        }
        if (candidates.length >= maxTabs) break;
      }
    }

    const entries: Array<SearchTabsEntry | null> = new Array(candidates.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= candidates.length) return;
        const candidate = candidates[index] as { tab: TabInfo; windowId: string };
        try {
          const found = await this.#ops.request(
            "tabs.findText",
            {
              tabId: candidate.tab.id,
              query,
              caseSensitive: options.caseSensitive === true,
              maxMatches: perTab,
              contextChars,
            },
            { windowId: candidate.windowId, timeoutMs: SEARCH_TAB_TIMEOUT_MS }
          );
          entries[index] = searchEntry(found);
        } catch (error) {
          entries[index] = {
            tabId: candidate.tab.id,
            ok: false,
            url: candidate.tab.url,
            title: candidate.tab.title,
            matches: [],
            totalMatches: 0,
            truncated: false,
            error: evidenceFailureFromError(error),
          };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SEARCH_CONCURRENCY, candidates.length) }, worker)
    );

    const all = [
      ...results,
      ...entries.filter((entry): entry is SearchTabsEntry => entry !== null),
    ].sort((a, b) => Number(b.matches.length > 0) - Number(a.matches.length > 0));
    const totalMatches = all.reduce((sum, entry) => sum + entry.totalMatches, 0);
    let remaining = MAX_SEARCH_MATCHES;
    for (const entry of all) {
      if (entry.matches.length > remaining) {
        entry.matches = entry.matches.slice(0, Math.max(0, remaining));
        entry.truncated = true;
      }
      remaining -= entry.matches.length;
    }
    return {
      query,
      tabsSearched: candidates.length,
      tabsMatched: all.filter((entry) => entry.matches.length > 0).length,
      totalMatches,
      skipped,
      truncated: totalMatches > MAX_SEARCH_MATCHES || all.some((entry) => entry.truncated),
      results: all,
    };
  }

  async #bringTabForward(
    tabId: string,
    windowId: string
  ): Promise<{ focused: boolean; limitation?: string }> {
    try {
      const selected = await this.#ops.request(
        "tabs.select",
        { tabId, focusWindow: true },
        { windowId, timeoutMs: 30_000 }
      );
      if (selected.tab.active !== true) {
        return {
          focused: false,
          limitation: "Zen did not activate the source tab, so it may still be in the background.",
        };
      }
      if (selected.windowFocused === false) {
        return {
          focused: true,
          limitation: "The source tab is active, but the Zen window could not be raised.",
        };
      }
      return { focused: true };
    } catch (error) {
      return { focused: false, limitation: `Could not bring the source tab forward: ${errorText(error)}` };
    }
  }

  #rememberEvidence(tabId: string, windowId: string): void {
    this.#evidenceTargets.set(tabId, { windowId, updatedAt: Date.now() });
    while (this.#evidenceTargets.size > MAX_EVIDENCE_TARGETS) {
      let oldest: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, entry] of this.#evidenceTargets) {
        if (entry.updatedAt < oldestAt) {
          oldestAt = entry.updatedAt;
          oldest = id;
        }
      }
      if (!oldest) break;
      this.#evidenceTargets.delete(oldest);
    }
  }

  async showEvidence(options: ShowEvidenceOptions): Promise<EvidenceShowResult> {
    await this.connect();
    const requested = String(options.url ?? "").trim();
    const sourceUrl = normalizeEvidenceUrl(requested);
    const claim = options.claim?.trim() || undefined;
    const focus = options.focus === true;
    const failure = (
      error: EvidenceFailure,
      target?: { tabId: string | null; url: string; title: string; reused: boolean }
    ): EvidenceShowResult => ({
      ok: false,
      tabId: target?.tabId ?? null,
      tabReused: target?.reused ?? false,
      focused: false,
      sourceUrl: sourceUrl ?? requested,
      url: target?.url ?? sourceUrl ?? requested,
      title: target?.title ?? options.sourceTitle?.trim() ?? "",
      claim,
      error,
    });

    if (!sourceUrl) {
      return failure({
        code: "UNSUPPORTED_PAGE",
        message: "Evidence Mode only inspects http(s) URLs. Browser-internal and local pages are not supported.",
      });
    }
    if (!this.#urlPermitted(sourceUrl)) {
      return failure({
        code: "UNSUPPORTED_PAGE",
        message: `${sourceUrl} is outside the configured domain allowlist.`,
      });
    }

    let target: { tab: TabInfo; windowId: string; reused: boolean } | null = null;
    const requestedTab = options.tabId?.trim();
    if (requestedTab) {
      const found = await this.findTab(requestedTab);
      if (found && tabMatchesUrl(found.tab, sourceUrl)) {
        target = { ...found, reused: true };
      }
    }
    if (!target) {
      const found = await this.#findTabByUrl(sourceUrl);
      if (found) target = { ...found, reused: true };
    }
    if (!target) {
      try {
        const opened = await this.#ops.request("tabs.open", {
          urls: [sourceUrl],
          background: !focus,
          switchTo: focus,
        });
        const tab = opened.tabs[0];
        if (!tab) throw new Error("Zen did not return the opened tab");
        target = { tab, windowId: tab.windowId, reused: false };
      } catch (error) {
        return failure({
          code: "PAGE_NOT_FOUND",
          message: `Could not open ${sourceUrl}: ${errorText(error)}`,
        });
      }
    }
    if (!this.#urlPermitted(target.tab.url)) {
      return failure(
        {
          code: "UNSUPPORTED_PAGE",
          message: "The source tab is outside the configured domain allowlist.",
        },
        {
          tabId: null,
          url: target.tab.url,
          title: target.tab.title,
          reused: target.reused,
        }
      );
    }

    let focused = false;
    let focusLimitation: string | undefined;
    if (focus) {
      const brought = await this.#bringTabForward(target.tab.id, target.windowId);
      focused = brought.focused;
      focusLimitation = brought.limitation;
    }
    this.#rememberEvidence(target.tab.id, target.windowId);

    let op: EvidenceOpResult;
    try {
      op = await this.#ops.request(
        "tabs.evidence",
        {
          tabId: target.tab.id,
          quote: options.quote,
          context: options.context?.trim() || undefined,
          minConfidence: options.minConfidence,
          highlightMs: options.highlightMs,
        },
        { windowId: target.windowId, signal: options.signal, timeoutMs: 45_000 }
      );
    } catch (error) {
      op = {
        ok: false,
        tabId: target.tab.id,
        url: target.tab.url,
        title: target.tab.title,
        error: evidenceFailureFromError(error),
      };
    }

    const result: EvidenceShowResult = {
      ...op,
      tabId: op.tabId ?? target.tab.id,
      url: op.url || target.tab.url,
      title: op.title || target.tab.title || options.sourceTitle?.trim() || "",
      tabReused: target.reused,
      focused,
      sourceUrl,
      claim,
    };
    if (focusLimitation) result.limitation = joinLimitation(result.limitation, focusLimitation);

    const delivered = await this.#ops
      .notify({
        title: evidenceCardTitle(result),
        detail: evidenceCardDetail(result, options.quote, options.sourceTitle),
        tone: result.ok ? (result.highlighted ? "success" : "warning") : "warning",
        action:
          !focus && result.tabId ? { label: "Show source", tab: result.tabId } : undefined,
        autoHideMs: Math.max(10_000, Math.min(120_000, Number(options.highlightMs) || 25_000)),
        windowId: target.windowId,
      })
      .then((response) => response.delivered)
      .catch(() => false);
    if (!delivered) {
      result.limitation = joinLimitation(
        result.limitation,
        "The in-browser summary card could not be shown."
      );
    }
    return result;
  }

  async showEvidenceBatch(
    options: ShowEvidenceBatchOptions
  ): Promise<EvidenceBatchResult> {
    await this.connect();
    const focus = options.focus === true;
    const requested = Array.isArray(options.citations) ? options.citations : [];
    const total = requested.length;
    const rejected = (error: EvidenceFailure): EvidenceBatchResult => ({
      ok: false,
      total,
      matched: 0,
      verified: 0,
      failed: total,
      openedTabs: 0,
      reusedTabs: 0,
      focused: false,
      results: [],
      error,
    });

    if (total === 0) {
      return rejected({ code: "UNSUPPORTED_PAGE", message: "Provide at least one citation." });
    }
    if (total > MAX_EVIDENCE_BATCH) {
      return rejected({
        code: "UNSUPPORTED_PAGE",
        message: `A batch holds at most ${MAX_EVIDENCE_BATCH} citations. Split it into smaller calls.`,
      });
    }

    const citations: EvidenceCitation[] = [];
    for (let index = 0; index < total; index += 1) {
      const citation = requested[index] as EvidenceCitation;
      const url = normalizeEvidenceUrl(String(citation?.url ?? ""));
      if (!url) {
        return rejected({
          code: "UNSUPPORTED_PAGE",
          message: `Citation ${index + 1} is not an http(s) URL.`,
        });
      }
      if (!this.#urlPermitted(url)) {
        return rejected({
          code: "UNSUPPORTED_PAGE",
          message: `Citation ${index + 1} (${url}) is outside the configured domain allowlist.`,
        });
      }
      const quote = typeof citation.quote === "string" ? citation.quote.trim() : "";
      if (!quote) throw new Error(`Citation ${index + 1} has an empty quote.`);
      citations.push({ ...citation, url, quote });
    }

    const perSource = new Map<string, number>();
    for (const citation of citations) {
      const key = comparableUrl(citation.url);
      perSource.set(key, (perSource.get(key) ?? 0) + 1);
    }
    for (const [url, count] of perSource) {
      if (count > MAX_QUOTES_PER_SOURCE) {
        throw new Error(
          `A batch may verify at most ${MAX_QUOTES_PER_SOURCE} quotes from one source (${url} has ${count}).`
        );
      }
    }

    const concurrency = clampInt(options.concurrency, 1, EVIDENCE_CONCURRENCY, 2);
    const windows = [...this.#ops.connectedWindows()].sort(
      (a, b) => Number(b.focused) - Number(a.focused)
    );
    const listings = await Promise.all(
      windows.map(async (window) => {
        try {
          const listing = await this.#ops.request("tabs.list", { limit: 2_000 }, {
            windowId: window.windowId,
          });
          return { windowId: window.windowId, tabs: listing.tabs };
        } catch {
          return { windowId: window.windowId, tabs: [] as TabInfo[] };
        }
      })
    );
    const byUrl = new Map<string, { tab: TabInfo; windowId: string }>();
    const byId = new Map<string, { tab: TabInfo; windowId: string }>();
    for (const listing of listings) {
      for (const tab of listing.tabs) {
        if (!isHttpPage(tab.url) || !this.#urlPermitted(tab.url)) continue;
        const entry = { tab, windowId: listing.windowId };
        const key = comparableUrl(tab.url);
        const current = byUrl.get(key);
        if (!current || (tab.active && !current.tab.active)) byUrl.set(key, entry);
        byId.set(tab.id, entry);
      }
    }

    const targets: Array<{ tab: TabInfo; windowId: string; reused: boolean } | null> =
      new Array(total).fill(null);
    const missing = new Set<string>();
    for (let index = 0; index < citations.length; index += 1) {
      const citation = citations[index] as EvidenceCitation;
      const requestedId = citation.tabId?.trim();
      if (requestedId) {
        const found = byId.get(requestedId);
        if (found && tabMatchesUrl(found.tab, citation.url)) {
          targets[index] = { ...found, reused: true };
          continue;
        }
      }
      const found = byUrl.get(comparableUrl(citation.url));
      if (found) {
        targets[index] = { ...found, reused: true };
        continue;
      }
      missing.add(citation.url);
    }

    const openedByUrl = new Map<string, { tab: TabInfo; windowId: string }>();
    let openError = "";
    if (missing.size > 0) {
      try {
        const opened = await this.#ops.request("tabs.open", {
          urls: [...missing],
          background: !focus,
          switchTo: focus,
        });
        for (const tab of opened.tabs) {
          const entry = { tab, windowId: tab.windowId };
          openedByUrl.set(comparableUrl(tab.url), entry);
          if (tab.requestedUrl) openedByUrl.set(comparableUrl(tab.requestedUrl), entry);
        }
      } catch (error) {
        openError = errorText(error);
      }
    }
    for (let index = 0; index < citations.length; index += 1) {
      if (targets[index]) continue;
      const opened = openedByUrl.get(comparableUrl((citations[index] as EvidenceCitation).url));
      if (opened) targets[index] = { ...opened, reused: false };
    }

    const firstIndex = targets.findIndex((target) => target !== null);
    const firstTarget = firstIndex >= 0 ? targets[firstIndex] : null;
    let firstFocused = false;
    let firstFocusLimitation: string | undefined;
    if (focus && firstTarget) {
      const brought = await this.#bringTabForward(firstTarget.tab.id, firstTarget.windowId);
      firstFocused = brought.focused;
      firstFocusLimitation = brought.limitation;
    }

    const openedIds = new Set<string>();
    const reusedIds = new Set<string>();
    for (const target of targets) {
      if (!target) continue;
      this.#rememberEvidence(target.tab.id, target.windowId);
      if (target.reused) reusedIds.add(target.tab.id);
      else openedIds.add(target.tab.id);
    }

    const highlightMs = clampInt(options.highlightMs, 1_000, 120_000, 20_000);
    const results: EvidenceShowResult[] = new Array(total);
    let next = 0;
    let completed = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= citations.length) return;
        try {
          const citation = citations[index] as EvidenceCitation;
          const target = targets[index];
          const claim = citation.claim?.trim() || undefined;
          if (!target) {
            results[index] = {
              ok: false,
              tabId: null,
              tabReused: false,
              focused: false,
              sourceUrl: citation.url,
              url: citation.url,
              title: citation.sourceTitle?.trim() || "",
              claim,
              error: {
                code: "PAGE_NOT_FOUND",
                message: `Could not open ${citation.url}.${openError ? ` ${openError}` : ""}`,
              },
            };
            continue;
          }
          let op: EvidenceOpResult;
          try {
            op = await this.#ops.request(
              "tabs.evidence",
              {
                tabId: target.tab.id,
                quote: citation.quote,
                ...(citation.context?.trim() ? { context: citation.context.trim() } : {}),
                ...(options.minConfidence !== undefined
                  ? { minConfidence: options.minConfidence }
                  : {}),
                highlightMs,
              },
              { windowId: target.windowId, signal: options.signal, timeoutMs: 45_000 }
            );
          } catch (error) {
            op = {
              ok: false,
              tabId: target.tab.id,
              url: target.tab.url,
              title: target.tab.title,
              error: evidenceFailureFromError(error),
            };
          }
          const result: EvidenceShowResult = {
            ...op,
            tabId: op.tabId ?? target.tab.id,
            url: op.url || target.tab.url,
            title: op.title || target.tab.title || citation.sourceTitle?.trim() || "",
            tabReused: target.reused,
            focused: firstFocused && firstTarget?.tab.id === target.tab.id,
            sourceUrl: citation.url,
            claim,
          };
          if (firstFocusLimitation && firstTarget?.tab.id === target.tab.id) {
            result.limitation = joinLimitation(result.limitation, firstFocusLimitation);
          }
          results[index] = result;
        } finally {
          completed += 1;
          options.onProgress?.(completed, total);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, citations.length) }, worker)
    );

    const matched = results.filter((result) => result.ok).length;
    const verified = results.filter((result) => result.verified === true).length;
    const unverified = matched - verified;
    const failed = total - matched;
    let limitation: string | undefined = firstFocusLimitation;
    const failures = results
      .filter((result) => !result.ok)
      .slice(0, MAX_BATCH_CARD_FAILURES)
      .map(
        (result) =>
          `${truncateText(collapseText(result.claim || result.sourceUrl), 90)} (${result.error?.code ?? "FAILED"})`
      );
    const cardWindow =
      firstTarget?.windowId ??
      [...this.#ops.connectedWindows()].find((window) => window.focused)?.windowId;
    const delivered = await this.#ops
      .notify({
        title:
          failed === 0 && unverified === 0
            ? `All ${total} citations verified`
            : `${verified} of ${total} citations verified`,
        detail: [
          `${matched} matched, ${failed} failed.`,
          unverified > 0 ? `${unverified} fuzzy match(es) need a manual check.` : "",
          failures.length ? `Failed: ${failures.join("; ")}` : "",
          openedIds.size ? `${openedIds.size} source tab(s) opened in the background.` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        tone: failed === 0 && unverified === 0 ? "success" : "warning",
        action:
          !focus && firstTarget ? { label: "Show source", tab: firstTarget.tab.id } : undefined,
        autoHideMs: Math.max(10_000, Math.min(120_000, highlightMs)),
        windowId: cardWindow,
      })
      .then((response) => response.delivered)
      .catch(() => false);
    if (!delivered) {
      limitation = joinLimitation(
        limitation,
        "The in-browser summary card could not be shown."
      );
    }

    return {
      ok: failed === 0 && unverified === 0,
      total,
      matched,
      verified,
      failed,
      openedTabs: openedIds.size,
      reusedTabs: reusedIds.size,
      focused: firstFocused,
      results,
      ...(limitation ? { limitation } : {}),
    };
  }

  async clearEvidence(options: ClearEvidenceOptions = {}): Promise<EvidenceClearOutcome> {
    await this.connect();
    const requested = options.tabId?.trim();
    const targets: Array<{ tabId: string; windowId?: string }> = [];
    if (requested) {
      const tracked = this.#evidenceTargets.get(requested);
      const found = tracked ? null : await this.findTab(requested);
      targets.push({ tabId: requested, windowId: tracked?.windowId ?? found?.windowId });
    } else {
      for (const [tabId, entry] of this.#evidenceTargets) {
        targets.push({ tabId, windowId: entry.windowId });
      }
    }
    if (targets.length === 0) return { cleared: false, tabId: null, removed: 0 };

    let removed = 0;
    let lastTab: string | null = null;
    let failure: EvidenceFailure | undefined;
    for (const target of targets) {
      try {
        const cleared = await this.#ops.request("tabs.evidenceClear", { tabId: target.tabId }, {
          windowId: target.windowId,
        });
        removed += cleared.removed;
        lastTab = target.tabId;
        this.#evidenceTargets.delete(target.tabId);
      } catch (error) {
        failure = evidenceFailureFromError(error);
        if (failure.code === "PAGE_NOT_FOUND") this.#evidenceTargets.delete(target.tabId);
      }
    }
    return {
      cleared: removed > 0,
      tabId: lastTab ?? requested ?? targets[0]?.tabId ?? null,
      removed,
      ...(failure ? { error: failure } : {}),
    };
  }

  async addWatch(
    params: WatchParams,
    options: { windowId?: string } = {}
  ): Promise<WatchInfo> {
    if (this.#watches.size + this.#watchReservations >= MAX_WATCHES) {
      throw new Error(
        `At most ${MAX_WATCHES} watches can run at once. Remove one first.`
      );
    }
    this.#watchReservations += 1;
    try {
      return await this.#createWatch(params, options);
    } finally {
      this.#watchReservations -= 1;
    }
  }

  async #createWatch(
    params: WatchParams,
    options: { windowId?: string } = {}
  ): Promise<WatchInfo> {
    await this.connect();
    const mode = params.mode ?? "change";
    if ((mode === "appear" || mode === "disappear") && !params.selector?.trim()) {
      throw new Error("selector is required for appear and disappear watches");
    }
    const listing = await this.#ops.request("tabs.list", { limit: 2_000 }, {
      windowId: options.windowId,
    });
    let tabId = params.tabId?.trim();
    if (!tabId) {
      const status = await this.#ops.request("status", undefined, {
        windowId: options.windowId,
      }) as BridgeStatus;
      tabId = status.activeTab?.id ?? undefined;
    }
    if (!tabId) throw new Error("There is no active tab to watch");
    const tab = listing.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`No open tab matches id "${tabId}". Call zen_tabs_list for current ids.`);
    this.#assertUrlAllowed(tab.url, "Refusing to watch");

    const intervalSeconds = Math.max(
      this.config.watchMinIntervalSeconds || 15,
      Math.min(3_600, Math.trunc(params.intervalSeconds ?? 60))
    );
    const maxMinutes = Math.max(
      1,
      Math.min(24 * 60, Math.trunc(params.maxMinutes ?? 120))
    );
    const now = Date.now();
    const info: WatchInfo = {
      id: `w-${randomUUID().slice(0, 8)}`,
      tabId,
      title: tab.title,
      url: tab.url,
      spaceId: tab.spaceId,
      mode,
      selector: params.selector?.trim() || null,
      contains: params.contains?.trim() || null,
      label: params.label?.trim() || tab.title || tab.url,
      intervalSeconds,
      createdAt: now,
      expiresAt: now + maxMinutes * 60_000,
      lastCheckedAt: null,
      lastError: null,
      changes: 0,
    };
    const entry: WatchRuntime = {
      info,
      timer: null,
      running: false,
      previousText: null,
      previousHash: "",
      previousFound: false,
      notify: params.notify !== false,
      windowId: options.windowId,
    };

    const baseline = await this.#readWatchSample(entry).catch(() => null);
    if (baseline) {
      entry.previousFound = baseline.found;
      if (baseline.page) {
        entry.previousText = baseline.page.text;
        entry.previousHash = hashText(baseline.page.text);
        info.lastCheckedAt = Date.now();
      }
    }
    entry.timer = setInterval(() => {
      void this.#checkWatch(info.id);
    }, intervalSeconds * 1000);
    entry.timer.unref?.();
    this.#watches.set(info.id, entry);
    return { ...info };
  }

  listWatches(): WatchInfo[] {
    return [...this.#watches.values()]
      .map((entry) => ({ ...entry.info }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  removeWatch(id: string): boolean {
    const entry = this.#watches.get(id);
    if (!entry) return false;
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = null;
    this.#watches.delete(id);
    return true;
  }

  async #readWatchSample(
    entry: WatchRuntime
  ): Promise<{ page: PageReadResult | null; found: boolean }> {
    try {
      const page = await this.#ops.request(
        "tabs.read",
        {
          tabId: entry.info.tabId,
          maxChars: MAX_WATCH_SAMPLE_CHARS,
          format: "text",
          selector: entry.info.selector ?? undefined,
          allowedDomains: this.config.allowedDomains,
        },
        { windowId: entry.windowId, timeoutMs: 40_000 }
      );
      if (page.url) this.#assertUrlAllowed(page.url, "Refusing to watch");
      return { page, found: true };
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "selector_not_found") return { page: null, found: false };
      throw error;
    }
  }

  async #checkWatch(id: string): Promise<void> {
    const entry = this.#watches.get(id);
    if (!entry || entry.running || this.#closed || this.#ops.paused) return;
    if (Date.now() >= entry.info.expiresAt) {
      this.#stopWatch(id, "Watch expired", `"${entry.info.label}" reached its time limit.`);
      return;
    }
    entry.running = true;
    try {
      const sample = await this.#readWatchSample(entry);
      entry.info.lastCheckedAt = Date.now();
      entry.info.lastError = null;

      if (entry.info.mode === "change") {
        if (!sample.page) return;
        const text = sample.page.text;
        const hash = hashText(text);
        if (entry.previousText === null && !entry.previousHash) {
          entry.previousText = text;
          entry.previousHash = hash;
          return;
        }
        if (hash === entry.previousHash) return;
        const phrase = entry.info.contains?.toLowerCase();
        entry.previousText = text;
        entry.previousHash = hash;
        if (phrase && !text.toLowerCase().includes(phrase)) return;
        this.#fireWatch(entry, `Watch: ${entry.info.label} changed`, previewText(text));
        return;
      }

      const appearing = entry.info.mode === "appear" ? sample.found : !sample.found;
      const changed = sample.found !== entry.previousFound;
      entry.previousFound = sample.found;
      if (!changed || !appearing) return;
      this.#fireWatch(
        entry,
        entry.info.mode === "appear"
          ? `Watch: ${entry.info.label} appeared`
          : `Watch: ${entry.info.label} disappeared`,
        entry.info.selector
          ? `Selector "${entry.info.selector}" ${
              entry.info.mode === "appear" ? "appeared" : "disappeared"
            } on ${entry.info.title}.`
          : `Page state changed on ${entry.info.title}.`
      );
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "domain_not_allowed") {
        this.#stopWatch(
          id,
          "Watch stopped",
          `"${entry.info.label}" left the allowed domains, so watching stopped.`
        );
        return;
      }
      if (code === "tab_not_found" || code === "bridge_disconnected" || code === "no_tab") {
        this.#stopWatch(
          id,
          "Watch stopped",
          `"${entry.info.label}" stopped because the tab closed or disconnected.`
        );
        return;
      }
      entry.info.lastError = errorText(error).slice(0, 300);
    } finally {
      entry.running = false;
    }
  }

  #fireWatch(entry: WatchRuntime, title: string, detail: string): void {
    entry.info.changes += 1;
    this.#ops.pushEvent({
      kind: "watch",
      title,
      detail: detail.slice(0, 400),
      tabId: entry.info.tabId,
      watchId: entry.info.id,
      windowId: entry.windowId,
    });
    if (!entry.notify) return;
    void this.#ops
      .notify({
        title,
        detail: detail.slice(0, 220),
        tone: "info",
        autoHideMs: 20_000,
        windowId: entry.windowId,
        action: entry.info.spaceId
          ? { label: "Open space", space: entry.info.spaceId }
          : undefined,
      })
      .catch(() => undefined);
  }

  #stopWatch(id: string, title: string, detail: string): void {
    const entry = this.#watches.get(id);
    if (!entry) return;
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = null;
    this.#watches.delete(id);
    this.#ops.pushEvent({
      kind: "watch",
      title,
      detail,
      tabId: entry.info.tabId,
      watchId: entry.info.id,
      windowId: entry.windowId,
    });
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#autoAttachTimer) clearInterval(this.#autoAttachTimer);
    this.#autoAttachTimer = null;
    for (const entry of this.#watches.values()) {
      if (entry.timer) clearInterval(entry.timer);
    }
    this.#watches.clear();
    await this.#ops.stop().catch(() => undefined);
    await this.#closeOwnedBrowser("the server is shutting down");
  }
}
