/**
 * Optional release checks and the one-click installer behind the browser bar.
 *
 * Every failure here is an ordinary return value, never a thrown exception:
 * update plumbing must not break an otherwise healthy MCP session.
 */

import { spawn } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SERVER_VERSION } from "../shared/brand.js";
import { atomicWritePrivate, readFileTextBounded } from "../utils/safe-file.js";

export const PACKAGE_NAME = "zenforge";
export const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;

export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  error?: string;
}

export interface UpdateCheckOptions {
  timeoutMs?: number;
  currentVersion?: string;
  fetchImpl?: (
    url: string,
    init: { signal?: AbortSignal; headers?: Record<string, string> }
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export interface UpdatePromptState {
  promptedVersion: string | null;
}

const MAX_UPDATE_STATE_BYTES = 64 * 1024;
const DEFAULT_PATHEXT = [".com", ".exe", ".bat", ".cmd"];

export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseVersion(value: string): Version | null {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      String(value ?? "").trim()
    );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/** SemVer precedence, or `null` when either input is not a plain version. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}

export async function checkForUpdate(opts: UpdateCheckOptions = {}): Promise<UpdateInfo> {
  const currentVersion = opts.currentVersion ?? SERVER_VERSION;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as UpdateCheckOptions["fetchImpl"]);
  const base: Omit<UpdateInfo, "latestVersion" | "updateAvailable"> = { currentVersion };
  if (!fetchImpl) {
    return { ...base, latestVersion: null, updateAvailable: false, error: "fetch is unavailable" };
  }
  try {
    const response = await fetchImpl(REGISTRY_URL, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2_000),
      headers: {
        accept: "application/json",
        "user-agent": `zenforge/${currentVersion}`,
      },
    });
    if (!response.ok) {
      throw new Error(`the registry returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { version?: unknown };
    const latest = typeof body?.version === "string" ? body.version.trim() : "";
    if (!parseVersion(latest)) {
      throw new Error("the registry response did not contain a valid version");
    }
    return {
      ...base,
      latestVersion: latest,
      updateAvailable: isNewerVersion(latest, currentVersion),
    };
  } catch (error) {
    const failure = error as Error;
    const message =
      failure?.name === "TimeoutError" || failure?.name === "AbortError"
        ? "the update check timed out"
        : String(failure?.message ?? failure);
    return { ...base, latestVersion: null, updateAvailable: false, error: message };
  }
}

export function detectPackageManager(env: NodeJS.ProcessEnv = process.env): PackageManager {
  const agent = String(env.npm_config_user_agent ?? "").toLowerCase();
  const execPath = String(env.npm_execpath ?? "").toLowerCase();
  if (agent.startsWith("pnpm/") || execPath.includes("pnpm")) return "pnpm";
  if (agent.startsWith("yarn/") || execPath.includes("yarn")) return "yarn";
  if (agent.startsWith("bun/") || execPath.includes("bun")) return "bun";
  return "npm";
}

export function updateCommand(manager: PackageManager): { command: string; args: string[] } {
  const spec = `${PACKAGE_NAME}@latest`;
  switch (manager) {
    case "pnpm":
      return { command: "pnpm", args: ["add", "-g", spec] };
    case "yarn":
      return { command: "yarn", args: ["global", "add", spec] };
    case "bun":
      return { command: "bun", args: ["add", "-g", spec] };
    default:
      return { command: "npm", args: ["install", "-g", spec] };
  }
}

function sameOrInside(candidate: string, parent: string): boolean {
  const rel = relative(parent.toLowerCase(), candidate.toLowerCase());
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * On Windows a bare command name is resolved from the cwd before PATH. That
 * would let a repository containing `npm.cmd` run arbitrary code on update, so
 * we find the executable ourselves and skip cwd-relative entries entirely.
 */
export function resolveInstallerExecutable(
  command: string,
  options: {
    platform?: NodeJS.Platform;
    pathValue?: string;
    pathExt?: string;
    cwd?: string;
  } = {}
): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return command;
  const cwd = resolve(options.cwd ?? process.cwd());
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const configured = (options.pathExt ?? process.env.PATHEXT ?? "")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const extensions = configured.length ? configured : DEFAULT_PATHEXT;
  const candidates = command.includes(".") ? [""] : extensions;

  for (const rawEntry of pathValue.split(";")) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, "$1");
    if (!entry) continue;
    const dir = resolve(cwd, entry);
    if (isAbsolute(entry) ? dir.toLowerCase() === cwd.toLowerCase() : sameOrInside(dir, cwd)) {
      continue;
    }
    for (const extension of candidates) {
      const candidate = resolve(join(dir, `${command}${extension}`));
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not in this directory; keep walking PATH.
      }
    }
  }
  return null;
}

export interface RunInstallerOptions {
  stdio?: "inherit" | "ignore";
}

export function runInstaller(
  command: string,
  args: string[],
  opts: RunInstallerOptions = {}
): Promise<number> {
  const stdio = opts.stdio ?? "inherit";
  return new Promise((resolveCode) => {
    let child: ReturnType<typeof spawn>;
    try {
      if (process.platform === "win32") {
        const executable = resolveInstallerExecutable(command);
        if (!executable) {
          resolveCode(1);
          return;
        }
        const comspec = isAbsolute(process.env.ComSpec ?? "")
          ? (process.env.ComSpec as string)
          : join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
        child = spawn(
          comspec,
          ["/d", "/s", "/c", `""${executable}" ${args.join(" ")}"`],
          {
            stdio,
            cwd: homedir(),
            env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
            windowsVerbatimArguments: true,
          }
        );
      } else {
        child = spawn(command, args, { stdio });
      }
    } catch {
      resolveCode(1);
      return;
    }
    child.on("error", () => resolveCode(1));
    child.on("close", (code) => resolveCode(code ?? 1));
  });
}

export function readUpdatePromptState(path: string): UpdatePromptState {
  try {
    if (lstatSync(path).isSymbolicLink()) return { promptedVersion: null };
    const body = JSON.parse(readFileTextBounded(path, MAX_UPDATE_STATE_BYTES)) as {
      promptedVersion?: unknown;
    };
    return {
      promptedVersion:
        typeof body?.promptedVersion === "string" ? body.promptedVersion : null,
    };
  } catch {
    return { promptedVersion: null };
  }
}

export function shouldPromptUpdate(prompted: string | null, latest: string): boolean {
  return prompted !== latest;
}

export function writeUpdatePromptState(path: string, state: UpdatePromptState): void {
  try {
    atomicWritePrivate(path, JSON.stringify(state));
  } catch {
    // Losing this hint only means the banner may prompt one extra time.
  }
}
