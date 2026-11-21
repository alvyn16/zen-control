/**
 * Chrome-side observers for tab, navigation, document and dialog transitions.
 *
 * Every observation is attributed to the browser, never to the action that
 * caused it. Dialog observers look only at the chrome window type: they never
 * read prompt text and never dismiss or answer a dialog. Private windows are
 * skipped entirely.
 */
import type { BrowserEventPayload } from "../shared/protocol.js";
import { documentIdForTab } from "./tab-identity.js";

const STATE_START = 0x00000001;
const STATE_REDIRECTING = 0x00000002;
const STATE_STOP = 0x00000010;
const STATE_IS_DOCUMENT = 0x00020000;
const STATE_IS_WINDOW = 0x00080000;
const LOCATION_CHANGE_SAME_DOCUMENT = 0x00000001;

const DIALOG_LABELS: Record<string, string> = {
  "prompt:alert": "alert",
  "prompt:confirm": "confirm",
  "prompt:prompt": "prompt",
  "prompt:beforeunload": "beforeunload",
  "common-dialog": "common",
  printDialog: "print",
};

const MAX_DIALOG_TYPE = 60;
const MAX_TITLE = 300;

interface Identity {
  url: string;
  title: string;
  documentId: string;
}

export interface BrowserEventObserver {
  destroy(): void;
  noteDialogShown?(): void;
}

function rawSpec(uri: unknown): string {
  try {
    const spec = (uri as { spec?: unknown } | null)?.spec;
    return typeof spec === "string" ? spec : "";
  } catch {
    return "";
  }
}

function webSpec(uri: unknown): string {
  const spec = rawSpec(uri);
  return /^https?:\/\//i.test(spec) ? spec : "";
}

function isPrivate(target: unknown): boolean {
  try {
    return Boolean(
      (target as any)?.document?.documentElement?.getAttribute("privatebrowsingmode")
    );
  } catch {
    return false;
  }
}

function titleOf(tab: any): string {
  try {
    const label = tab?.label || tab?.linkedBrowser?.contentTitle;
    return typeof label === "string" ? label.slice(0, MAX_TITLE) : "";
  } catch {
    return "";
  }
}

function bindingCancelled(status: unknown): boolean {
  const code = Number(status);
  // NS_BINDING_ABORTED / NS_BINDING_CANCELLED_OLD_LOAD are superseded loads.
  return code === 0x804b0002 || code === 0x804b0004;
}

