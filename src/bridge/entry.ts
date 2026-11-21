/**
 * Browser-chrome bootstrap for the injected bridge.
 *
 * The host hands this bundle a loopback WebSocket URL and a per-session token
 * through `window.__zenMcpConfig`. The bundle connects out, proves it knows the
 * token with a direction-labelled HMAC, and exposes only the fixed operations
 * from ops.ts plus the in-chrome UI. No page content is ever executed as code.
 */
import { BRIDGE_PROTOCOL_VERSION } from "../shared/brand.js";
import { AUTH_TIMEOUT_MS, clientAuthMessage, serverAuthMessage } from "../shared/bridge-auth.js";
import type { BridgeToServer, ServerToBridge, UiAnswer, UiQuestion } from "../shared/protocol.js";
import { createOps } from "./ops.js";
import { observeBrowserEvents } from "./browser-events.js";
import { EvidenceRecordStore, cacheEvidenceRequest, revealEvidence } from "./evidence-reveal.js";
import { PendingStopStore, deliverStop } from "./pending-stop.js";
import { ZenMcpUi } from "./ui.js";

(() => {
  const win = window as unknown as Window & typeof globalThis;
  const injected = win.__zenMcpConfig;
  delete win.__zenMcpConfig;
  if (!injected) return;
  const config = injected;

  // A fresh injection replaces any bridge left by an older session.
  win.__zenMcpBridge?.destroy();
  try {
    if (win.document?.documentElement?.getAttribute("privatebrowsingmode")) return;
  } catch {
    // If privacy cannot be determined, the host still filters private windows.
  }
  win.__zenMcpWindowId ??= `win-${crypto.randomUUID().slice(0, 8)}`;
  const windowId = win.__zenMcpWindowId!;

  let socket: WebSocket | null = null;
  let destroyed = false;
  let authenticated = false;
  let clientNonce = "";
  let retryMs = 400;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingStop = new PendingStopStore();

  const send = (message: BridgeToServer): boolean => {
    if (!authenticated || !socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  const clearAuthTimer = (): void => {
    if (authTimer) clearTimeout(authTimer);
    authTimer = null;
  };

  const toBase64Url = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const randomNonce = (): string => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return toBase64Url(bytes);
  };

  let keyPromise: Promise<CryptoKey> | null = null;
  const hmacProof = async (message: string): Promise<string> => {
    keyPromise ??= crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(config.token),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", await keyPromise, new TextEncoder().encode(message));
    return toBase64Url(new Uint8Array(signature));
  };
  const secureEqual = (left: string, right: string): boolean => {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
      difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
  };

  const ui = new ZenMcpUi(win.document, {
    onStop: (progressId) =>
      deliverStop(pendingStop, progressId, (stop) =>
        send({ type: "ui.stop", progressId: stop.progressId, ts: stop.ts })
      ),
    onConsent: (id, granted) => send({ type: "ui.consentResult", id, granted }),
    onBannerAction: (action) => send({ type: "ui.bannerAction", action, ts: Date.now() }),
    onUpdateAction: (action) => send({ type: "ui.updateAction", action, ts: Date.now() }),
  });
  const ops = createOps(win, windowId);
  const browserEvents = observeBrowserEvents(
    win,
    (tab: any) => ops.tabIdFor(tab),
    (event) => {
      if (event.kind === "dialog" && event.phase === "shown") ops.noteDialogShown();
      send({ type: "browser.event", event });
    }
  );
  const evidenceRecords = new EvidenceRecordStore();

  const sendHello = (): void => {
    send({
      type: "hello",
      protocol: BRIDGE_PROTOCOL_VERSION,
      bridgeVersion: config.bridgeVersion,
      windowId,
      focused: win.document.hasFocus(),
      appVersion: String(Services.appinfo.version),
      platform: String(Services.appinfo.OS),
    });
  };

  const flushPendingStop = (): void => {
    const pending = pendingStop.peek();
    if (pending) {
      send({ type: "ui.stop", progressId: pending.progressId, ts: pending.ts });
    }
  };

  const scheduleReconnect = (): void => {
    if (destroyed || retryTimer) return;
    const delay = Math.min(retryMs, 15_000);
    retryMs = Math.min(Math.round(retryMs * 1.7), 15_000);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay + Math.random() * 250);
  };

  const respondToChallenge = async (nonce: unknown, ws: WebSocket): Promise<void> => {
    if (typeof nonce !== "string" || !nonce || nonce.length > 512) {
      destroy();
      return;
    }
    if (socket !== ws || destroyed) return;
    let proof: string;
    try {
      proof = await hmacProof(clientAuthMessage(nonce));
    } catch {
      destroy();
      return;
    }
    if (socket !== ws || destroyed) return;
    try {
      ws.send(JSON.stringify({ type: "auth.response", nonce: clientNonce, proof }));
    } catch {
      destroy();
    }
  };

  const verifyServerProof = async (
    confirm: Extract<ServerToBridge, { type: "auth.confirm" }>,
    ws: WebSocket
  ): Promise<void> => {
    if (!clientNonce || typeof confirm.nonce !== "string" || confirm.nonce !== clientNonce) {
      destroy();
      return;
    }
    let expected: string;
    try {
      expected = await hmacProof(serverAuthMessage(clientNonce));
    } catch {
      destroy();
      return;
    }
    if (!secureEqual(String(confirm.proof ?? ""), expected)) {
      destroy();
      return;
    }
    if (socket !== ws || destroyed) return;
    authenticated = true;
    clearAuthTimer();
    sendHello();
    flushPendingStop();
  };

  const handleAsk = (question: UiQuestion): void => {
    ui.showQuestion(question, {
      send: (answer: UiAnswer) =>
        send({
          type: "ui.answer",
          id: question.id,
          status: answer.status,
          ...(answer.answer !== undefined ? { answer: answer.answer } : {}),
          ...(answer.selectedLabels ? { selectedLabels: answer.selectedLabels } : {}),
          ...(answer.freeform !== undefined ? { freeform: answer.freeform } : {}),
        }),
    });
  };

  const handleMessage = async (message: ServerToBridge, ws: WebSocket): Promise<void> => {
    if (!authenticated) {
      if (message.type === "auth.challenge") {
        await respondToChallenge(message.nonce, ws);
        return;
      }
      if (message.type === "auth.confirm") {
        await verifyServerProof(message, ws);
        return;
      }
      destroy();
      return;
    }
    switch (message.type) {
      case "welcome":
        return;
      case "server.ping":
        send({ type: "bridge.pong", ts: Date.now() });
        return;
      case "ui.ask":
        handleAsk(message.question);
        return;
      case "ui.cancel":
        ui.cancelQuestion(message.id);
        return;
      case "ui.progress":
        ui.showProgress(message.progress);
        if (!message.progress || message.progress.stopRequested) {
          pendingStop.clear();
        } else {
          pendingStop.clearIfProgressMoved(message.progress.id);
        }
        return;
      case "ui.consent":
        ui.showConsent(message.consent);
        return;
      case "ui.consentCancel":
        ui.cancelConsent(message.id);
        return;
      case "ui.banner":
        ui.showBanner(message.banner);
        return;
      case "ui.activity":
        ui.showActivity(message.activity, {
          action: async (action) => {
            try {
              if (action.kind === "space") {
                await ops.dispatch("spaces.switch", { space: action.target });
              } else if (action.kind === "tab") {
                await revealEvidence(
                  (method, params) => ops.dispatch(method, params),
                  evidenceRecords,
                  action.target
                );
              } else {
                throw new Error(`Unsupported action: ${action.kind}`);
              }
              send({
                type: "ui.action",
                activityId: message.activity.id,
                actionId: action.id,
                ok: true,
              });
              return { ok: true };
            } catch (error) {
              const detail = String((error as Error)?.message ?? error);
              send({
                type: "ui.action",
                activityId: message.activity.id,
                actionId: action.id,
                ok: false,
                error: detail,
              });
              return { ok: false, error: detail };
            }
          },
        });
        return;
      case "shutdown":
        destroy();
        return;
      case "req": {
        try {
          const result = await ops.dispatch(message.method, message.params);
          if (message.method === "tabs.evidence") {
            const params = message.params as { tabId?: unknown } | undefined;
            cacheEvidenceRequest(evidenceRecords, params?.tabId, message.params, result);
          }
          send({ type: "res", id: message.id, ok: true, result });
        } catch (error) {
          const err = error as Error & { code?: string; details?: Record<string, unknown> };
          let details: Record<string, unknown> | undefined;
          if (err.details && typeof err.details === "object") {
            try {
              details = JSON.stringify(err.details).length <= 2_000 ? err.details : { truncated: true };
            } catch {
              details = { truncated: true };
            }
          }
          send({
            type: "res",
            id: message.id,
            ok: false,
            error: {
              code: err.code ?? "bridge_error",
              message: String(err.message ?? err),
              ...(details ? { details } : {}),
            },
          });
        }
        return;
      }
      default:
        return;
    }
  };

  function connect(): void {
    if (destroyed) return;
    authenticated = false;
    clientNonce = "";
    clearAuthTimer();
    let ws: WebSocket;
    try {
      ws = new WebSocket(config.url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      retryMs = 400;
      clientNonce = randomNonce();
      clearAuthTimer();
      authTimer = setTimeout(() => {
        authTimer = null;
        if (!authenticated) destroy();
      }, AUTH_TIMEOUT_MS);
    };
    ws.onmessage = (event: MessageEvent) => {
      let message: ServerToBridge;
      try {
        message = JSON.parse(String(event.data)) as ServerToBridge;
      } catch {
        return;
      }
      void handleMessage(message, ws);
    };
    ws.onclose = () => {
      if (socket === ws) {
        socket = null;
        authenticated = false;
        clearAuthTimer();
      }
      scheduleReconnect();
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* The close handler schedules a retry. */ }
    };
  }

  const onFocus = (): void => {
    send({ type: "bridge.focus", focused: true, ts: Date.now() });
  };
  const onBlur = (): void => {
    send({ type: "bridge.focus", focused: false, ts: Date.now() });
  };
  win.addEventListener("focus", onFocus);
  win.addEventListener("blur", onBlur);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    authenticated = false;
    clientNonce = "";
    clearAuthTimer();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    win.removeEventListener("focus", onFocus);
    win.removeEventListener("blur", onBlur);
    const current = socket;
    socket = null;
    if (current) {
      try { current.close(); } catch { /* Already closed. */ }
    }
    ui.destroy();
    browserEvents.destroy();
    pendingStop.clear();
    if (win.__zenMcpBridge?.windowId === windowId) delete win.__zenMcpBridge;
  }

  win.__zenMcpBridge = {
    version: config.bridgeVersion,
    token: config.token,
    windowId,
    isConnected: () => socket?.readyState === WebSocket.OPEN,
    reconnect: () => {
      if (socket?.readyState === WebSocket.OPEN) return;
      try { socket?.close(); } catch { /* ignore */ }
      socket = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      retryMs = 400;
      connect();
    },
    destroy,
  };

  win.addEventListener("unload", destroy, { once: true });
  connect();
})();
