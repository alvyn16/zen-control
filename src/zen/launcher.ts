/**
 * Process-level control for a harness-owned Zen Browser.
 *
 * The security model is deliberately simple: we only ever drive a browser we
 * started ourselves, carrying a per-launch nonce. We never attach to a Zen
 * that was already running, and we never write Zen preferences. That is why a
 * normal user launch has no Marionette port at all.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readlinkSync,
  statSync,
} from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { dataDirPath, type AppConfig } from "../config.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("launcher");

export class ZenLaunchError extends Error {
  override name = "ZenLaunchError";
}

export interface LaunchResult {
  executable: string;
  pid: number;
  port: number;
  /** Per-launch marker the browser must expose through its environment. */
  nonce: string;
}

type ProfileConfig = Pick<AppConfig, "profilePath" | "useDefaultProfile" | "dataDir">;
type ArgsConfig = Partial<
  Pick<AppConfig, "profilePath" | "useDefaultProfile" | "dataDir" | "launchArgs">
>;

/** `null` means the browser's normal profile, which is opt-in. */
export function resolvedProfilePath(config: ProfileConfig): string | null {
  if (config.profilePath) return resolve(config.profilePath);
  if (config.useDefaultProfile) return null;
  return join(config.dataDir ?? dataDirPath(), "agent-profile");
}

export function buildLaunchArgs(
  config: ArgsConfig,
  extraArgs: string[] = []
): { args: string[]; profile: string | null } {
  const profile = resolvedProfilePath(config as ProfileConfig);
  // `-no-remote` prevents command-line hand-off to an already running Zen,
  // which would ignore the dedicated profile and never open Marionette.
  const args = ["-marionette", "-no-remote"];
  if (profile) args.push("-profile", profile);
  // Extra arguments stay last so callers can add test-only flags without
  // replacing the profile argument.
  args.push(...(config.launchArgs ?? []), ...extraArgs);
  return { args, profile };
}

function candidateExecutables(): string[] {
  switch (process.platform) {
    case "win32": {
      const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
      return [
        join(process.env.ProgramFiles ?? "C:\\Program Files", "Zen Browser", "zen.exe"),
        join(
          process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
          "Zen Browser",
          "zen.exe"
        ),
        join(local, "Programs", "Zen Browser", "zen.exe"),
        join(local, "Zen Browser", "zen.exe"),
      ];
    }
    case "darwin":
      return [
        "/Applications/Zen Browser.app/Contents/MacOS/zen",
        join(homedir(), "Applications", "Zen Browser.app", "Contents", "MacOS", "zen"),
      ];
    default:
      return [
        "/usr/bin/zen",
        "/usr/bin/zen-browser",
        "/opt/zen/zen",
        "/usr/lib/zen/zen",
        "/var/lib/flatpak/exports/bin/app.zen_browser.zen",
        join(homedir(), ".local/share/flatpak/exports/bin/app.zen_browser.zen"),
        "/snap/bin/zen-browser",
      ];
  }
}

export function findZenExecutable(config: Pick<AppConfig, "zenPath">): string {
  if (config.zenPath) {
    if (!existsSync(config.zenPath)) {
      throw new ZenLaunchError(
        `Configured Zen executable does not exist: ${config.zenPath}`
      );
    }
    return config.zenPath;
  }
  for (const candidate of candidateExecutables()) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    return candidate;
  }
  throw new ZenLaunchError(
    "Could not find Zen Browser. Install Zen, or set zenPath / the " +
      "ZEN_CONTROL_ZEN_PATH environment variable to the zen executable."
  );
}

export function isPortOpen(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolveResult) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolveResult(open);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Exact kernel process names. We intentionally use `pgrep -x` rather than a
 * broad `-f` pattern, which could match unrelated helpers (including the MCP
 * server process itself).
 */
export const ZEN_PROCESS_NAMES: string[] = [
  "zen",
  "zen-bin",
  "zen-browser",
  "zen_browser",
  "zenbrowser",
];

