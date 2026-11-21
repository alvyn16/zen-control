/**
 * A small, dependency-free client for Firefox's Marionette v3 protocol over a
 * raw TCP socket. It exists solely for harness-owned launches (see launcher.ts)
 * because Zen only exposes its chrome scope when started with the environment
 * flag that this launcher supplies.
 */

import net from "node:net";
import { createLogger, type Logger } from "../utils/logger.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 2828;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

export type MarionetteContext = "chrome" | "content";

export interface MarionetteErrorPayload {
  error?: string;
  message?: string;
  stacktrace?: string;
}

export class MarionetteError extends Error {
  override name = "MarionetteError";
  readonly code: string;

  constructor(payload: MarionetteErrorPayload | string) {
    const message =
      typeof payload === "string"
        ? payload
        : payload.message || payload.error || "Marionette command failed";
    super(message);
    this.code = typeof payload === "string" ? "command" : payload.error ?? "command";
    if (typeof payload !== "string" && payload.stacktrace) {
      this.stack = payload.stacktrace;
    }
  }
}

export class MarionetteConnectionError extends Error {
  override name = "MarionetteConnectionError";
}

export interface MarionetteClientOptions {
  port?: number;
  host?: string;
  logger?: Logger;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  scriptTimeoutMs?: number;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  name: string;
}

interface SessionInfo {
  sessionId: string;
  capabilities: Record<string, unknown>;
}

/** The envelope produced by `wrapScript`. */
interface WrappedResult {
  __zenMcpOk?: boolean;
  value?: unknown;
  error?: string;
}

export interface LockdownResult {
  ok: boolean;
  reason?: string;
  competingSessions?: number;
  closedConnections?: number;
  listenerClosed?: boolean;
  mySession?: number;
  connections?: number;
  error?: string;
}

function describeLockdown(result: LockdownResult | null | undefined): string {
  if (!result) return "the browser returned no result";
  const parts = [result.reason ?? "unknown reason"];
  if (typeof result.competingSessions === "number") {
    parts.push(`${result.competingSessions} competing session(s)`);
  }
  if (typeof result.mySession === "number") {
    parts.push(`own session count ${result.mySession}`);
  }
  if (result.error) parts.push(result.error);
  return parts.join(", ");
}

export class MarionetteClient {
  readonly host: string;
  readonly port: number;

  readonly #connectTimeoutMs: number;
  readonly #commandTimeoutMs: number;
  readonly #scriptTimeoutMs: number;
  readonly #logger: Logger;

  #socket: net.Socket | null = null;
  #buffer = Buffer.alloc(0);
  #pending = new Map<number, PendingCommand>();
  #nextCommandId = 1;
  #handshake: Promise<Record<string, unknown>> | null = null;
  #handshakeResolve: ((packet: Record<string, unknown>) => void) | null = null;
  #handshakePacket: Record<string, unknown> | null = null;
  #session: SessionInfo | null = null;
  #context: MarionetteContext = "content";
  #connecting: Promise<void> | null = null;
  #closed = false;

  /** Content-context switching is session-global state, so serialize it. */
  #contentQueue: Promise<unknown> = Promise.resolve();

  constructor(options: MarionetteClientOptions = {}) {
    this.host =
      options.host ??
      process.env.ZEN_CONTROL_MARIONETTE_HOST ??
      DEFAULT_HOST;
    const portValue =
      options.port ??
      process.env.ZEN_CONTROL_MARIONETTE_PORT ??
      DEFAULT_PORT;
    this.port = Number(portValue) || DEFAULT_PORT;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 8_000;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.#scriptTimeoutMs = options.scriptTimeoutMs ?? 120_000;
    this.#logger = options.logger ?? createLogger("marionette");
  }

  get isConnected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  get context(): MarionetteContext {
    return this.#context;
  }

  get sessionId(): string | null {
    return this.#session?.sessionId ?? null;
  }

  get capabilities(): Record<string, unknown> {
    return this.#session?.capabilities ?? {};
  }

