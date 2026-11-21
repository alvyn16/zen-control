import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWritePrivate, readFileTextBounded } from "./utils/safe-file.js";
import type { ToolSurface } from "./mcp/catalog.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

export interface AppConfig {
  zenPath?: string;
  profilePath?: string;
  dataDir?: string;
  useDefaultProfile: boolean;
  requireConsent: boolean;
  consentTimeoutSeconds: number;
  autoLaunch: boolean;
  autoAttachWindows: boolean;
  launchTimeoutMs: number;
  askTimeoutSeconds: number;
  marionettePort: number;
  readOnly: boolean;
  allowedDomains: string[];
  auditLog: boolean;
  watchMinIntervalSeconds: number;
  launchArgs: string[];
  toolSurface: ToolSurface;
}

export const DEFAULT_CONFIG: AppConfig = {
  useDefaultProfile: false,
  requireConsent: true,
  consentTimeoutSeconds: 90,
  autoLaunch: true,
  autoAttachWindows: true,
  launchTimeoutMs: 45_000,
  askTimeoutSeconds: 120,
  marionettePort: 2828,
  readOnly: false,
  allowedDomains: [],
  auditLog: true,
  watchMinIntervalSeconds: 15,
  launchArgs: [],
  toolSurface: "research",
};

function env(name: string): string | undefined {
  return process.env[`ZEN_CONTROL_${name}`];
}

export function configFilePath(): string {
  const override = env("CONFIG");
  if (override) return override;
  const base =
    process.env.APPDATA ??
    (process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config"));
  return join(base, "zen-control", "config.json");
}

export function dataDirPath(): string {
  return env("DATA_DIR") ?? join(dirname(configFilePath()), "data");
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function fileBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`Invalid ${field} in ${configFilePath()}: expected a JSON boolean.`);
}

function fileStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid ${field} in ${configFilePath()}: expected an array of strings.`);
  }
  return value as string[];
}

function envBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (/^(1|true|yes|on)$/.test(v)) return true;
  if (/^(0|false|no|off)$/.test(v)) return false;
  throw new Error(`Invalid ${name} value "${value}". Use 1/0, true/false, yes/no or on/off.`);
}

function parseSurface(value: unknown): ToolSurface {
  if (value === undefined) return "research";
  if (value !== "research" && value !== "core" && value !== "full") {
    throw new Error(`Invalid tool surface "${String(value)}". Use research, core or full.`);
  }
  return value;
}

function readFile(): Partial<AppConfig> {
  const path = configFilePath();
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileTextBounded(path, MAX_CONFIG_BYTES));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config ${path} must be a JSON object.`);
  }
  return parsed as Partial<AppConfig>;
}

export function loadConfig(): AppConfig {
  const file = readFile();
  const number = (
    envName: string,
    fileKey: keyof AppConfig,
    min: number,
    max: number,
    fallback: number
  ) => {
    const raw = env(envName);
    return raw !== undefined && raw.trim()
      ? boundedInt(raw, min, max, fallback)
      : boundedInt(file[fileKey], min, max, fallback);
  };
  const domains = (() => {
    const raw = env("ALLOWED_DOMAINS");
    return raw !== undefined
      ? raw.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
      : fileStringArray(file.allowedDomains, "allowedDomains");
  })();

  return {
    ...DEFAULT_CONFIG,
    zenPath: env("ZEN_PATH") ?? (typeof file.zenPath === "string" ? file.zenPath : undefined),
    profilePath: env("PROFILE") ?? (typeof file.profilePath === "string" ? file.profilePath : undefined),
    dataDir: env("DATA_DIR") ?? (typeof file.dataDir === "string" ? file.dataDir : undefined),
    useDefaultProfile: envBoolean("USE_DEFAULT_PROFILE", env("USE_DEFAULT_PROFILE"), fileBoolean(file.useDefaultProfile, "useDefaultProfile", false)),
    requireConsent: envBoolean("REQUIRE_CONSENT", env("REQUIRE_CONSENT"), fileBoolean(file.requireConsent, "requireConsent", true)),
    autoLaunch: envBoolean("AUTO_LAUNCH", env("AUTO_LAUNCH"), fileBoolean(file.autoLaunch, "autoLaunch", true)),
    autoAttachWindows: envBoolean("AUTO_ATTACH_WINDOWS", env("AUTO_ATTACH_WINDOWS"), fileBoolean(file.autoAttachWindows, "autoAttachWindows", true)),
    readOnly: envBoolean("READ_ONLY", env("READ_ONLY"), fileBoolean(file.readOnly, "readOnly", false)),
    auditLog: envBoolean("AUDIT_LOG", env("AUDIT_LOG"), fileBoolean(file.auditLog, "auditLog", true)),
    consentTimeoutSeconds: number("CONSENT_TIMEOUT_SECONDS", "consentTimeoutSeconds", 1, 600, 90),
    launchTimeoutMs: number("LAUNCH_TIMEOUT_MS", "launchTimeoutMs", 1_000, 300_000, 45_000),
    askTimeoutSeconds: number("ASK_TIMEOUT_SECONDS", "askTimeoutSeconds", 1, 3_600, 120),
    marionettePort: number("MARIONETTE_PORT", "marionettePort", 1, 65_535, 2828),
    watchMinIntervalSeconds: number("WATCH_MIN_INTERVAL_SECONDS", "watchMinIntervalSeconds", 1, 3_600, 15),
    allowedDomains: domains.map((d) =>
      d.replace(/^\*?\./, "").replace(/^\.+/, "").replace(/\.+$/, "").toLowerCase()
    ),
    launchArgs: env("LAUNCH_ARGS")
      ? env("LAUNCH_ARGS")!.split(/\s+/).filter(Boolean)
      : fileStringArray(file.launchArgs, "launchArgs"),
    toolSurface: parseSurface(env("TOOL_SURFACE") ?? file.toolSurface),
  };
}

export function saveConfig(updates: Partial<AppConfig>): string {
  const path = configFilePath();
  // Read raw so environment overrides are never baked into the file.
  const next = { ...DEFAULT_CONFIG, ...readFile(), ...updates };
  atomicWritePrivate(path, `${JSON.stringify(next, null, 2)}\n`);
  return path;
}

export const CONFIG_KEYS = [
  "zenPath", "profilePath", "dataDir", "useDefaultProfile", "requireConsent",
  "consentTimeoutSeconds", "autoLaunch", "autoAttachWindows", "launchTimeoutMs",
  "askTimeoutSeconds", "marionettePort", "readOnly", "allowedDomains", "auditLog",
  "watchMinIntervalSeconds", "launchArgs", "toolSurface",
] as const;