export function isZenProcessRunning(): boolean {
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "tasklist",
        ["/FI", "IMAGENAME eq zen.exe", "/NH"],
        { encoding: "utf8", timeout: 4000, windowsHide: true }
      );
      return /zen\.exe/i.test(output);
    }
    for (const name of ZEN_PROCESS_NAMES) {
      try {
        const output = execFileSync("pgrep", ["-x", name], {
          encoding: "utf8",
          timeout: 4000,
        });
        if (output.trim().length > 0) return true;
      } catch {
        // pgrep exits non-zero when nothing matched; try the next name.
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    if (process.platform === "win32") {
      const output = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
      });
      return new RegExp(`\\b${pid}\\b`).test(output);
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitForProcessExit(
  pid: number | null | undefined,
  timeoutMs: number
): Promise<boolean> {
  if (!pid) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!isProcessAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
}

/**
 * Extracts the PID from a POSIX profile-lock symlink target. Firefox writes
 * targets such as `127.0.0.1:+12345`; the trailing integer is the owner.
 */
export function parsePosixLockPid(target: string): number | null {
  const match = /(\d+)$/.exec(String(target ?? "").trim());
  if (!match || !match[1]) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function isProfileLocked(profilePath: string): boolean {
  if (process.platform === "win32") {
    const lock = join(profilePath, "parent.lock");
    if (!existsSync(lock)) return false;
    try {
      closeSync(openSync(lock, "r+"));
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EBUSY";
    }
  }
  // Unix builds use `.parentlock`; older and some packaged builds use `lock`
  // or `parent.lock`. A stale symlink whose PID is gone counts as unlocked.
  for (const name of [".parentlock", "lock", "parent.lock"]) {
    let target: string;
    try {
      target = readlinkSync(join(profilePath, name));
    } catch {
      continue;
    }
    const pid = parsePosixLockPid(target);
    if (pid !== null && isProcessAlive(pid)) return true;
  }
  return false;
}

function assertProfileAvailable(profilePath: string): void {
  if (!isProfileLocked(profilePath)) return;
  throw new ZenLaunchError(
    `The Zen profile at ${profilePath} is already open in another browser. ` +
      "Quit that Zen instance first, or choose a different profile."
  );
}

export function terminateZenProcess(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 10_000,
        windowsHide: true,
      });
    } else {
      // The child is a detached process group leader; kill the whole group so
      // child processes do not survive and keep the port or profile busy.
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone, or handed off to another Zen. Either way, best effort.
  }
}

export interface LaunchOptions {
  config: Pick<
    AppConfig,
    | "zenPath"
    | "profilePath"
    | "useDefaultProfile"
    | "dataDir"
    | "launchTimeoutMs"
    | "marionettePort"
    | "launchArgs"
  >;
  /** Extra command-line arguments, mainly useful for smoke tests. */
  args?: string[];
  /** Return immediately instead of waiting for the Marionette port. */
  wait?: boolean;
}

export async function launchZen(options: LaunchOptions): Promise<LaunchResult> {
  const executable = findZenExecutable(options.config);
  const { args, profile } = buildLaunchArgs(options.config, options.args ?? []);

  if (await isPortOpen(options.config.marionettePort)) {
    throw new ZenLaunchError(
      `Marionette is already listening on port ${options.config.marionettePort}. ` +
        "This harness only controls a browser it launched itself and never " +
        "attaches to an existing session. Quit that Zen instance or change " +
        "the configured Marionette port."
    );
  }

  if (profile) {
    mkdirSync(profile, { recursive: true });
    assertProfileAvailable(profile);
  } else if (isZenProcessRunning()) {
    throw new ZenLaunchError(
      "Zen is already running with its normal profile. This harness will not " +
        "take over an existing browser. Quit Zen completely, then try again, " +
        "or switch to the dedicated agent profile."
    );
  }

  const nonce = randomUUID();
  logger.info(`launching ${executable} with agent access`);
  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1",
      ZEN_CONTROL_LAUNCHED: "1",
      ZEN_CONTROL_LAUNCH_NONCE: nonce,
    },
  });
  child.once("error", (error) => {
    logger.error(`could not start ${executable}: ${error.message}`);
  });
  child.unref();

  const pid = child.pid ?? 0;
  const port = options.config.marionettePort;
  if (options.wait === false) {
    return { executable, pid, port, nonce };
  }

  const deadline = Date.now() + options.config.launchTimeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) {
      logger.info(`Marionette is listening on ${port}`);
      return { executable, pid, port, nonce };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  }

  // A failed launch must not leave the profile or singleton lock held.
  terminateZenProcess(pid);
  throw new ZenLaunchError(
    `Zen did not open Marionette on port ${port} within ` +
      `${Math.round(options.config.launchTimeoutMs / 1000)}s. ` +
      "The launch attempt was stopped."
  );
}
