/**
 * Server side of the browser bridge.
 *
 * A loopback WebSocket server accepts connections from the injected bridge.
 * Each connection performs a fresh mutual HMAC handshake before it may send a
 * `hello`; only then can it receive requests. Consent and Pause are enforced at
 * this boundary, not just by MCP tools, so no caller can bypass them.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_RESOURCE_ALIAS, SERVER_VERSION } from "../shared/brand.js";
import {
  AUTH_FAILED_CLOSE,
  AUTH_NONCE_BYTES,
  AUTH_REQUIRED_CLOSE,
  AUTH_TIMEOUT_CLOSE,
  AUTH_TIMEOUT_MS,
  clientAuthMessage,
  serverAuthMessage,
} from "../shared/bridge-auth.js";
import { DefinedError } from "../shared/errors.js";
import {
  BRIDGE_PATH,
  BROWSER_EVENT_KINDS as BROWSER_KINDS,
  BROWSER_EVENT_PHASES as BROWSER_PHASES,
} from "../shared/protocol.js";
import type {
  ActivityTone,
  AgentEvent,
  AgentEventKind,
  AnswersResult,
  AnswerInboxEntry,
  AskResult,
  BridgeMethod,
  BridgeMethodMap,
  BridgeStatus,
  BridgeToServer,
  EventsResult,
  ServerToBridge,
  UiActivity,
  UiActivityAction,
  UiBanner,
  UiConsent,
  UiOption,
  UiProgress,
  UiQuestion,
  UiUpdateNotice,
} from "../shared/protocol.js";
import { hostOf, isUrlAllowed, normalizeWebUrl } from "../shared/url-policy.js";
import { createLogger, type Logger } from "../utils/logger.js";
import type { MarionetteClient } from "../zen/marionette.js";
import { EventLog } from "./event-log.js";

const PING_MS = 20_000;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_EVENT_WAIT_SECONDS = 25;
const MAX_EVENT_URL = 8_000;
const MAX_EVENT_TEXT = 300;
const MAX_EVENT_ID = 80;
const WS_OPEN = 1;
const CANCELLED = "The request was cancelled by the client.";

/** Structural view of the chrome-script entry point we need from Marionette. */
interface MarionetteLike {
  executeChrome<T = unknown>(body: string, options?: { timeoutMs?: number }): Promise<T>;
}

