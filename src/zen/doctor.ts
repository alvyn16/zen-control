/**
 * Static preflight checks. Doctor deliberately never creates a Marionette
 * session, so it can inspect a machine without taking over a browser.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configFilePath, type AppConfig } from "../config.js";
import {
  findZenExecutable,
  isPortOpen,
  isProfileLocked,
  isZenProcessRunning,
  resolvedProfilePath,
} from "./launcher.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  /** No check failed; warnings are allowed. */
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  bridgeScriptPath?: string;
}

function bridgeCandidates(): string[] {
  const override =
    process.env.ZENFORGE_BRIDGE_SCRIPT ?? process.env.ZEN_MCP_BRIDGE_SCRIPT;
  const paths = [join(process.cwd(), "dist", "bridge.js")];
  const configDir = dirname(configFilePath());
  paths.push(resolve(configDir, "..", "dist", "bridge.js"));
  paths.push(resolve(configDir, "..", "..", "dist", "bridge.js"));
  return override ? [override, ...paths] : paths;
}

export async function runDoctor(
  config: AppConfig,
  options: DoctorOptions = {}
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const path = configFilePath();

  const configExists = existsSync(path);
  checks.push({
    name: "Config",
    status: configExists ? "ok" : "warn",
    detail: configExists
      ? `Loaded ${path}`
      : "No config file yet; built-in defaults are in use.",
    hint: configExists ? undefined : "Run the setup command to write a config file.",
  });

  try {
    checks.push({
      name: "Zen executable",
      status: "ok",
      detail: findZenExecutable(config),
    });
  } catch (error) {
    checks.push({
      name: "Zen executable",
      status: "fail",
      detail: (error as Error).message,
      hint: "Set zenPath in the config or point ZENFORGE_ZEN_PATH at the executable.",
    });
  }

  const bundle = options.bridgeScriptPath ?? bridgeCandidates().find(existsSync);
  checks.push({
    name: "Bridge bundle",
    status: bundle ? "ok" : "fail",
    detail: bundle ? bundle : "The injected bridge bundle was not found.",
    hint: bundle ? undefined : "Run the build script before starting the server.",
  });

  const profile = resolvedProfilePath(config);
  if (profile) {
    const locked = isProfileLocked(profile);
    checks.push({
      name: "Agent profile",
      status: locked ? "warn" : "ok",
      detail: locked
        ? `${profile} is in use by another Zen instance.`
        : `${profile} (separate from your normal browsing profile).`,
      hint: locked
        ? "Quit that Zen instance before launching. This harness never attaches to it."
        : undefined,
    });
  } else {
    const running = isZenProcessRunning();
    checks.push({
      name: "Profile mode",
      status: running ? "warn" : "ok",
      detail: running
        ? "Normal profile: Zen is running and will not be taken over."
        : "Normal profile: the agent will share your signed-in browsing profile.",
      hint: running
        ? "Quit Zen before launching, or use the dedicated agent profile."
        : "Pages the agent reads may include sites where you are signed in.",
    });
  }

  try {
    const open = await isPortOpen(config.marionettePort);
    checks.push({
      name: "Marionette port",
      status: open ? "warn" : "ok",
      detail: open
        ? `127.0.0.1:${config.marionettePort} is accepting connections; launching is refused while another process owns it.`
        : `127.0.0.1:${config.marionettePort} is closed.`,
      hint: open ? "Quit the process using that port or choose another port." : undefined,
    });
  } catch (error) {
    checks.push({
      name: "Marionette port",
      status: "fail",
      detail: (error as Error).message,
    });
  }

  checks.push({
    name: "Ownership",
    status: "ok",
    detail:
      "A launch carries a random nonce that the browser must echo back before " +
      "the port is locked to this session. No preference file is modified.",
  });

  const permissive: string[] = [];
  if (!config.requireConsent) permissive.push("consent is off");
  if (!config.readOnly) permissive.push("read-only mode is off");
  if (config.allowedDomains.length === 0) permissive.push("the domain allowlist is empty");
  if (!config.auditLog) permissive.push("the audit log is off");
  if (config.launchArgs.length > 0) permissive.push("extra launch arguments are set");
  if (process.env.ZENFORGE_BRIDGE_SCRIPT || process.env.ZEN_MCP_BRIDGE_SCRIPT) {
    permissive.push("a bridge script override is set");
  }
  checks.push({
    name: "Policy",
    status: permissive.length > 0 ? "warn" : "ok",
    detail:
      permissive.length > 0
        ? `More permissive than the safest settings: ${permissive.join(", ")}.`
        : "Consent, read-only mode, the domain allowlist and the audit log are all on.",
    hint: permissive.length > 0 ? "Review the policy fields in the config." : undefined,
  });

  return { ok: !checks.some((check) => check.status === "fail"), checks };
}