export function observeBrowserEvents(
  win: any,
  tabIdFor: (tab: any) => string,
  emit: (event: BrowserEventPayload) => void
): BrowserEventObserver {
  const gBrowser = win?.gBrowser;
  if (!gBrowser || typeof gBrowser.addTabsProgressListener !== "function") {
    return { destroy: () => undefined };
  }
  if (isPrivate(win)) return { destroy: () => undefined };

  let stopped = false;
  const cleanups: Array<() => void> = [];
  const send = (event: BrowserEventPayload): void => {
    if (!stopped) emit(event);
  };

  const dialogWindows = new WeakSet<object>();
  const dialogLabels = new WeakMap<object, string>();
  /** Last real identity per tab; a closing tab has no browsing context left. */
  const identities = new WeakMap<object, Identity>();

  const tabFor = (browser: unknown): any | null => {
    try {
      const tab = gBrowser.getTabForBrowser?.(browser);
      return tab && tab.linkedBrowser === browser ? tab : null;
    } catch {
      return null;
    }
  };

  const identityOf = (tab: any): Identity => {
    const cached = identities.get(tab);
    const raw = rawSpec(tab?.linkedBrowser?.currentURI);
    const merged: Identity = {
      // An empty raw spec means the document is gone (close), so replay the
      // last real identity. A non-http spec must not fall back to the old page.
      url: raw ? webSpec(raw) : cached?.url ?? "",
      title: titleOf(tab) || cached?.title || "",
      documentId: documentIdForTab(tab) || cached?.documentId || "",
    };
    identities.set(tab, merged);
    return merged;
  };

  const emitTab = (tab: any, phase: BrowserEventPayload["phase"]): void => {
    if (!tab) return;
    send({ kind: "tab", phase, tabId: tabIdFor(tab), ...identityOf(tab) });
  };

  const onOpen = (event: any): void => emitTab(event?.target, "opened");
  const onClose = (event: any): void => emitTab(event?.target, "closed");
  const onSelect = (event: any): void => emitTab(event?.target, "selected");

  const container = gBrowser.tabContainer;
  if (container && typeof container.addEventListener === "function") {
    container.addEventListener("TabOpen", onOpen);
    container.addEventListener("TabClose", onClose);
    container.addEventListener("TabSelect", onSelect);
    cleanups.push(() => {
      container.removeEventListener("TabOpen", onOpen);
      container.removeEventListener("TabClose", onClose);
      container.removeEventListener("TabSelect", onSelect);
    });
  }

  const onLocationChange = (
    browser: unknown,
    webProgress: any,
    _request: unknown,
    uri: unknown,
    flags: unknown
  ): void => {
    if (webProgress?.isTopLevel !== true) return;
    const tab = tabFor(browser);
    if (!tab) return;
    const sameDocument = (Number(flags) & LOCATION_CHANGE_SAME_DOCUMENT) !== 0;
    const identity = identityOf(tab);
    const base = {
      tabId: tabIdFor(tab),
      url: webSpec(uri) || identity.url,
      title: identity.title,
      documentId: identity.documentId,
    };
    if (sameDocument) {
      send({ kind: "navigation", phase: "same_document", ...base });
      return;
    }
    send({ kind: "navigation", phase: "committed", ...base });
    send({ kind: "document", phase: "replaced", ...base });
  };

  const onStateChange = (
    browser: unknown,
    webProgress: any,
    _request: unknown,
    stateFlags: unknown,
    status: unknown
  ): void => {
    const flags = Number(stateFlags);
    if (!Number.isFinite(flags) || webProgress?.isTopLevel !== true) return;
    if ((flags & STATE_IS_DOCUMENT) === 0 || (flags & STATE_IS_WINDOW) === 0) return;
    const tab = tabFor(browser);
    if (!tab) return;
    const base = { tabId: tabIdFor(tab), ...identityOf(tab) };
    if ((flags & STATE_REDIRECTING) !== 0) {
      send({ kind: "navigation", phase: "redirect", ...base });
      return;
    }
    if ((flags & STATE_START) !== 0) {
      send({ kind: "navigation", phase: "started", ...base });
      return;
    }
    if ((flags & STATE_STOP) !== 0) {
      if (bindingCancelled(status)) return;
      let ok = false;
      try {
        ok = Components.isSuccessCode(status) === true;
      } catch {
        ok = Number(status) === 0;
      }
      send({
        kind: "navigation",
        phase: ok ? "completed" : "failed",
        ...base,
        ...(ok ? {} : { detail: "The navigation did not finish" }),
      });
    }
  };

  const progressListener = { onLocationChange, onStateChange };
  gBrowser.addTabsProgressListener(progressListener);
  cleanups.push(() => {
    try {
      gBrowser.removeTabsProgressListener?.(progressListener);
    } catch {
      // The window may already be gone.
    }
  });

  const windowTypeOf = (subject: any): string => {
    try {
      const doc = subject?.document;
      // Only chrome documents can define a dialog label; a page cannot spoof
      // one through its own `windowtype` attribute.
      if (!String(doc?.documentURI || "").startsWith("chrome://")) return "";
      const type = doc?.documentElement?.getAttribute("windowtype");
      return typeof type === "string" ? type.slice(0, MAX_DIALOG_TYPE) : "";
    } catch {
      return "";
    }
  };

  const trackDialogWindow = (subject: any): void => {
    if (!subject || typeof subject !== "object") return;
    if (isPrivate(subject)) return;
    try {
      if (subject.opener !== win) return;
    } catch {
      return;
    }
    const inspect = (): void => {
      const label = DIALOG_LABELS[windowTypeOf(subject)];
      if (!label || dialogWindows.has(subject)) return;
      dialogWindows.add(subject);
      dialogLabels.set(subject, label);
      send({ kind: "dialog", phase: "shown", label });
    };
    inspect();
    if (dialogLabels.has(subject) || dialogWindows.has(subject)) return;
    try {
      subject.addEventListener?.("load", inspect, { once: true });
    } catch {
      // A window that cannot be inspected is ignored.
    }
  };

  // Content alerts/confirms are tab-modal, not new windows, so observe them on
  // the chrome window itself.
  const onWillOpenModal = (): void => send({ kind: "dialog", phase: "shown", label: "tab-modal" });
  const onModalClosed = (): void => send({ kind: "dialog", phase: "hidden", label: "tab-modal" });
  try {
    win.addEventListener("DOMWillOpenModalDialog", onWillOpenModal, true);
    win.addEventListener("DOMModalDialogClosed", onModalClosed, true);
    cleanups.push(() => {
      win.removeEventListener("DOMWillOpenModalDialog", onWillOpenModal, true);
      win.removeEventListener("DOMModalDialogClosed", onModalClosed, true);
    });
  } catch {
    // Dialog observation is optional.
  }

  const observer = {
    observe(subject: unknown, topic: unknown): void {
      if (topic === "domwindowopened") {
        trackDialogWindow(subject);
      } else if (topic === "domwindowclosed" && subject && typeof subject === "object") {
        const label = dialogLabels.get(subject as object);
        if (!label) return;
        dialogLabels.delete(subject as object);
        send({ kind: "dialog", phase: "hidden", label });
      }
    },
  };
  try {
    Services.obs.addObserver(observer, "domwindowopened");
    Services.obs.addObserver(observer, "domwindowclosed");
    cleanups.push(() => {
      for (const topic of ["domwindowopened", "domwindowclosed"]) {
        try {
          Services.obs.removeObserver(observer, topic);
        } catch {
          // Best effort during teardown.
        }
      }
    });
  } catch {
    // Tab and navigation observation remain available.
  }

  return {
    destroy: () => {
      stopped = true;
      while (cleanups.length) {
        const cleanup = cleanups.pop();
        try {
          cleanup?.();
        } catch {
          // Keep tearing down.
        }
      }
    },
    noteDialogShown: () => send({ kind: "dialog", phase: "shown", label: "tab-modal" }),
  };
}
