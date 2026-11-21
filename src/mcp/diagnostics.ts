/**
 * Agent-facing doctor for the MCP layer.
 *
 * Unlike the CLI preflight in zen/doctor.ts, this report is assembled entirely
 * from state the server already holds in memory plus cheap local filesystem
 * reads. It deliberately never launches a browser, opens a Marionette/bridge
 * connection or reads any page content, so it is safe to call at any time —
 * including when a browser tool just failed. Details are bounded and redacted:
 * no cookies, credentials, full URLs or page text ever enter the report.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_PROTOCOL_VERSION, SERVER_VERSION } from "../shared/brand.js";
import { configFilePath, type AppConfig } from "../config.js";
import { readFileTextBounded } from "../utils/safe-file.js";
import { findZenExecutable, isProfileLocked, resolvedProfilePath } from "../zen/launcher.js";
import type { ZenRuntime } from "../zen/runtime.js";
import type { SessionStore } from "../zen/sessions.js";
import type { TemplateStore } from "../zen/templates.js";
import type { ToolGuard } from "./guard.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const AUDIT_TAIL_LIMIT = 50;

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface AgentDoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  surface: string;
  counts: { tools: number; resources: number; prompts: number };
  policy: {
    readOnly: boolean;
    auditLog: boolean;
    requireConsent: boolean;
    allowedDomains: string[];
  };
  session?: Record<string, unknown>;
}

export interface AgentDoctorInput {
  config: AppConfig;
  runtime: ZenRuntime;
  sessions: SessionStore;
  templates: TemplateStore;
  guard: ToolGuard;
  counts: { tools: number; resources: number; prompts: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function check(
  checks: DoctorCheck[],
  name: string,
  ok: boolean,
  detail: string,
  fix?: string
): void {
  checks.push(fix ? { name, ok, detail, fix } : { name, ok, detail });
}

/**
 * Build a purely local diagnostic report. Every accessor is defensive so the
 * function can run against a minimal fake runtime in tests as well as a live
 * ZenRuntime; nothing here performs I/O beyond reading small local files.
 */