/** Error returned for a bridge request that reached the browser but failed. */
export class BridgeRequestError extends DefinedError {
  override name = "BridgeRequestError";
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

/** Error returned when no bridge is connected (or it went away mid-request). */
export class BridgeUnavailableError extends Error {
  override name = "BridgeUnavailableError";
}

export interface InjectionSummary {
  windows: number;
  injected: number;
  reused: number;
  reconnected: number;
  pending: number;
  errors: string[];
}

export interface AskOptions {
  timeoutSeconds?: number;
  waitSeconds?: number;
  allowFreeform?: boolean;
  multiSelect?: boolean;
  context?: string;
  windowId?: string;
}

export interface NotifyOptions {
  title: string;
  detail?: string;
  tone?: ActivityTone;
  autoHideMs?: number;
  action?: { label: string; space?: string; tab?: string };
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
  windowId?: string;
}

export interface ProgressResult {
  shown: boolean;
  stopRequested: boolean;
}

export type ConsentOutcome = "granted" | "denied" | "timeout";

export interface BridgeHubOptions {
  marionette: MarionetteClient;
  bridgeScriptPath?: string;
  logger?: Logger;
  allowedDomains: string[];
  installUpdate?: () => Promise<{ ok: boolean; message?: string }>;
  serverVersion?: string;
}

interface Connection {
  ws: WebSocket;
  windowId: string;
  focused: boolean;
  appVersion: string;
  platform: string;
  alive: boolean;
}

interface PendingRequest {
  id: string;
  method: string;
  windowId: string;
  cleanup(): void;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface PendingQuestion {
  question: UiQuestion;
  askedAt: number;
  deferred: boolean;
  answered: boolean;
  answer?: string;
  selectedLabels?: string[];
  freeform?: boolean;
  windowId: string | null;
  resolve: ((result: AskResult) => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingConsent {
  consent: UiConsent;
  state: "pending" | "granted" | "denied";
}

const EVENT_KINDS = new Set<string>(BROWSER_KINDS);
const EVENT_PHASES = new Set<string>(BROWSER_PHASES);
/** Only these kind/phase pairs are accepted from the browser. */
const EVENT_PAIRS = new Set<string>([
  "tab:opened", "tab:closed", "tab:selected",
  "navigation:started", "navigation:committed", "navigation:completed",
  "navigation:failed", "navigation:redirect", "navigation:same_document",
  "document:replaced", "dialog:shown", "dialog:hidden",
]);

const EVENT_TITLES: Record<string, string> = {
  "tab:opened": "Tab opened",
  "tab:closed": "Tab closed",
  "tab:selected": "Tab selected",
  "navigation:started": "Navigation started",
  "navigation:committed": "Navigation committed",
  "navigation:completed": "Navigation completed",
  "navigation:failed": "Navigation failed",
  "navigation:redirect": "Navigation redirected",
  "navigation:same_document": "Same-document navigation",
  "document:replaced": "Document replaced",
  "dialog:shown": "Dialog shown",
  "dialog:hidden": "Dialog hidden",
};

function emptySummary(): InjectionSummary {
  return { windows: 0, injected: 0, reused: 0, reconnected: 0, pending: 0, errors: [] };
}

function normalizeSummary(raw: unknown): InjectionSummary {
  const value = (raw ?? {}) as Partial<InjectionSummary>;
  const num = (input: unknown): number => (Number.isFinite(Number(input)) ? Number(input) : 0);
  return {
    windows: num(value.windows),
    injected: num(value.injected),
    reused: num(value.reused),
    reconnected: num(value.reconnected),
    pending: num(value.pending),
    errors: Array.isArray(value.errors) ? value.errors.map(String).slice(0, 10) : [],
  };
}

function isLoopback(address: string): boolean {
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendRaw(ws: WebSocket, message: ServerToBridge): boolean {
  if (ws.readyState !== WS_OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveBridgeScriptPath(): string {
  const candidates: string[] = [];
  const override = process.env.ZEN_CONTROL_BRIDGE_SCRIPT;
  if (override) candidates.push(override);
  try {
    candidates.push(fileURLToPath(new URL("./bridge.js", import.meta.url)));
  } catch { /* import.meta may be unavailable in some bundles. */ }
  try {
    candidates.push(fileURLToPath(new URL("../../dist/bridge.js", import.meta.url)));
  } catch { /* ignore */ }
  candidates.push(join(process.cwd(), "dist", "bridge.js"));
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? join(process.cwd(), "dist", "bridge.js");
}

export class BridgeHub {
  readonly #marionette: MarionetteLike;
  readonly #logger: Logger;
  readonly #serverVersion: string;
  readonly #token = randomBytes(32).toString("base64url");
  readonly #bridgeScriptPath: string;
  readonly #bridgeDir: string;
  readonly #bridgeFile: string;
  readonly #allowedDomains: string[];
  readonly #installer?: () => Promise<{ ok: boolean; message?: string }>;

  #server: WebSocketServer | null = null;
  #url: string | null = null;
  #port = 0;
  #started = false;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #requestSeq = 0;
  #primaryWindowId: string | null = null;
  #lastInjectAt = 0;
  #lastInjection: InjectionSummary | null = null;

  readonly #connections = new Map<string, Connection>();
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #pendingQuestions = new Map<string, PendingQuestion>();
  readonly #answeredQuestions: AnswerInboxEntry[] = [];
  readonly #consentWaiters = new Set<(outcome: ConsentOutcome) => void>();
  readonly #events = new EventLog();
  #eventWaiters: Array<() => void> = [];

  #accessGranted = false;
  #consent: PendingConsent | null = null;
  #paused = false;
  #pausedAt: number | null = null;
  #banner: UiBanner | null = null;
  #update: UiUpdateNotice | null = null;
  #installingUpdate = false;
  #progress: UiProgress | null = null;
  #stopRequestedAt: number | null = null;
  #filteredEvents = 0;
  #activeBanner: UiBanner = {
    state: "active",
    text: "Zen Control is controlling this window",
    detail: "Press Pause to block every read and change immediately.",
  };

  constructor(options: BridgeHubOptions) {
    this.#marionette = options.marionette as unknown as MarionetteLike;
    this.#logger = options.logger ?? createLogger("bridge");
    this.#serverVersion = options.serverVersion ?? SERVER_VERSION;
    this.#bridgeScriptPath = resolve(options.bridgeScriptPath ?? resolveBridgeScriptPath());
    this.#bridgeDir = dirname(this.#bridgeScriptPath);
    this.#bridgeFile = basename(this.#bridgeScriptPath);
    this.#allowedDomains = [...options.allowedDomains];
    this.#installer = options.installUpdate;
  }

  get port(): number { return this.#port; }
  get isStarted(): boolean { return this.#started; }
  get connectionCount(): number { return this.#connections.size; }
  get busy(): boolean { return this.#pendingRequests.size > 0; }
  get paused(): boolean { return this.#paused; }
  get pausedAt(): number | null { return this.#pausedAt; }
  get consentState(): "none" | "pending" | "granted" | "denied" {
    if (this.#accessGranted) return "granted";
    return this.#consent?.state ?? "none";
  }
  get banner(): UiBanner | null { return this.#composeBanner(this.#banner); }
  get primaryWindowId(): string | null { return this.#primaryWindowId; }
  get bridgeScriptPath(): string { return this.#bridgeScriptPath; }
  get updateNotice(): UiUpdateNotice | null { return this.#update; }
  get token(): string { return this.#token; }

  async start(): Promise<void> {
    if (this.#started) return;
    if (!existsSync(this.#bridgeScriptPath)) {
      throw new Error(
        `Bridge bundle not found at ${this.#bridgeScriptPath}. Build the bridge before starting the server.`
      );
    }
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: BRIDGE_PATH,
      perMessageDeflate: false,
      maxPayload: 2 * 1024 * 1024,
    });
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Could not determine the bridge WebSocket port");
    }
    this.#server = server;
    this.#port = address.port;
    this.#url = `ws://127.0.0.1:${this.#port}${BRIDGE_PATH}`;
    this.#started = true;
    server.on("connection", (ws, request) => this.#onConnection(ws, request));
    server.on("error", (error: Error) => this.#logger.error(`bridge server error: ${error.message}`));
    this.#pingTimer = setInterval(() => this.#heartbeat(), PING_MS);
    this.#pingTimer.unref?.();
    this.#logger.info(`bridge listening on 127.0.0.1:${this.#port}`);
  }

  #onConnection(ws: WebSocket, request: IncomingMessage): void {
    const remote = request.socket.remoteAddress ?? "";
    if (!isLoopback(remote)) {
      this.#logger.warn(`rejecting non-loopback bridge connection from ${remote}`);
      ws.close(AUTH_FAILED_CLOSE, "loopback only");
      return;
    }

    // A fresh nonce per connection makes every proof single-use; direction
    // labels stop a proof being replayed in the other direction.
    const serverNonce = randomBytes(AUTH_NONCE_BYTES).toString("base64url");
    const expectedProof = this.#proof(clientAuthMessage(serverNonce));
    let connection: Connection | null = null;
    let authenticated = false;
    let registered = false;
    const timer = setTimeout(() => {
      if (!registered) ws.close(AUTH_TIMEOUT_CLOSE, "handshake timeout");
    }, AUTH_TIMEOUT_MS);
    timer.unref?.();
    if (!sendRaw(ws, { type: "auth.challenge", nonce: serverNonce })) {
      clearTimeout(timer);
      ws.terminate();
      return;
    }

    ws.on("pong", () => {
      if (connection) connection.alive = true;
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let message: BridgeToServer;
      try {
        message = JSON.parse(data.toString("utf8")) as BridgeToServer;
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;

      if (!authenticated) {
        if (message.type !== "auth.response") {
          ws.close(AUTH_REQUIRED_CLOSE, "authentication required");
          return;
        }
        const clientNonce = typeof message.nonce === "string" ? message.nonce : "";
        const proof = typeof message.proof === "string" ? message.proof : "";
        if (!clientNonce || clientNonce.length > 512 || !tokensEqual(proof, expectedProof)) {
          this.#logger.warn("rejecting bridge connection with a bad auth proof");
          ws.close(AUTH_FAILED_CLOSE, "authentication failed");
          return;
        }
        authenticated = true;
        if (
          !sendRaw(ws, {
            type: "auth.confirm",
            nonce: clientNonce,
            proof: this.#proof(serverAuthMessage(clientNonce)),
          })
        ) {
          ws.terminate();
        }
        return;
      }

      if (message.type === "hello") {
        if (Number(message.protocol) !== BRIDGE_PROTOCOL_VERSION) {
          ws.close(4001, "bridge protocol mismatch");
          return;
        }
        if (String(message.bridgeVersion) !== this.#serverVersion) {
          ws.close(4002, "bridge version mismatch");
          return;
        }
        const windowId = String(message.windowId ?? "");
        if (!windowId) return;
        const existing = this.#connections.get(windowId);
        if (existing && existing.ws !== ws) existing.ws.close(4000, "replaced by a newer bridge");
        registered = true;
        clearTimeout(timer);
        connection = {
          ws,
          windowId,
          focused: message.focused === true,
          appVersion: String(message.appVersion ?? ""),
          platform: String(message.platform ?? ""),
          alive: true,
        };
        this.#connections.set(windowId, connection);
        if (connection.focused || !this.#primaryWindowId) this.#primaryWindowId = windowId;
        this.#logger.info(`bridge connected from window ${windowId}`);
        this.#send(connection, {
          type: "welcome", protocol: BRIDGE_PROTOCOL_VERSION, serverVersion: this.#serverVersion,
        });
        const banner = this.banner;
        if (banner) this.#send(connection, { type: "ui.banner", banner });
        if (this.#consent?.state === "pending") {
          this.#send(connection, { type: "ui.consent", consent: this.#consent.consent });
        }
        if (this.#progress) this.#send(connection, { type: "ui.progress", progress: this.#progress });
        this.#resendPendingQuestions(connection);
        return;
      }

      if (!registered || !connection) {
        ws.close(AUTH_REQUIRED_CLOSE, "hello required");
        return;
      }
      connection.alive = true;
      switch (message.type) {
        case "bridge.focus":
          connection.focused = message.focused === true;
          if (connection.focused) this.#primaryWindowId = connection.windowId;
          return;
        case "bridge.pong":
          return;
        case "browser.event":
          this.#onBrowserEvent(connection, message.event);
          return;
        case "ui.answer":
          this.#onAnswer(String(message.id ?? ""), message);
          return;
        case "ui.action":
          this.#logger.debug(`activity action ${message.actionId} from ${message.activityId}: ${message.ok}`);
          return;
        case "ui.stop":
          this.#onStop(connection, String(message.progressId ?? ""));
          return;
        case "ui.consentResult":
          this.#onConsentResult(String(message.id ?? ""), message.granted === true);
          return;
        case "ui.bannerAction":
          if (message.action === "pause") this.pause("The user paused Zen Control from the browser banner.");
          else if (message.action === "resume") this.resume();
          return;
        case "ui.updateAction":
          this.#onUpdateAction(message.action);
          return;
        case "res": {
          const pending = this.#pendingRequests.get(String(message.id ?? ""));
          if (!pending || pending.windowId !== connection.windowId) return;
          if (message.ok) pending.resolve(message.result);
          else {
            pending.reject(
              new BridgeRequestError(
                message.error?.code ?? "bridge_error",
                message.error?.message ?? "The bridge request failed",
                message.error?.details
              )
            );
          }
          return;
        }
        case "bridge.error":
          this.#logger.warn(`bridge error: ${String(message.message)}`);
          return;
        default:
          return;
      }
    });

    ws.on("close", () => {
      clearTimeout(timer);
      if (!connection || this.#connections.get(connection.windowId) !== connection) return;
      this.#connections.delete(connection.windowId);
      if (this.#primaryWindowId === connection.windowId) {
        this.#primaryWindowId = this.#connections.keys().next().value ?? null;
      }
      this.#logger.info(`bridge disconnected from window ${connection.windowId}`);
      for (const pending of [...this.#pendingRequests.values()]) {
        if (pending.windowId === connection.windowId) {
          pending.reject(
            new BridgeRequestError("bridge_disconnected", "The Zen window disconnected before the request finished")
          );
        }
      }
    });
    ws.on("error", (error: Error) => this.#logger.debug(`bridge socket error: ${error.message}`));
  }

  #heartbeat(): void {
    for (const connection of this.#connections.values()) {
      if (!connection.alive) {
        this.#logger.warn(`terminating unresponsive bridge in window ${connection.windowId}`);
        connection.ws.terminate();
        continue;
      }
      connection.alive = false;
      try {
        connection.ws.ping();
      } catch {
        connection.ws.terminate();
      }
    }
  }

  #proof(message: string): string {
    return createHmac("sha256", this.#token).update(message).digest("base64url");
  }

  #send(connection: Connection, message: ServerToBridge): boolean {
    if (connection.ws.readyState !== WS_OPEN) return false;
    try {
      connection.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  #connection(windowId?: string): Connection {
    if (windowId) {
      const found = this.#connections.get(windowId);
      if (!found) throw new BridgeUnavailableError(`No bridge is connected for window ${windowId}`);
      return found;
    }
    const chosen = this.#primaryConnection();
    if (!chosen) {
      throw new BridgeUnavailableError(
        "No Zen window is connected to Zen Control. Launch Zen through the harness so the bridge can attach."
      );
    }
    return chosen;
  }

  #primaryConnection(): Connection | null {
    if (this.#primaryWindowId) {
      const primary = this.#connections.get(this.#primaryWindowId);
      if (primary) return primary;
    }
    const first = this.#connections.values().next();
    return first.done ? null : first.value;
  }

  #broadcast(message: ServerToBridge): void {
    for (const connection of this.#connections.values()) this.#send(connection, message);
  }

  #assertActive(): void {
    if (!this.#accessGranted) {
      throw new BridgeRequestError("consent_required", "Browser access has not been approved yet. Approve the card in Zen.");
    }
    if (this.#paused) {
      throw new BridgeRequestError("paused", "The user paused Zen Control in the browser. No reads or changes are allowed until Resume.");
    }
  }

  #assertUrlAllowed(url: string, action: string): void {
    if (isUrlAllowed(url, this.#allowedDomains)) return;
    throw new BridgeRequestError(
      "domain_not_allowed",
      `${action} ${hostOf(url) ?? url}, which is outside the configured domain allowlist.`
    );
  }

  #composeBanner(banner: UiBanner | null): UiBanner | null {
    if (!banner) return null;
    if (!this.#update || banner.state !== "active") return { ...banner };
    return { ...banner, update: this.#update };
  }

  #setBanner(banner: UiBanner | null): void {
    this.#banner = banner;
    this.#broadcast({ type: "ui.banner", banner: this.banner });
  }

  #pausedBanner(): UiBanner {
    return {
      state: "paused",
      text: "Zen Control is paused",
      detail: "The agent cannot read or change pages. Press Resume to allow it again.",
    };
  }

  setUpdateNotice(notice: UiUpdateNotice | null): void {
    this.#update = notice;
    if (this.#banner) this.#broadcast({ type: "ui.banner", banner: this.banner });
  }

  configureActiveBanner(value: { text: string; detail?: string }): void {
    this.#activeBanner = {
      state: "active",
      text: value.text.trim(),
      detail: value.detail?.trim() || undefined,
    };
    if (this.#accessGranted && !this.#paused) this.#setBanner(this.#activeBanner);
  }

  grantAccess(): void {
    this.#accessGranted = true;
    if (!this.#paused) this.#setBanner(this.#activeBanner);
  }

  requestConsent(options: { consent: UiConsent; timeoutMs?: number }): Promise<ConsentOutcome> {
    if (this.#accessGranted) return Promise.resolve("granted");
    if (this.#consent?.state === "granted") return Promise.resolve("granted");
    if (this.#consent?.state === "denied") return Promise.resolve("denied");
    if (!this.#consent) {
      this.#consent = { consent: options.consent, state: "pending" };
      this.#setBanner({
        state: "pending",
        text: "Zen Control is waiting for your approval",
        detail: "Approve the card before any page is read or changed.",
      });
    }
    this.#broadcast({ type: "ui.consent", consent: this.#consent.consent });
    return new Promise<ConsentOutcome>((resolvePromise) => {
      const finish = (outcome: ConsentOutcome): void => {
        this.#consentWaiters.delete(finish);
        clearTimeout(timer);
        resolvePromise(outcome);
      };
      const timer = setTimeout(() => finish("timeout"), Math.max(1, options.timeoutMs ?? 90_000));
      timer.unref?.();
      this.#consentWaiters.add(finish);
    });
  }

  #onConsentResult(id: string, granted: boolean): void {
    const entry = this.#consent;
    if (!entry || entry.state !== "pending" || entry.consent.id !== id) return;
    entry.state = granted ? "granted" : "denied";
    this.#accessGranted = granted;
    this.#broadcast({ type: "ui.consentCancel", id });
    this.#setBanner(
      granted ? (this.#paused ? this.#pausedBanner() : this.#activeBanner) : {
        state: "pending", text: "Access declined", detail: "Zen Control is closing this browser.",
      }
    );
    const waiters = [...this.#consentWaiters];
    this.#consentWaiters.clear();
    for (const waiter of waiters) waiter(granted ? "granted" : "denied");
    this.#logger.info(granted ? "browser access approved" : "browser access declined");
  }

  #onUpdateAction(action: "install" | "dismiss" | "expand"): void {
    const update = this.#update;
    if (!update) return;
    if (action === "dismiss") {
      if (update.state === "icon" || update.state === "installing") return;
      if (update.state === "installed") this.setUpdateNotice(null);
      else this.setUpdateNotice({ ...update, state: "icon", message: undefined });
      return;
    }
    if (action === "expand") {
      if (update.state === "icon") this.setUpdateNotice({ ...update, state: "prompt" });
      return;
    }
    if (this.#installingUpdate || (update.state !== "prompt" && update.state !== "failed")) return;
    void this.#applyUpdate(update);
  }

  async #applyUpdate(update: UiUpdateNotice): Promise<void> {
    if (!this.#installer) {
      this.setUpdateNotice({ ...update, state: "failed", message: "No installer is available in this session." });
      return;
    }
    this.#installingUpdate = true;
    this.setUpdateNotice({ ...update, state: "installing", message: undefined });
    let result: { ok: boolean; message?: string };
    try {
      result = await this.#installer();
    } catch (error) {
      result = { ok: false, message: String((error as Error)?.message ?? error) };
    } finally {
      this.#installingUpdate = false;
    }
    this.setUpdateNotice({
      ...update,
      state: result.ok ? "installed" : "failed",
      message: result.ok ? undefined : result.message ?? "The installer failed.",
    });
  }

  #deferPendingQuestions(reason: string): void {
    for (const entry of this.#pendingQuestions.values()) {
      if (entry.deferred || entry.answered) continue;
      entry.deferred = true;
      if (entry.windowId) {
        const connection = this.#connections.get(entry.windowId);
        if (connection) this.#send(connection, { type: "ui.cancel", id: entry.question.id });
      }
      const waiter = entry.resolve;
      entry.resolve = null;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      waiter?.({
        status: "deferred",
        questionId: entry.question.id,
        waitedSeconds: Math.round((Date.now() - entry.askedAt) / 1_000),
        message: `The user paused Zen Control, so the question was put aside. ${reason}`,
      });
    }
  }

  pause(reason: string): void {
    if (this.#paused || !this.#accessGranted) return;
    this.#paused = true;
    this.#pausedAt = Date.now();
    this.#events.setPaused(true);
    this.#setBanner(this.#pausedBanner());
    const message = "The user paused Zen Control in the browser. No reads or changes are allowed until Resume.";
    for (const pending of this.#pendingRequests.values()) {
      pending.reject(new BridgeRequestError("paused", message));
      pending.cleanup();
    }
    this.#pendingRequests.clear();
    this.#progress = null;
    this.#stopRequestedAt = null;
    this.#broadcast({ type: "ui.progress", progress: null });
    this.#deferPendingQuestions(message);
    this.pushEvent({ kind: "pause", title: "Agent paused in Zen", detail: reason });
    this.#logger.info("agent access paused in the browser");
  }

  resume(): void {
    if (!this.#paused || !this.#accessGranted) return;
    this.#paused = false;
    this.#pausedAt = null;
    this.#events.setPaused(false);
    this.#setBanner(this.#activeBanner);
    this.pushEvent({ kind: "resume", title: "Agent resumed in Zen", detail: "The user pressed Resume in the browser." });
    this.#logger.info("agent access resumed in the browser");
  }

  /** Routes one fixed method to the chosen window, with timeout/cancel support. */
  request<T extends BridgeMethod>(
    method: T,
    params: BridgeMethodMap[T]["params"],
    options: { windowId?: string; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<BridgeMethodMap[T]["result"]> {
    this.#assertActive();
    if (options.signal?.aborted) {
      return Promise.reject(new BridgeRequestError("cancelled", CANCELLED));
    }
    const connection = this.#connection(options.windowId);
    const id = `r-${++this.#requestSeq}-${randomUUID().slice(0, 8)}`;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const signal = options.signal;
    return new Promise<BridgeMethodMap[T]["result"]>((resolvePromise, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#pendingRequests.delete(id);
        finish();
      };
      const onAbort = (): void => {
        this.#logger.debug(`abandoned "${method}" after client cancellation`);
        settle(() => reject(new BridgeRequestError("cancelled", CANCELLED)));
      };
      timer = setTimeout(() => {
        settle(() =>
          reject(new BridgeRequestError("bridge_timeout", `The Zen window did not finish "${method}" within ${Math.round(timeoutMs / 1_000)}s`))
        );
      }, timeoutMs);
      timer.unref?.();
      this.#pendingRequests.set(id, {
        id,
        method,
        windowId: connection.windowId,
        cleanup,
        resolve: (value) => settle(() => resolvePromise(value as BridgeMethodMap[T]["result"])),
        reject: (error) => settle(() => reject(error)),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      const sent = this.#send(connection, { type: "req", id, method, params: params as unknown });
      if (!sent) settle(() => reject(new BridgeUnavailableError("The Zen window closed its agent connection.")));
    });
  }

  /* ---------------- typed convenience wrappers ---------------- */
  status(windowId?: string) { return this.request("status", undefined, { windowId }); }
  listSpaces(windowId?: string) { return this.request("spaces.list", undefined, { windowId }); }
  createSpace(params: BridgeMethodMap["spaces.create"]["params"], windowId?: string) {
    return this.request("spaces.create", params, { windowId, timeoutMs: 35_000 });
  }
  switchSpace(params: BridgeMethodMap["spaces.switch"]["params"], windowId?: string) {
    return this.request("spaces.switch", params, { windowId, timeoutMs: 30_000 });
  }
  deleteSpace(params: BridgeMethodMap["spaces.delete"]["params"], windowId?: string) {
    return this.request("spaces.delete", params, { windowId, timeoutMs: 30_000 });
  }
  listTabs(params?: BridgeMethodMap["tabs.list"]["params"], windowId?: string) {
    return this.request("tabs.list", params, { windowId });
  }
  async openTabs(params: BridgeMethodMap["tabs.open"]["params"], windowId?: string) {
    for (const url of Array.isArray(params?.urls) ? params.urls : []) {
      this.#assertUrlAllowed(String(url ?? ""), "Refusing to open");
    }
    const result = await this.request("tabs.open", params, { windowId, timeoutMs: 35_000 });
    const blocked = result.tabs.filter((tab) =>
      !isUrlAllowed(normalizeWebUrl(tab.url) ? tab.url : tab.requestedUrl || tab.url, this.#allowedDomains)
    );
    if (blocked.length) {
      await this.closeTabs(
        { tabIds: blocked.map((tab) => tab.id) },
        windowId ?? blocked[0]?.windowId
      ).catch(() => undefined);
      const hosts = [...new Set(blocked.map((tab) => hostOf(tab.url) ?? hostOf(tab.requestedUrl ?? "") ?? tab.url))].join(", ");
      throw new BridgeRequestError("domain_not_allowed", `Refusing to keep tabs that ended up on ${hosts}, outside the domain allowlist. The tabs were closed.`);
    }
    return result;
  }
  closeTabs(params: BridgeMethodMap["tabs.close"]["params"], windowId?: string) {
    return this.request("tabs.close", params, { windowId });
  }
  selectTab(params: BridgeMethodMap["tabs.select"]["params"], windowId?: string) {
    return this.request("tabs.select", params, { windowId, timeoutMs: 30_000 });
  }
  async readTab(
    params: BridgeMethodMap["tabs.read"]["params"],
    windowId?: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ) {
    const page = await this.request(
      "tabs.read",
      { ...params, allowedDomains: this.#allowedDomains },
      { windowId, timeoutMs: options.timeoutMs ?? 40_000, signal: options.signal }
    );
    if (page.url) this.#assertUrlAllowed(page.url, "Refusing to return content from");
    for (const frame of page.frames ?? []) {
      if (frame.url) this.#assertUrlAllowed(frame.url, "Refusing to return content from frame");
    }
    return page;
  }
  async clickElement(
    params: BridgeMethodMap["tabs.click"]["params"],
    windowId?: string,
    options: { signal?: AbortSignal } = {}
  ) {
    const result = await this.request(
      "tabs.click", { ...params, allowedDomains: this.#allowedDomains },
      { windowId, timeoutMs: 30_000, signal: options.signal }
    );
    if (result.url) this.#assertUrlAllowed(result.url, "Refusing to act on");
    if (result.frameUrl) this.#assertUrlAllowed(result.frameUrl, "Refusing to act in frame");
    return result;
  }
  async typeText(
    params: BridgeMethodMap["tabs.type"]["params"],
    windowId?: string,
    options: { signal?: AbortSignal } = {}
  ) {
    const result = await this.request(
      "tabs.type", { ...params, allowedDomains: this.#allowedDomains },
      { windowId, timeoutMs: 30_000, signal: options.signal }
    );
    if (result.url) this.#assertUrlAllowed(result.url, "Refusing to act on");
    if (result.frameUrl) this.#assertUrlAllowed(result.frameUrl, "Refusing to act in frame");
    return result;
  }
  async waitFor(
    params: BridgeMethodMap["tabs.waitFor"]["params"],
    windowId?: string,
    options: { signal?: AbortSignal } = {}
  ) {
    const result = await this.request(
      "tabs.waitFor", { ...params, allowedDomains: this.#allowedDomains },
      { windowId, timeoutMs: 40_000, signal: options.signal }
    );
    if (result.url) this.#assertUrlAllowed(result.url, "Refusing to wait on");
    if (result.frameUrl) this.#assertUrlAllowed(result.frameUrl, "Refusing to wait in frame");
    return result;
  }
  async showEvidence(
    params: BridgeMethodMap["tabs.evidence"]["params"],
    windowId?: string,
    options: { signal?: AbortSignal } = {}
  ) {
    const result = await this.request("tabs.evidence", params, { windowId, timeoutMs: 45_000, signal: options.signal });
    if (result.url) this.#assertUrlAllowed(result.url, "Refusing to return evidence from");
    return result;
  }
  async findText(params: BridgeMethodMap["tabs.findText"]["params"], windowId?: string, timeoutMs = 20_000) {
    const result = await this.request("tabs.findText", params, { windowId, timeoutMs });
    if (result.url) this.#assertUrlAllowed(result.url, "Refusing to return text from");
    return result;
  }
  clearEvidence(params: BridgeMethodMap["tabs.evidenceClear"]["params"], windowId?: string) {
    return this.request("tabs.evidenceClear", params, { windowId });
  }
  listFolders(windowId?: string) { return this.request("folders.list", undefined, { windowId }); }
  createFolder(params: BridgeMethodMap["folders.create"]["params"], windowId?: string) {
    return this.request("folders.create", params, { windowId, timeoutMs: 30_000 });
  }
  addTabsToFolder(params: BridgeMethodMap["folders.addTabs"]["params"], windowId?: string) {
    return this.request("folders.addTabs", params, { windowId });
  }
  searchHistory(params: BridgeMethodMap["history.search"]["params"], windowId?: string) {
    return this.request("history.search", params, { windowId });
  }
  searchBookmarks(params: BridgeMethodMap["bookmarks.search"]["params"], windowId?: string) {
    return this.request("bookmarks.search", params, { windowId });
  }
  pinTabs(params: BridgeMethodMap["tabs.pin"]["params"], windowId?: string) {
    return this.request("tabs.pin", params, { windowId, timeoutMs: 30_000 });
  }
  addEssentials(params: BridgeMethodMap["essentials.add"]["params"], windowId?: string) {
    return this.request("essentials.add", params, { windowId, timeoutMs: 30_000 });
  }
  removeEssentials(params: BridgeMethodMap["essentials.remove"]["params"], windowId?: string) {
    return this.request("essentials.remove", params, { windowId, timeoutMs: 30_000 });
  }
  listContainers(windowId?: string) { return this.request("containers.list", undefined, { windowId }); }
  async openGlance(params: BridgeMethodMap["glance.open"]["params"], windowId?: string) {
    if (params?.url) this.#assertUrlAllowed(String(params.url), "Refusing to preview");
    const result = await this.request("glance.open", { ...params, allowedDomains: this.#allowedDomains }, { windowId, timeoutMs: 30_000 });
    if (result.url) this.#assertUrlAllowed(result.url, "Refusing to preview");
    return result;
  }
  openSplit(params: BridgeMethodMap["split.open"]["params"], windowId?: string) {
    return this.request("split.open", params, { windowId, timeoutMs: 30_000 });
  }
  closeSplit(params: BridgeMethodMap["split.close"]["params"], windowId?: string) {
    return this.request("split.close", params, { windowId, timeoutMs: 30_000 });
  }
  recentlyClosed(windowId?: string) { return this.request("history.recentlyClosed", undefined, { windowId }); }
  writeClipboard(params: BridgeMethodMap["clipboard.write"]["params"], windowId?: string) {
    return this.request("clipboard.write", params, { windowId });
  }

  /** Shows a question card and resolves with the user's answer. */
  async ask(question: string, options: UiOption[], askOptions: AskOptions = {}): Promise<AskResult> {
    if (!this.#accessGranted) {
      return { status: "unavailable", questionId: "", message: "Browser access has not been approved yet." };
    }
    if (this.#paused) {
      return { status: "unavailable", questionId: "", message: "Zen Control is paused; the question was not shown." };
    }
    let connection: Connection;
    try {
      connection = this.#connection(askOptions.windowId);
    } catch {
      return { status: "unavailable", questionId: "", message: "No Zen window is attached, so the question could not be shown." };
    }
    const id = `q-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const payload: UiQuestion = {
      id,
      question: question.trim(),
      context: askOptions.context?.trim() || undefined,
      options,
      allowFreeform: askOptions.allowFreeform !== false,
      multiSelect: askOptions.multiSelect === true,
      createdAt: now,
    };
    const entry: PendingQuestion = {
      question: payload, askedAt: now, deferred: false, answered: false,
      windowId: connection.windowId, resolve: null, timer: null,
    };
    this.#pendingQuestions.set(id, entry);
    if (!this.#send(connection, { type: "ui.ask", question: payload })) {
      return { status: "unavailable", questionId: id, message: "The Zen connection closed before the question could be shown." };
    }
    const waitSeconds = Math.max(
      0, Math.min(600, askOptions.timeoutSeconds ?? askOptions.waitSeconds ?? 120)
    );
    if (waitSeconds === 0) {
      return { status: "pending", questionId: id, message: "Question shown in Zen. Poll answers for the reply." };
    }
    return new Promise<AskResult>((resolvePromise) => {
      entry.resolve = (result) => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        resolvePromise(result);
      };
      entry.timer = setTimeout(() => {
        entry.timer = null;
        const waiter = entry.resolve;
        entry.resolve = null;
        waiter?.({
          status: "pending", questionId: id,
          waitedSeconds: Math.round((Date.now() - entry.askedAt) / 1_000),
          message: "No answer yet. The question is still open in Zen.",
        });
      }, waitSeconds * 1_000);
      entry.timer.unref?.();
    });
  }

  async notify(options: NotifyOptions): Promise<{ delivered: boolean; windowId?: string }> {
    if (!this.#accessGranted || this.#paused) return { delivered: false };
    let connection: Connection;
    try {
      connection = this.#connection(options.windowId);
    } catch {
      return { delivered: false };
    }
    const actions: UiActivityAction[] = [];
    if (options.action?.space) {
      actions.push({ id: "open-space", label: options.action.label || "Open space", kind: "space", target: options.action.space });
    } else if (options.action?.tab) {
      actions.push({ id: "show-source", label: options.action.label || "Show source", kind: "tab", target: options.action.tab });
    }
    const activity: UiActivity = {
      id: `a-${randomUUID().slice(0, 8)}`,
      title: options.title.trim(),
      detail: options.detail?.trim() || undefined,
      tone: options.tone ?? "info",
      actions,
      autoHideMs: Math.max(0, Math.min(120_000, options.autoHideMs ?? 12_000)),
    };
    const delivered = this.#send(connection, { type: "ui.activity", activity });
    return { delivered, windowId: connection.windowId };
  }

  progress(options: ProgressOptions): ProgressResult {
    if (!this.#accessGranted || this.#paused) {
      if (!options.done) return { shown: false, stopRequested: this.#stopRequestedAt !== null };
    }
    let connection: Connection;
    try {
      connection = this.#connection(options.windowId);
    } catch {
      return { shown: false, stopRequested: this.#stopRequestedAt !== null };
    }
    if (options.done) {
      const stopped = this.#stopRequestedAt !== null;
      this.#progress = null;
      this.#stopRequestedAt = null;
      this.#send(connection, { type: "ui.progress", progress: null });
      return { shown: false, stopRequested: stopped };
    }
    const previous = this.#progress;
    const progress: UiProgress = {
      id: previous?.id ?? `p-${randomUUID().slice(0, 8)}`,
      title: options.title.trim(),
      step: options.step?.trim() || undefined,
      detail: options.detail?.trim() || undefined,
      progress: Number.isFinite(options.progress) ? Math.max(0, Math.min(1, Number(options.progress))) : undefined,
      tone: options.tone ?? previous?.tone ?? "info",
      startedAt: previous?.startedAt ?? Date.now(),
      stoppable: options.stoppable ?? previous?.stoppable ?? true,
      stopRequested: this.#stopRequestedAt !== null,
    };
    this.#progress = progress;
    this.#send(connection, { type: "ui.progress", progress });
    return { shown: true, stopRequested: this.#stopRequestedAt !== null };
  }

  #onStop(connection: Connection, progressId: string): void {
    const progress = this.#progress;
    if (!progress) return;
    if (progressId && progressId !== progress.id) return;
    this.#stopRequestedAt = Date.now();
    this.#progress = { ...progress, stopRequested: true };
    this.#send(connection, { type: "ui.progress", progress: this.#progress });
    this.pushEvent({
      kind: "stop", title: "Stop requested in Zen", detail: progress.title, windowId: connection.windowId,
    });
  }

  #onAnswer(id: string, message: Extract<BridgeToServer, { type: "ui.answer" }>): void {
    const entry = this.#pendingQuestions.get(id);
    if (!entry) return;
    if (message.status === "deferred") {
      entry.deferred = true;
      this.pushEvent({ kind: "question", title: "User deferred a question", questionId: id, detail: entry.question.question.slice(0, 200) });
      if (entry.resolve) {
        const waiter = entry.resolve;
        entry.resolve = null;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        waiter({ status: "deferred", questionId: id, waitedSeconds: Math.round((Date.now() - entry.askedAt) / 1_000), message: "The user asked to answer later." });
      }
      return;
    }
    entry.answered = true;
    entry.answer = typeof message.answer === "string" ? message.answer : undefined;
    entry.selectedLabels = Array.isArray(message.selectedLabels) ? message.selectedLabels.map(String).slice(0, 20) : undefined;
    entry.freeform = message.freeform === true;
    this.#answeredQuestions.unshift({
      question: entry.question,
      status: "answered",
      askedAt: entry.askedAt,
      answeredAt: Date.now(),
      answer: entry.answer,
      selectedLabels: entry.selectedLabels,
      freeform: entry.freeform,
    });
    if (this.#answeredQuestions.length > 50) this.#answeredQuestions.length = 50;
    this.#pendingQuestions.delete(id);
    this.pushEvent({
      kind: "question",
      title: "Answer received in Zen",
      detail: (entry.selectedLabels?.join(", ") || entry.answer || entry.question.question).slice(0, 300),
      questionId: id,
      windowId: entry.windowId ?? undefined,
    });
    if (entry.resolve) {
      const waiter = entry.resolve;
      entry.resolve = null;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      waiter({
        status: "answered", questionId: id,
        answer: entry.answer, selectedLabels: entry.selectedLabels, freeform: entry.freeform,
        waitedSeconds: Math.round((Date.now() - entry.askedAt) / 1_000),
      });
    }
  }

  #resendPendingQuestions(connection: Connection): void {
    if (this.#primaryWindowId && this.#primaryWindowId !== connection.windowId) return;
    let count = 0;
    for (const entry of this.#pendingQuestions.values()) {
      if (entry.deferred || entry.answered || count >= 5) continue;
      if (this.#send(connection, { type: "ui.ask", question: entry.question })) {
        entry.windowId = connection.windowId;
        count += 1;
      }
    }
  }

  answers(): AnswersResult {
    const pending: AnswerInboxEntry[] = [...this.#pendingQuestions.values()]
      .sort((a, b) => a.askedAt - b.askedAt)
      .map((entry) => ({
        question: entry.question,
        status: entry.deferred ? "deferred" : "pending",
        askedAt: entry.askedAt,
      }));
    return { pending, answered: [...this.#answeredQuestions] };
  }

  connectedWindows(): Array<{ windowId: string; focused: boolean }> {
    return [...this.#connections.values()].map((connection) => ({
      windowId: connection.windowId,
      focused: connection.focused,
    }));
  }

  #onBrowserEvent(
    connection: Connection,
    event: { kind?: unknown; phase?: unknown; tabId?: unknown; url?: unknown; title?: unknown; detail?: unknown; documentId?: unknown; label?: unknown } | undefined
  ): void {
    if (!this.#accessGranted || this.#paused || !event || typeof event !== "object") return;
    const kind = String(event.kind ?? "");
    const phase = String(event.phase ?? "");
    if (!EVENT_KINDS.has(kind) || !EVENT_PHASES.has(phase) || !EVENT_PAIRS.has(`${kind}:${phase}`)) return;
    const bounded = (value: unknown, max: number): string =>
      typeof value === "string" ? value.trim().slice(0, max) : "";
    const tabId = bounded(event.tabId, MAX_EVENT_ID);
    const documentId = bounded(event.documentId, MAX_EVENT_ID);
    const label = bounded(event.label, 40);
    let url = bounded(event.url, MAX_EVENT_URL);
    let title = bounded(event.title, MAX_EVENT_TEXT);
    let detail = bounded(event.detail, MAX_EVENT_TEXT);
    if (kind !== "dialog") {
      const allowed = url !== "" && isUrlAllowed(url, this.#allowedDomains);
      if (!allowed) {
        if (kind === "navigation" || kind === "document") {
          this.#filteredEvents += 1;
          this.#events.addFiltered(1);
          return;
        }
        url = "";
        title = "";
        detail = "";
      }
    }
    this.pushEvent({
      kind: kind as AgentEventKind,
      phase: phase as AgentEvent["phase"],
      title: EVENT_TITLES[`${kind}:${phase}`] ?? "Browser event",
      detail: (kind === "dialog" ? label : detail || title) || undefined,
      windowId: connection.windowId,
      source: "browser",
      ...(tabId ? { tabId } : {}),
      ...(url ? { url } : {}),
      ...(documentId ? { documentId } : {}),
    });
  }

  /** Adds a control event. Browser observations dedupe inside a 2s window. */
  pushEvent(event: Partial<AgentEvent> & { kind: AgentEventKind; title: string }): void {
    const stored = this.#events.push({
      kind: event.kind,
      title: event.title,
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
      ...(event.windowId !== undefined ? { windowId: event.windowId } : {}),
      ...(event.tabId !== undefined ? { tabId: event.tabId } : {}),
      ...(event.watchId !== undefined ? { watchId: event.watchId } : {}),
      ...(event.questionId !== undefined ? { questionId: event.questionId } : {}),
      ...(event.phase !== undefined ? { phase: event.phase } : {}),
      ...(event.url !== undefined ? { url: event.url } : {}),
      ...(event.documentId !== undefined ? { documentId: event.documentId } : {}),
      ...(event.source !== undefined ? { source: event.source } : {}),
    });
    if (!stored) return;
    const waiters = this.#eventWaiters;
    this.#eventWaiters = [];
    for (const waiter of waiters) {
      try { waiter(); } catch { /* Best effort. */ }
    }
  }

  async events(options: { after?: number; waitSeconds?: number } = {}): Promise<EventsResult> {
    const after = Number.isFinite(options.after) ? Number(options.after) : 0;
    const waitSeconds = Math.max(0, Math.min(MAX_EVENT_WAIT_SECONDS, options.waitSeconds ?? 0));
    if (waitSeconds > 0 && this.#events.read(after).events.length === 0) {
      await new Promise<void>((resolvePromise) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolvePromise();
        };
        const timer = setTimeout(finish, waitSeconds * 1_000);
        timer.unref?.();
        this.#eventWaiters.push(finish);
      });
    }
    this.#events.setStopped(this.#paused || this.#stopRequestedAt !== null);
    return this.#events.read(after);
  }

  /* ---------------- injection ---------------- */
  async ensureInjected(options: { force?: boolean; waitMs?: number } = {}): Promise<InjectionSummary> {
    const now = Date.now();
    if (!options.force && this.#lastInjection && this.#connections.size > 0 && now - this.#lastInjectAt < 5_000) {
      return this.#lastInjection;
    }
    const deadline = now + (options.waitMs ?? 25_000);
    let summary = emptySummary();
    while (Date.now() < deadline) {
      summary = await this.#injectOnce();
      this.#lastInjection = summary;
      this.#lastInjectAt = Date.now();
      if (summary.injected > 0 || summary.reconnected > 0) {
        if (await this.#waitForConnection(2_000)) return summary;
      }
      if (summary.pending === 0 && this.#connections.size > 0) return summary;
      if (summary.windows === 0) {
        await sleep(400);
        continue;
      }
      if (summary.pending === 0 && summary.injected === 0 && summary.reused === 0) return summary;
      await sleep(350);
    }
    return summary;
  }

  async #injectOnce(): Promise<InjectionSummary> {
    if (!this.#url) throw new Error("BridgeHub.start() must be called before injecting");
    const config = {
      url: this.#url,
      token: this.#token,
      bridgeVersion: this.#serverVersion,
      serverVersion: this.#serverVersion,
    };
    const script = buildInjectionScript(config, {
      alias: BRIDGE_RESOURCE_ALIAS, bridgeDir: this.#bridgeDir, bridgeFile: this.#bridgeFile,
    });
    try {
      const raw = await this.#marionette.executeChrome<InjectionSummary>(script, { timeoutMs: 25_000 });
      return normalizeSummary(raw);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      this.#logger.warn(`bridge injection failed: ${message}`);
      return { ...emptySummary(), errors: [message] };
    }
  }

  async #waitForConnection(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.#connections.size > 0) return true;
      await sleep(120);
    }
    return this.#connections.size > 0;
  }

  async stop(): Promise<void> {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    const waiters = this.#eventWaiters;
    this.#eventWaiters = [];
    for (const waiter of waiters) {
      try { waiter(); } catch { /* best effort */ }
    }
    this.#progress = null;
    this.#stopRequestedAt = null;

    for (const pending of this.#pendingRequests.values()) {
      pending.reject(new BridgeUnavailableError("Zen Control is shutting down"));
      pending.cleanup();
    }
    this.#pendingRequests.clear();
    for (const entry of this.#pendingQuestions.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.resolve?.({ status: "unavailable", questionId: entry.question.id, message: "Zen Control stopped before the question was answered." });
      entry.resolve = null;
    }
    const consentWaiters = [...this.#consentWaiters];
    this.#consentWaiters.clear();
    for (const waiter of consentWaiters) waiter("timeout");
    this.#consent = null;
    this.#banner = null;
    this.#accessGranted = false;
    this.#paused = false;
    this.#pausedAt = null;
    this.#events.setPaused(false);
    this.#events.setStopped(true);

    for (const connection of this.#connections.values()) {
      try {
        if (connection.ws.readyState === WS_OPEN) {
          connection.ws.send(JSON.stringify({ type: "shutdown", reason: "server stopping" }));
        }
        connection.ws.close(1001, "server stopping");
      } catch {
        connection.ws.terminate();
      }
    }
    this.#connections.clear();
    this.#primaryWindowId = null;

    const server = this.#server;
    this.#server = null;
    this.#started = false;
    this.#url = null;
    if (server) {
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, 1_500);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    }
  }
}

/**
 * Chrome-side injection script. Options are embedded as JSON data, never as
 * evaluated code. Private windows are skipped and any old bridge there is
 * destroyed rather than reused.
 */
function buildInjectionScript(
  config: { url: string; token: string; bridgeVersion: string; serverVersion: string },
  resource: { alias: string; bridgeDir: string; bridgeFile: string }
): string {
  const payload = JSON.stringify({ config, resourceAlias: resource.alias, bridgeDir: resource.bridgeDir, bridgeFile: resource.bridgeFile });
  return `
const __cfg = ${payload};
const results = { windows: 0, injected: 0, reused: 0, reconnected: 0, pending: 0, errors: [] };
let privacy = null;
try {
  privacy = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs").PrivateBrowsingUtils;
} catch (error) {
  try {
    privacy = ChromeUtils.import("resource://gre/modules/PrivateBrowsingUtils.jsm").PrivateBrowsingUtils;
  } catch (fallback) { privacy = null; }
}
const isPrivate = (target) => {
  try {
    if (target.document?.documentElement?.getAttribute("privatebrowsingmode")) return true;
  } catch (error) {}
  if (!privacy) return false;
  try { return privacy.isWindowPrivate(target); } catch (error) { return true; }
};
const enumerator = Services.wm.getEnumerator("navigator:browser");
const windows = [];
let privateWindows = 0;
while (enumerator.hasMoreElements()) {
  const target = enumerator.getNext();
  if (isPrivate(target)) {
    privateWindows++;
    try { target.__zenMcpBridge?.destroy(); } catch (error) {}
    continue;
  }
  windows.push(target);
}
results.windows = windows.length;
if (windows.length === 0 && privateWindows > 0) {
  results.errors.push("Zen Control never attaches to private browsing windows. Open a normal window first.");
}
let resourceReady = false;
for (const target of windows) {
  try {
    if (!target || target.closed) continue;
    const existing = target.__zenMcpBridge;
    if (existing) {
      if (existing.version === __cfg.config.bridgeVersion && existing.token === __cfg.config.token) {
        if (existing.isConnected()) { results.reused++; continue; }
        existing.reconnect();
        results.reconnected++;
        continue;
      }
      try { existing.destroy(); } catch (error) {}
    }
    if (!target.gZenStartup || !target.gZenStartup.isReady) {
      results.pending++;
      continue;
    }
    if (!resourceReady) {
      const file = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
      file.initWithPath(__cfg.bridgeDir);
      const protocol = Services.io.getProtocolHandler("resource").QueryInterface(Components.interfaces.nsIResProtocolHandler);
      protocol.setSubstitution(__cfg.resourceAlias, Services.io.newFileURI(file));
      resourceReady = true;
    }
    target.__zenMcpConfig = {
      url: __cfg.config.url,
      token: __cfg.config.token,
      bridgeVersion: __cfg.config.bridgeVersion,
      serverVersion: __cfg.config.serverVersion,
    };
    Services.scriptloader.loadSubScript(
      "resource://" + __cfg.resourceAlias + "/" + __cfg.bridgeFile,
      target,
      "UTF-8"
    );
    results.injected++;
  } catch (error) {
    const message = String((error && (error.message || error)) || error);
    const name = String((error && error.name) || "");
    results.errors.push((name && name !== "Error" ? name + ": " : "") + message);
  }
}
return results;
`;
}
