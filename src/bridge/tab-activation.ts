/**
 * Tab activation against Zen's chrome surface.
 *
 * Zen can ignore a single `selectedTab` assignment while a workspace switch is
 * still settling, so activation waits for the target workspace to become active
 * and retries a bounded number of times. Nothing here claims success: callers
 * verify `active` from the tab itself and raise an error if it never came
 * forward. All types are structural so this is testable in plain Node.
 */

export interface ActivationTabLike {
  readonly selected: boolean;
  isConnected?: boolean;
  closing?: boolean;
  getAttribute?(name: string): string | null;
  scrollIntoView?(options: { block: "nearest" }): void;
}

export interface ActivationWorkspaceManagerLike {
  activeWorkspace?: string | null;
  changeWorkspaceWithID?(spaceId: string): unknown;
}

export interface ActivationWindowLike {
  gBrowser: { selectedTab: unknown };
  gZenWorkspaces?: ActivationWorkspaceManagerLike | null;
  focus?(): void;
  document?: { hasFocus?(): boolean } | null;
  focused?: boolean;
}

export interface TabActivationOptions {
  focusWindow?: boolean;
  attempts?: number;
  pollMs?: number;
  workspaceTimeoutMs?: number;
  workspacePollMs?: number;
  focusChecks?: number;
  focusPollMs?: number;
}

const DEFAULTS = {
  attempts: 6,
  pollMs: 60,
  workspaceTimeoutMs: 1_500,
  workspacePollMs: 50,
  focusChecks: 4,
  focusPollMs: 50,
} as const;

type Resolved = { -readonly [K in keyof typeof DEFAULTS]: number };

export interface TabActivationOutcome {
  active: boolean;
  spaceId: string | null;
  attempts: number;
  windowFocused?: boolean;
  lastError?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function resolveOptions(options: TabActivationOptions): Resolved {
  return {
    attempts: clampInt(options.attempts, 1, 20, DEFAULTS.attempts),
    pollMs: clampInt(options.pollMs, 1, 1_000, DEFAULTS.pollMs),
    workspaceTimeoutMs: clampInt(
      options.workspaceTimeoutMs, 0, 10_000, DEFAULTS.workspaceTimeoutMs
    ),
    workspacePollMs: clampInt(
      options.workspacePollMs, 1, 1_000, DEFAULTS.workspacePollMs
    ),
    focusChecks: clampInt(options.focusChecks, 1, 10, DEFAULTS.focusChecks),
    focusPollMs: clampInt(options.focusPollMs, 0, 1_000, DEFAULTS.focusPollMs),
  };
}

function spaceIdOf(tab: ActivationTabLike): string | null {
  try {
    return tab.getAttribute?.("zen-workspace-id") || null;
  } catch {
    return null;
  }
}

async function waitForWorkspace(
  manager: ActivationWorkspaceManagerLike,
  target: string,
  timeoutMs: number,
  pollMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (manager.activeWorkspace === target) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(pollMs, remaining));
  }
}

function probeFocus(win: ActivationWindowLike): boolean | undefined {
  try {
    if (typeof win.document?.hasFocus === "function") {
      return win.document.hasFocus() === true;
    }
  } catch {
    // Try the next probe.
  }
  try {
    if (typeof Services !== "undefined" && Services?.focus) {
      return Services.focus.activeWindow === win;
    }
  } catch {
    // Try the fallback.
  }
  return typeof win.focused === "boolean" ? win.focused : undefined;
}

async function observeFocus(
  win: ActivationWindowLike,
  options: Resolved
): Promise<boolean | undefined> {
  for (let check = 0; check < options.focusChecks; check += 1) {
    const observed = probeFocus(win);
    if (observed === undefined) return undefined;
    if (observed) return true;
    if (check + 1 < options.focusChecks && options.focusPollMs > 0) {
      await sleep(options.focusPollMs);
    }
  }
  return false;
}

export async function activateTab(
  win: ActivationWindowLike,
  tab: ActivationTabLike,
  options: TabActivationOptions = {}
): Promise<TabActivationOutcome> {
  const settings = resolveOptions(options);
  const spaceId = spaceIdOf(tab);
  const manager = win.gZenWorkspaces ?? null;

  if (
    spaceId &&
    manager &&
    typeof manager.changeWorkspaceWithID === "function" &&
    manager.activeWorkspace !== spaceId
  ) {
    await manager.changeWorkspaceWithID(spaceId);
    await waitForWorkspace(
      manager, spaceId, settings.workspaceTimeoutMs, settings.workspacePollMs
    );
  }

  let attempts = 0;
  let lastError: string | undefined;
  while (attempts < settings.attempts) {
    attempts += 1;
    try {
      win.gBrowser.selectedTab = tab;
      lastError = undefined;
    } catch (error) {
      lastError = String((error as Error)?.message ?? error);
    }
    // Re-check after a pause; Zen may override the assignment when a workspace
    // switch finishes a moment later.
    await sleep(settings.pollMs);
    if (tab.selected === true) break;
  }

  const active = tab.selected === true;
  const outcome: TabActivationOutcome = { active, spaceId, attempts };
  if (lastError) outcome.lastError = lastError;
  if (!active) return outcome;

  try {
    tab.scrollIntoView?.({ block: "nearest" });
  } catch {
    // Scrolling is cosmetic; activation already succeeded.
  }
  if (options.focusWindow === true) {
    const focused = await focusWindowAndObserve(win, options);
    if (focused !== undefined) outcome.windowFocused = focused;
  }
  return outcome;
}

export async function focusWindowAndObserve(
  win: ActivationWindowLike,
  options: TabActivationOptions = {}
): Promise<boolean | undefined> {
  try {
    win.focus?.();
  } catch {
    return false;
  }
  return observeFocus(win, resolveOptions(options));
}