  /** Gecko's reported process id, which is the one to watch or terminate. */
  get browserProcessId(): number | null {
    const value = this.capabilities["moz:processID"];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  get profilePath(): string | null {
    const value = this.capabilities["moz:profile"];
    return typeof value === "string" && value ? value : null;
  }

  connect(): Promise<void> {
    if (this.#session && this.isConnected) return Promise.resolve();
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#openSession().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #openSession(): Promise<void> {
    this.#closed = false;
    this.#handshake = null;
    this.#handshakePacket = null;
    this.#logger.debug(`connecting to ${this.host}:${this.port}`);
    const socket = await this.#openSocket();
    this.#socket = socket;
    this.#buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("close", () => this.#onClose(socket));
    socket.on("error", (error: Error) => {
      this.#logger.debug(`socket error: ${error.message}`);
    });

    try {
      await this.#waitForHandshake();
      await this.#startSession();
    } catch (error) {
      socket.destroy();
      if (this.#socket === socket) {
        this.#socket = null;
        this.#session = null;
        this.#handshake = null;
        this.#handshakePacket = null;
      }
      throw error;
    }
    this.#logger.info(`Marionette session ready on ${this.host}:${this.port}`);
  }

  #openSocket(): Promise<net.Socket> {
    return new Promise((resolveSocket, rejectSocket) => {
      const socket = net.connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        rejectSocket(
          new MarionetteConnectionError(
            `Timed out connecting to Marionette at ${this.host}:${this.port}.`
          )
        );
      }, this.#connectTimeoutMs);

      const onError = (error: Error) => {
        clearTimeout(timer);
        socket.removeListener("connect", onConnect);
        rejectSocket(
          new MarionetteConnectionError(
            `Could not reach Marionette at ${this.host}:${this.port}: ${error.message}`
          )
        );
      };
      const onConnect = () => {
        clearTimeout(timer);
        socket.removeListener("error", onError);
        resolveSocket(socket);
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
  }

  #waitForHandshake(): Promise<Record<string, unknown>> {
    if (this.#handshakePacket) return Promise.resolve(this.#handshakePacket);
    if (this.#handshake) return this.#handshake;
    this.#handshake = new Promise((resolveHandshake, rejectHandshake) => {
      const timer = setTimeout(() => {
        rejectHandshake(
          new MarionetteConnectionError("Marionette did not send a handshake packet")
        );
      }, this.#connectTimeoutMs);
      this.#handshakeResolve = (packet) => {
        clearTimeout(timer);
        this.#handshakePacket = packet;
        this.#handshake = null;
        this.#handshakeResolve = null;
        resolveHandshake(packet);
      };
    });
    return this.#handshake;
  }

  async #startSession(): Promise<void> {
    const session = (await this.sendRaw("WebDriver:NewSession", {
      capabilities: {},
    })) as SessionInfo | null;
    if (!session?.sessionId) {
      throw new MarionetteConnectionError("Marionette refused to create a session");
    }
    this.#session = session;
    await this.sendRaw("WebDriver:SetTimeouts", {
      script: this.#scriptTimeoutMs,
      pageLoad: this.#commandTimeoutMs,
      implicit: 0,
    });
    await this.setContext("chrome");
  }

  sendRaw<T = unknown>(
    name: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.#commandTimeoutMs
  ): Promise<T> {
    const socket = this.#socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(
        new MarionetteConnectionError("Marionette is not connected")
      );
    }
    if (!this.#session && name !== "WebDriver:NewSession") {
      return Promise.reject(
        new MarionetteConnectionError("Marionette session is not ready")
      );
    }