export function agentDoctor(input: AgentDoctorInput): AgentDoctorReport {
  const { config, counts } = input;
  const checks: DoctorCheck[] = [];

  // Loose views keep us honest about the few fields we actually depend on.
  const runtime = input.runtime as unknown as Record<string, unknown>;
  const sessionFactory = runtime.sessionInfo;
  const info: Record<string, unknown> =
    typeof sessionFactory === "function"
      ? (sessionFactory.call(input.runtime) as Record<string, unknown>) || {}
      : {};
  const hub = isRecord(runtime.hub) ? runtime.hub : {};
  const marionette = isRecord(runtime.marionette) ? runtime.marionette : {};
  const guard = input.guard as unknown as {
    auditPath?: string;
    tail?: (limit?: number) => unknown;
  };
  const sessions = input.sessions as unknown as { list?: () => unknown };
  const templates = input.templates as unknown as { list?: () => unknown };

  const ownsBrowser = info.ownsBrowser === true;
  const lockedDown = info.lockedDown === true;
  const paused = info.paused === true;
  const browserPid = finiteNumber(info.browserPid);
  const consent = typeof info.consent === "string" ? info.consent : "none";

  // Config file: existence and parseability, never its contents.
  const configPath = configFilePath();
  if (!existsSync(configPath)) {
    check(
      checks,
      "Config",
      true,
      "No config file found; built-in defaults are in use.",
      "Run the setup command to write a config file, or set ZEN_CONTROL_* overrides."
    );
  } else {
    try {
      JSON.parse(readFileTextBounded(configPath, MAX_CONFIG_BYTES));
      check(checks, "Config", true, `Config ${configPath} exists and parses.`);
    } catch (error) {
      check(
        checks,
        "Config",
        false,
        `Config ${configPath} could not be read or parsed: ${errorText(error)}`,
        "Fix the JSON syntax in the config file, then retry."
      );
    }
  }

  // Zen executable discovery (the finder throws when nothing is installed).
  try {
    const executable = findZenExecutable(config);
    check(checks, "Zen executable", true, `Found Zen executable at ${executable}.`);
  } catch (error) {
    check(
      checks,
      "Zen executable",
      false,
      errorText(error),
      "Install Zen Browser or set zenPath / ZEN_CONTROL_ZEN_PATH to the executable."
    );
  }

  // Bridge bundle: prefer the hub's resolved path, then env override, then cwd.
  const bridgeCandidates: string[] = [];
  const bridgeOverride = process.env.ZEN_CONTROL_BRIDGE_SCRIPT;
  if (bridgeOverride) bridgeCandidates.push(bridgeOverride);
  if (typeof hub.bridgeScriptPath === "string") bridgeCandidates.push(hub.bridgeScriptPath);
  bridgeCandidates.push(join(process.cwd(), "dist", "bridge.js"));
  const bundle = bridgeCandidates.find((candidate) => existsSync(candidate));
  if (bundle) {
    check(checks, "Bridge bundle", true, `Found bridge bundle at ${bundle}.`);
  } else {
    check(
      checks,
      "Bridge bundle",
      false,
      "The injected bridge bundle was not found.",
      "Run the build script (npm run build) so dist/bridge.js exists before launching."
    );
  }

  // Profile mode and lock state. A lock held by our own browser is expected.
  const profile = resolvedProfilePath(config);
  if (!profile) {
    check(
      checks,
      "Profile mode",
      true,
      "Default profile mode: the agent would share the normal signed-in profile.",
      "Set useDefaultProfile=false (the dedicated agent profile) to isolate signed-in sites."
    );
  } else {
    const locked = isProfileLocked(profile);
    if (locked && ownsBrowser) {
      check(checks, "Profile mode", true, `Dedicated profile ${profile} is locked by this session's browser.`);
    } else if (locked) {
      check(
        checks,
        "Profile mode",
        true,
        `Dedicated profile ${profile} is in use by another Zen instance.`,
        "Quit that Zen instance before launching. This harness never attaches to it."
      );
    } else {
      check(checks, "Profile mode", true, `Dedicated profile ${profile} is free.`);
    }
  }

  // Marionette port: reported from local ownership state only, never probed.
  const port = config.marionettePort;
  const connected = marionette.isConnected === true;
  if (ownsBrowser || lockedDown || connected) {
    check(
      checks,
      "Marionette port",
      true,
      `Port ${port} is held by this session's browser (${lockedDown ? "locked down" : "connected"}).`
    );
  } else {
    check(
      checks,
      "Marionette port",
      true,
      `No owned Marionette session; port ${port} is not held by this server.`,
      "Call zen_launch (or enable autoLaunch) to open the port with a browser this server owns."
    );
  }

  // Runtime session snapshot.
  const sessionParts = [
    ownsBrowser ? "owns a browser" : "owns no browser",
    browserPid === null ? "pid none" : `pid ${browserPid}`,
    lockedDown ? "locked down" : "not locked down",
    `consent ${consent}`,
    paused ? "paused" : "not paused",
  ];
  check(
    checks,
    "Runtime session",
    true,
    `Session: ${sessionParts.join(", ")}.`,
    paused ? "The session is paused; resume before retrying browser tools." : undefined
  );

  // Hub connections plus build version / expected bridge protocol.
  const connectionCount = finiteNumber(hub.connectionCount) ?? 0;
  const hubDetail =
    `Bridge hub: ${connectionCount} window connection(s); server ${SERVER_VERSION}, ` +
    `bridge protocol ${BRIDGE_PROTOCOL_VERSION}.`;
  check(
    checks,
    "Bridge connection",
    true,
    hubDetail,
    connectionCount === 0
      ? "No window is attached; call zen_launch or wait for auto-attach."
      : undefined
  );

  // Tool surface and exposed registry counts.
  const saneCounts = [counts.tools, counts.resources, counts.prompts].every(
    (value) => finiteNumber(value) !== null && (value as number) >= 0
  );
  check(
    checks,
    "Tool surface",
    saneCounts,
    `Surface "${config.toolSurface}": tools ${counts.tools}, resources ${counts.resources}, prompts ${counts.prompts}.`,
    saneCounts ? undefined : "Counts are invalid; check the MCP registry wiring."
  );

  // Policy summary: report permissive settings without changing them.
  const extraArgs = Array.isArray(config.launchArgs) ? config.launchArgs.length : 0;
  const permissive: string[] = [];
  if (!config.requireConsent) permissive.push("consent is off");
  if (!config.readOnly) permissive.push("read-only mode is off");
  if (config.allowedDomains.length === 0) permissive.push("the domain allowlist is empty");
  if (!config.auditLog) permissive.push("the audit log is off");
  if (extraArgs > 0) permissive.push(`${extraArgs} extra launch argument(s)`);
  check(
    checks,
    "Policy",
    true,
    permissive.length > 0
      ? `More permissive than the safest settings: ${permissive.join(", ")}.`
      : "Consent, read-only mode, the domain allowlist and the audit log are all on; no extra launch arguments.",
    permissive.length > 0 ? "Review the policy fields in the config before enabling risky tools." : undefined
  );

  // Audit log location and a count of recently blocked/denied calls.
  const auditPath = typeof guard.auditPath === "string" ? guard.auditPath : "(unknown)";
  let recent = 0;
  let blocked = 0;
  let auditError = "";
  try {
    const records = typeof guard.tail === "function" ? guard.tail(AUDIT_TAIL_LIMIT) : [];
    if (Array.isArray(records)) {
      recent = records.length;
      blocked = records.filter(
        (record) => isRecord(record) && (record.executed === false || record.ok === false)
      ).length;
    }
  } catch (error) {
    auditError = errorText(error);
  }
  check(
    checks,
    "Audit log",
    true,
    auditError
      ? `Audit tail could not be read: ${auditError}.`
      : `Audit log ${auditPath}: ${recent} recent entr${recent === 1 ? "y" : "ies"}, ${blocked} blocked/denied.`,
    !config.auditLog
      ? "Audit logging is disabled; enable it to keep a record of tool calls."
      : undefined
  );

  // Persisted sessions and templates (counts only, never their page content).
  let sessionCount = 0;
  let templateCount = 0;
  let storeError = "";
  try {
    sessionCount = countOf(typeof sessions.list === "function" ? sessions.list() : []);
  } catch (error) {
    storeError = `sessions: ${errorText(error)}`;
  }
  try {
    templateCount = countOf(typeof templates.list === "function" ? templates.list() : []);
  } catch (error) {
    storeError = `${storeError ? `${storeError}; ` : ""}templates: ${errorText(error)}`;
  }
  check(
    checks,
    "Stores",
    storeError === "",
    storeError
      ? `Local stores could not be read: ${storeError}.`
      : `${sessionCount} saved session(s), ${templateCount} template(s) available.`,
    storeError ? "Check the JSON files in the data directory for corruption." : undefined
  );

  const session: Record<string, unknown> = {
    ownsBrowser,
    browserPid,
    lockedDown,
    consent,
    paused,
  };

  return {
    ok: !checks.some((entry) => !entry.ok),
    checks,
    surface: config.toolSurface,
    counts,
    policy: {
      readOnly: config.readOnly,
      auditLog: config.auditLog,
      requireConsent: config.requireConsent,
      allowedDomains: Array.isArray(config.allowedDomains) ? [...config.allowedDomains] : [],
    },
    session,
  };
}