    const id = this.#nextCommandId++;
    const payload = JSON.stringify([0, id, name, params]);
    const length = Buffer.byteLength(payload, "utf8");
    return new Promise<T>((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectCommand(
          new MarionetteError(`Marionette command "${name}" timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        name,
        timer,
        resolve: (value) => resolveCommand(value as T),
        reject: rejectCommand,
      });
      socket.write(`${length}:${payload}`);
    });
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const colon = this.#buffer.indexOf(0x3a);
      if (colon === -1) return;
      const header = this.#buffer.subarray(0, colon).toString("ascii");
      if (!/^\d+$/.test(header)) {
        this.#logger.warn(`Unexpected Marionette frame header "${header.slice(0, 32)}"`);
        this.#socket?.destroy();
        return;
      }
      const length = Number(header);
      if (length > MAX_FRAME_BYTES) {
        this.#logger.error(`Refusing oversized Marionette frame (${length} bytes)`);
        this.#socket?.destroy();
        return;
      }
      const start = colon + 1;
      if (this.#buffer.length < start + length) return;
      const raw = this.#buffer.subarray(start, start + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(start + length);

      let packet: unknown;
      try {
        packet = JSON.parse(raw);
      } catch (error) {
        this.#logger.warn(`Malformed Marionette packet: ${(error as Error).message}`);
        continue;
      }
      this.#dispatch(packet);
    }
  }

  #dispatch(packet: unknown): void {
    if (Array.isArray(packet)) {
      const [kind, id, error, result] = packet as [
        number,
        number,
        MarionetteErrorPayload | string | null,
        unknown,
      ];
      if (kind !== 1) {
        this.#logger.debug("Ignoring an incoming Marionette command");
        return;
      }
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (error) {
        pending.reject(new MarionetteError(error));
      } else {
        pending.resolve(result);
      }
      return;
    }
    if (packet && typeof packet === "object" && "applicationType" in packet) {
      this.#handshakeResolve?.(packet as Record<string, unknown>);
      return;
    }
    this.#logger.debug("Ignoring an unrecognized Marionette packet");
  }

  #onClose(socket: net.Socket): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#session = null;
    const error = new MarionetteConnectionError("Marionette connection closed");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#handshake = null;
    this.#handshakePacket = null;
    if (!this.#closed) this.#logger.debug("Marionette connection closed");
  }

  async setContext(context: MarionetteContext): Promise<void> {
    if (this.#context === context && this.#session) return;
    await this.sendRaw("Marionette:SetContext", { value: context });
    this.#context = context;
  }

  getWindowHandles(): Promise<string[]> {
    return this.sendRaw<string[]>("WebDriver:GetWindowHandles", {});
  }

  async getWindowHandle(): Promise<string> {
    return this.sendRaw<string>("WebDriver:GetWindowHandle", {});
  }

  async switchToWindow(handle: string, options: { focus?: boolean } = {}): Promise<void> {
    // Gecko defaults to focus=true, which would steal the user's selection.
    await this.sendRaw("WebDriver:SwitchToWindow", {
      handle,
      focus: options.focus === true,
    });
  }

  async executeScript<T = unknown>(
    body: string,
    args: unknown[] = [],
    timeoutMs = this.#commandTimeoutMs
  ): Promise<T> {
    return this.#sendWrapped<T>("WebDriver:ExecuteAsyncScript", body, args, timeoutMs);
  }

  async executeAsyncScript<T = unknown>(
    body: string,
    args: unknown[] = [],
    timeoutMs = this.#commandTimeoutMs
  ): Promise<T> {
    return this.#sendWrapped<T>("WebDriver:ExecuteAsyncScript", body, args, timeoutMs);
  }

  async #sendWrapped<T>(
    command: string,
    body: string,
    args: unknown[],
    timeoutMs: number
  ): Promise<T> {
    const response = await this.sendRaw<{ value?: unknown }>(
      command,
      { script: wrapScript(body), args },
      timeoutMs
    );
    const wrapped = (response?.value ?? response) as WrappedResult | null;
    if (wrapped && typeof wrapped === "object" && "__zenMcpOk" in wrapped) {
      if (wrapped.__zenMcpOk) return wrapped.value as T;
      throw new MarionetteError(
        typeof wrapped.error === "string" ? wrapped.error : "Script threw an unknown error"
      );
    }
    return wrapped as T;
  }

  async executeChrome<T = unknown>(
    body: string,
    options: { timeoutMs?: number } = {}
  ): Promise<T> {
    await this.setContext("chrome");
    return this.executeAsyncScript<T>(body, [], options.timeoutMs ?? this.#commandTimeoutMs);
  }

  executeInContent<T = unknown>(
    handle: string,
    body: string,
    options: { timeoutMs?: number } = {}
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const previous = this.#context;
      try {
        await this.setContext("content");
        await this.switchToWindow(handle);
        return await this.executeScript<T>(body, [], options.timeoutMs ?? this.#commandTimeoutMs);
      } finally {
        if (previous === "chrome") {
          try {
            await this.setContext("chrome");
          } catch {
            // The connection may be gone; the next call reconnects.
          }
        }
      }
    };
    const result = this.#contentQueue.then(run, run);
    this.#contentQueue = result.catch(() => undefined);
    return result;
  }

  /**
   * Closes all other Marionette connections and stops the listener. Because
   * Marionette has no authentication on this port, this is the step that makes
   * the session exclusive for the lifetime of the browser.
   */
  async lockdown(): Promise<LockdownResult> {
    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new MarionetteConnectionError(
        "Cannot lock down Marionette before a session exists"
      );
    }
    const result = await this.executeChrome<LockdownResult>(
      `
      const mod = ChromeUtils.importESModule(
        "chrome://remote/content/components/Marionette.sys.mjs"
      );
      const server = mod.Marionette && mod.Marionette.server;
      if (!server) return { ok: false, reason: "no-server" };
      const mine = ${JSON.stringify(sessionId)};
      const conns = Array.from(server.conns || []);
      const ours = conns.filter(
        (conn) => conn.driver && conn.driver.currentSession &&
          conn.driver.currentSession.id === mine
      );
      if (ours.length !== 1) {
        return {
          ok: false,
          reason: "session-not-found",
          mySession: ours.length,
          connections: conns.length,
        };
      }
      const others = conns.filter((conn) => conn !== ours[0]);
      const competing = others.filter(
        (conn) => conn.driver && conn.driver.currentSession
      );
      let closed = 0;
      for (const conn of others) {
        try {
          conn.conn.close();
          closed += 1;
        } catch (error) {}
      }
      try {
        await server.setAcceptConnections(false);
      } catch (error) {
        return {
          ok: false,
          reason: "listener-close-failed",
          error: String((error && error.message) || error),
          competingSessions: competing.length,
          closedConnections: closed,
        };
      }
      return {
        ok: competing.length === 0 && !server.socket,
        competingSessions: competing.length,
        closedConnections: closed,
        listenerClosed: !server.socket,
      };
      `,
      { timeoutMs: 15_000 }
    );
    if (!result || result.ok !== true) {
      // A failed lockdown is reported with detail instead of throwing, so the
      // runtime can decide how to describe the startup failure.
      return {
        ...result,
        ok: false,
        reason: result?.reason ?? "lockdown-failed",
      };
    }
    return result;
  }

  async quit(options: { force?: boolean } = {}): Promise<void> {
    try {
      await this.sendRaw(
        "Marionette:Quit",
        { flags: [options.force ? "eForceQuit" : "eAttemptQuit"] },
        5_000
      );
    } catch (error) {
      // The socket normally closes before Gecko writes the reply; that is a
      // successful quit, not a failure.
      if (!(error instanceof MarionetteConnectionError)) throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = null;
    this.#session = null;
    if (!socket) return;
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(resolveClose, 500);
      timer.unref?.();
      socket.once("close", () => {
        clearTimeout(timer);
        resolveClose();
      });
      socket.end();
    });
  }
}

/**
 * Wraps a script body as the inside of an async function. The wrapper always
 * calls the WebDriver async callback, preserving both return values and fully
 * described errors (Gecko stacks otherwise contain frames only).
 */
export function wrapScript(body: string): string {
  return [
    "const __zfDone = arguments[arguments.length - 1];",
    "const __zfDescribe = (error) => {",
    "  try {",
    "    if (!error || typeof error !== 'object') {",
    "      return { name: 'Error', message: String(error), stack: '' };",
    "    }",
    "    const name = error.name ? String(error.name) : 'Error';",
    "    const message = error.message ? String(error.message) : String(error);",
    "    const stack = error.stack ? String(error.stack) : '';",
    "    return { name, message, stack };",
    "  } catch (describeError) {",
    "    return {",
    "      name: 'Error',",
    "      message: 'Script threw an error that could not be described',",
    "      stack: '',",
    "    };",
    "  }",
    "};",
    "(async () => {",
    body,
    "})().then(",
    "  (value) => __zfDone({ __zenMcpOk: true, value }),",
    "  (error) => {",
    "    const info = __zfDescribe(error);",
    "    const text = info.stack",
    "      ? info.name + ': ' + info.message + '\\n' + info.stack",
    "      : info.name + ': ' + info.message;",
    "    __zfDone({",
    "      __zenMcpOk: false,",
    "      error: text,",
    "      name: info.name,",
    "      message: info.message,",
    "      stack: info.stack,",
    "    });",
    "  }",
    ");",
  ].join("\n");
}
