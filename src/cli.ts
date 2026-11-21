import { existsSync } from "node:fs";
import { Command, InvalidArgumentError } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CONFIG_KEYS,
  configFilePath,
  dataDirPath,
  loadConfig,
  saveConfig,
  type AppConfig,
} from "./config.js";
import { createZenMcpServer } from "./mcp/server.js";
import {
  agentSetupPrompt,
  applyClient,
  catalog,
  clientIds,
} from "./onboard/clients.js";
import {
  buildOptions,
  pickClients,
  SelectionCancelled,
  type PickerResult,
} from "./onboard/picker.js";
import { createTheme } from "./onboard/theme.js";
import { BRAND, SERVER_VERSION } from "./shared/brand.js";
import { createLogger, type Logger } from "./utils/logger.js";
import { runDoctor } from "./zen/doctor.js";
import {
  checkForUpdate,
  detectPackageManager,
  isPackageManager,
  PACKAGE_MANAGERS,
  runInstaller,
  updateCommand,
} from "./zen/updates.js";
import {
  findZenExecutable,
  isPortOpen,
  isProfileLocked,
  isZenProcessRunning,
  resolvedProfilePath,
} from "./zen/launcher.js";
import { ZenRuntime } from "./zen/runtime.js";

const logger: Logger = createLogger("cli");
type ConfigKey = (typeof CONFIG_KEYS)[number];

const program = new Command();

program
  .name("zen-control")
  .description(
    `${BRAND}: an independent MCP harness for Zen Browser. Own a dedicated ` +
      "browser, research tabs in the background, read pages, and control the " +
      "workspace over MCP."
  )
  .version(SERVER_VERSION);

program
  .command("serve")
  .description("Run the MCP server over stdio (the default command).")
  .action(() => serve());

program
  .command("launch")
  .description("Launch a Zen window owned by Zen Control, verify lockdown, then quit.")
  .action(() => launch());

program
  .command("status")
  .description("Print resolved config and port state without creating a session.")
  .action(() => status());

program
  .command("doctor")
  .description("Check the Zen install, config, profile and Marionette port.")
  .action(() => doctor());

program
  .command("update")
  .description("Check npm for a newer Zen Control release and install it.")
  .option("--check", "Report installed and latest versions without installing.")
  .option("--manager <name>", "Package manager: npm, pnpm, yarn or bun.")
  .action((options: UpdateOptions) => update(options));

program
  .command("setup")
  .description("Detect Zen, write a config file and print an MCP client snippet.")
  .option("--zen-path <path>", "Path to the Zen executable.")
  .option("--profile <path>", "Run Zen with a dedicated profile directory.")
  .option(
    "--use-default-profile",
    "Use the normal Zen profile. Quit Zen before the agent launches it."
  )
  .option("--dedicated-profile", "Use the dedicated agent profile (the default).")
  .option("--no-auto-launch", "Never launch Zen automatically from a tool call.")
  .option(
    "--ask-timeout <seconds>",
    "Default wait for in-browser answers.",
    (value: string) => parseInteger(value, "ask timeout")
  )
  .option(
    "--marionette-port <port>",
    "Marionette port. Zen currently always uses 2828.",
    (value: string) => parseInteger(value, "marionette port")
  )
  .option("--skip-doctor", "Write the config without running diagnostics.")
  .action((options: SetupOptions) => setup(options));

program
  .command("onboard")
  .description("Pick MCP clients and add Zen Control to their configuration.")
  .option(
    "--clients <ids>",
    "Comma-separated client ids, 'all' or 'other'. Skips the interactive picker."
  )
  .option("--command <command>", "Command clients should run. Defaults to `zen-control`.")
  .option("--other", "Also print a setup prompt for any other client.")
  .addHelpText("after", `\nClient ids: ${clientIds().join(", ")}, other.`)
  .action((options: OnboardOptions) => onboard(options));

const configCommand = program
  .command("config")
  .description("Show or change the saved configuration.");

configCommand
  .command("show")
  .description("Print the config file path and resolved values.")
  .action(() => configShow());

configCommand
  .command("set")
  .description(`Set one key: ${CONFIG_KEYS.join(", ")}.`)
  .argument("<key>", "Config key.")
  .argument("<value>", "New value. Use an empty string to clear a path.")
  .action((key: string, value: string) => configSet(key, value));

program.action(() => serve());

await program.parseAsync(process.argv);

/* ------------------------------------------------------------------ *
 * Command option shapes
 * ------------------------------------------------------------------ */

interface UpdateOptions {
  check?: boolean;
  manager?: string;
}

interface SetupOptions {
  zenPath?: string;
  profile?: string;
  useDefaultProfile?: boolean;
  dedicatedProfile?: boolean;
  autoLaunch?: boolean;
  askTimeout?: number;
  marionettePort?: number;
  skipDoctor?: boolean;
}

interface OnboardOptions {
  clients?: string;
  command?: string;
  other?: boolean;
}

interface DoctorReportLike {
  ok: boolean;
  checks: Array<{
    name: string;
    status: "ok" | "warn" | "fail";
    detail: string;
    hint?: string;
  }>;
}

interface UpdateInfoLike {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  error?: string;
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

async function serve(): Promise<void> {
  const config = loadConfig();
  const runtime = new ZenRuntime({ config, logger });
  const server = createZenMcpServer(runtime, config);
  const transport = new StdioServerTransport();

  let stopping = false;
  const stop = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info(`stopping (${reason})`);
    await runtime.shutdown().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  transport.onclose = () => void stop("stdio closed");

  await server.connect(transport);
  void runtime.checkForUpdates();
  logger.info(`${BRAND} ${SERVER_VERSION} ready on stdio`);
}

async function launch(): Promise<void> {
  const config = loadConfig();
  const runtime = new ZenRuntime({ config, logger });
  try {
    await runtime.start();
    console.log(
      "Starting a Zen window owned by Zen Control. If an approval card appears, " +
        "click Allow to let the agent connect."
    );
    const connection: unknown = await runtime.connect({ allowLaunch: true });
    const status: unknown = await runtime.status();
    const info: unknown = runtime.sessionInfo();

    const statusRecord = asRecord(status);
    const infoRecord = asRecord(info);
    const appName = asString(statusRecord?.appName) ?? "Zen";
    const appVersion = asString(statusRecord?.appVersion) ?? "(unknown version)";
    console.log(`${appName} ${appVersion} is running with agent access.`);
    console.log(
      `Browser pid ${asNumber(infoRecord?.browserPid) ?? "(unknown)"}, profile ` +
        `${asString(infoRecord?.profile) ?? "normal profile"}.`
    );
    const locked = asBoolean(infoRecord?.lockedDown);
    console.log(
      `Marionette is locked to this session${locked === false ? " (lockdown not confirmed)" : ""}.`
    );
    console.log(
      `${countOf(statusRecord?.spaces)} space(s), ` +
        `${asNumber(statusRecord?.tabCount) ?? 0} tab(s), ` +
        `${asNumber(statusRecord?.folderCount) ?? 0} folder(s).`
    );
    console.log(
      "This is a one-shot check: Zen Control quits the browser it started on exit. " +
        "The MCP server keeps its browser open for the session."
    );
    if (asRecord(connection)?.launched === false) {
      console.log("Zen was already owned by this process.");
    }
  } catch (error) {
    console.error(`Launch failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
}

async function status(): Promise<void> {
  const config = loadConfig();

  let executable: string | null = null;
  let executableError: string | null = null;
  try {
    executable = findZenExecutable(config) ?? null;
  } catch (error) {
    executableError = errorMessage(error);
  }

  let profile: string | null = null;
  let profileError: string | null = null;
  try {
    profile = resolvedProfilePath(config) ?? null;
  } catch (error) {
    profileError = errorMessage(error);
  }

  const portOpen = await isPortOpen(config.marionettePort).catch(() => false);
  let profileLocked: boolean | null = null;
  if (profile && !profileError) {
    try {
      profileLocked = isProfileLocked(profile);
    } catch {
      profileLocked = null;
    }
  }
  let processRunning = false;
  try {
    processRunning = isZenProcessRunning();
  } catch {
    processRunning = false;
  }

  console.log(
    JSON.stringify(
      {
        server: {
          version: SERVER_VERSION,
          config: configFilePath(),
          dataDir: dataDirPath(),
        },
        zen: {
          executable,
          executableError,
          profileMode: config.profilePath
            ? "custom"
            : config.useDefaultProfile
              ? "default"
              : "dedicated",
          profilePath: profile,
          profilePathError: profileError,
          profileLocked,
          processRunning,
        },
        marionette: {
          port: config.marionettePort,
          acceptingConnections: portOpen,
          note:
            "An open port means another process owns Marionette. Zen Control only " +
            "controls a browser it launched and closes the port after startup.",
        },
        consent: {
          required: config.requireConsent,
          timeoutSeconds: config.consentTimeoutSeconds,
          readOnly: config.readOnly,
          allowedDomains: config.allowedDomains,
        },
        session:
          "No session is created by this command. Run the MCP server to let the " +
          "agent launch and own a browser.",
      },
      null,
      2
    )
  );
}

async function doctor(): Promise<void> {
  const report: DoctorReportLike = await runDoctor(loadConfig());
  const update: UpdateInfoLike = await checkForUpdate({ timeoutMs: 1_500 });
  printReport(report, update);
  if (!report.ok) process.exitCode = 1;
}

async function update(options: UpdateOptions): Promise<void> {
  console.log(`${BRAND} ${SERVER_VERSION}: checking npm for the latest release...`);
  const info: UpdateInfoLike = await checkForUpdate({ timeoutMs: 5_000 });
  if (!info.latestVersion) {
    console.error(`Could not check for updates: ${info.error ?? "unknown error"}.`);
    console.error("Install manually: npm install -g zen-control@latest");
    process.exitCode = 1;
    return;
  }
  if (!info.updateAvailable) {
    console.log(`Up to date: ${info.latestVersion} is the latest release.`);
    return;
  }
  console.log(`Update available: ${info.currentVersion} -> ${info.latestVersion}`);
  if (options.check) {
    console.log("Run `zen-control update` to install it.");
    return;
  }

  const requested = options.manager?.trim().toLowerCase();
  let manager: string;
  if (requested) {
    if (!isPackageManager(requested)) {
      console.error(`Unknown package manager "${options.manager}".`);
      console.error(`Use one of: ${PACKAGE_MANAGERS.join(", ")}.`);
      process.exitCode = 1;
      return;
    }
    manager = requested;
  } else {
    manager = detectPackageManager();
  }

  const { command, args } = updateCommand(
    manager as Parameters<typeof updateCommand>[0]
  );
  console.log(`Running: ${command} ${args.join(" ")}`);
  const code = await runInstaller(command, args);
  if (code !== 0) {
    console.error(`Installer exited with code ${code}.`);
    console.error(`Install manually: ${command} ${args.join(" ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "Installed. Restart any MCP client that runs `zen-control serve` to load the " +
      "new version."
  );
}

async function setup(options: SetupOptions): Promise<void> {
  const updates: Partial<AppConfig> = {};
  if (options.zenPath) updates.zenPath = options.zenPath;
  if (options.profile) {
    updates.profilePath = options.profile;
    updates.useDefaultProfile = false;
  }
  if (options.useDefaultProfile) {
    updates.useDefaultProfile = true;
    updates.profilePath = undefined;
  }
  if (options.dedicatedProfile) updates.useDefaultProfile = false;
  if (options.autoLaunch === false) updates.autoLaunch = false;
  if (options.askTimeout !== undefined) updates.askTimeoutSeconds = options.askTimeout;
  if (options.marionettePort !== undefined) updates.marionettePort = options.marionettePort;

  const firstTime = !existsSync(configFilePath());
  if (!updates.zenPath && !loadConfig().zenPath) {
    try {
      updates.zenPath = findZenExecutable(loadConfig()) ?? undefined;
    } catch {
      // `doctor` explains detection failures.
    }
  }

  if (firstTime || Object.keys(updates).length > 0) {
    const path = saveConfig(updates);
    console.log(`Saved config: ${path}`);
  } else {
    console.log(`Config already exists: ${configFilePath()}`);
  }

  if (!options.skipDoctor) {
    console.log("");
    printReport(await runDoctor(loadConfig()));
  }

  console.log("");
  console.log("MCP client configuration:");
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "zen-control": { command: "zen-control", args: ["serve"] },
        },
      },
      null,
      2
    )
  );
  console.log(
    "\nIf `zen-control` is not on your PATH, point command at the absolute path " +
      'of dist/cli.js and keep args as ["serve"].'
  );
  console.log("Run `zen-control onboard` to add Zen Control to a supported MCP client.");
}

async function onboard(options: OnboardOptions): Promise<void> {
  const context = { command: options.command?.trim() || "zen-control" };
  const theme = createTheme(process.stdout);
  const rule = theme.unicode ? "─".repeat(52) : "-".repeat(52);
  const entries = catalog(context);
  const known = new Set(entries.map((entry) => entry.id));

  let selected: string[];
  let includeOther = Boolean(options.other);

  if (options.clients?.trim()) {
    const tokens = options.clients
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    const unknown = tokens.filter(
      (token) => token !== "other" && token !== "all" && !known.has(token)
    );
    if (unknown.length > 0) {
      console.error(`Unknown client(s): ${unknown.join(", ")}.`);
      console.error(`Valid clients: ${[...known].join(", ")}, other, all.`);
      process.exitCode = 1;
      return;
    }
    selected = tokens.includes("all")
      ? entries.map((entry) => entry.id)
      : tokens.filter((token) => token !== "other");
    includeOther = includeOther || tokens.includes("other");
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("The client picker needs an interactive terminal.");
      console.error("Use --clients with a comma-separated list instead:");
      console.error("  zen-control onboard --clients claude-code,cursor,other");
      console.error(`Valid clients: ${[...known].join(", ")}, other.`);
      process.exitCode = 1;
      return;
    }
    let result: PickerResult;
    try {
      result = await pickClients(buildOptions(entries));
    } catch (error) {
      if (error instanceof SelectionCancelled) {
        console.log("Cancelled. No client configuration was changed.");
        process.exitCode = 130;
        return;
      }
      throw error;
    }
    selected = result.selected;
    includeOther = includeOther || result.other;
  }

  if (selected.length === 0 && !includeOther) {
    console.log(theme.dim("  Nothing selected. No client configuration was changed."));
    return;
  }

  if (!existsSync(configFilePath())) {
    const updates: Partial<AppConfig> = {};
    try {
      updates.zenPath = findZenExecutable(loadConfig()) ?? undefined;
    } catch {
      // `doctor` explains detection failures.
    }
    const path = saveConfig(updates);
    console.log(`  ${theme.green("OK")} Saved config ${theme.dim(path)}`);
    console.log("");
  }

  let failed = 0;
  if (selected.length > 0) {
    let connected = 0;
    console.log(`  ${theme.bold("Client configuration")}`);
    console.log(`  ${theme.dim(rule)}`);
    for (const id of selected) {
      const result = applyClient(id, context);
      if (result.status === "ok") {
        connected += 1;
        console.log(
          `  ${theme.green("OK")} ${result.label.padEnd(20)} ${theme.dim(result.message)}`
        );
      } else {
        failed += 1;
        console.log(
          `  ${theme.red("FAIL")} ${result.label.padEnd(20)} ${theme.red(result.message)}`
        );
      }
    }
    console.log("");
    console.log(
      `  ${
        failed === 0
          ? theme.green(
              `${connected} client${connected === 1 ? "" : "s"} connected`
            )
          : theme.yellow(`${connected} connected, ${failed} failed`)
      }`
    );
  }

  if (includeOther) {
    console.log("");
    console.log(`  ${theme.bold("Other client")}`);
    console.log(`  ${theme.dim(rule)}`);
    console.log(`  ${theme.dim("Paste this prompt into your agent.")}`);
    console.log("");
    console.log(agentSetupPrompt(context.command));
  }

  console.log("");
  console.log(
    theme.dim(
      selected.length > 0
        ? "  Restart the selected clients so they load the server. On the first " +
            "browser tool, approve the card in Zen."
        : "  Restart the client after your agent updates its configuration. On " +
            "the first browser tool, approve the card in Zen."
    )
  );
  if (!options.command) {
    console.log(
      theme.dim(
        "  If `zen-control` is not on your PATH, rerun with " +
          "--command <absolute path to dist/cli.js>."
      )
    );
  }
  if (failed > 0) process.exitCode = 1;
}

function configShow(): void {
  console.log(configFilePath());
  console.log(JSON.stringify(loadConfig(), null, 2));
}

function configSet(key: string, rawValue: string): void {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    console.error(`Unknown key "${key}". Valid keys: ${CONFIG_KEYS.join(", ")}.`);
    process.exitCode = 1;
    return;
  }

  const name = key as ConfigKey;
  const value = rawValue.trim();
  const updates: Partial<AppConfig> = {};
  let parsed: string | string[] | number | boolean | null | undefined;

  const boundedNumber = (min: number, max: number): number | null => {
    let number: number;
    try {
      number = parseInteger(value, name);
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
      return null;
    }
    if (number < min || number > max) {
      console.error(`${name} must be between ${min} and ${max}.`);
      process.exitCode = 1;
      return null;
    }
    return number;
  };

  const booleanValue = (): boolean | null => {
    if (!/^(true|false|1|0|yes|no)$/i.test(value)) {
      console.error(`${name} expects true or false.`);
      process.exitCode = 1;
      return null;
    }
    return /^(true|1|yes)$/i.test(value);
  };

  switch (name) {
    case "zenPath":
    case "profilePath":
    case "dataDir":
      parsed = value || undefined;
      if (name === "profilePath" && parsed) updates.useDefaultProfile = false;
      break;
    case "useDefaultProfile": {
      const boolean = booleanValue();
      if (boolean === null) return;
      parsed = boolean;
      if (boolean) updates.profilePath = undefined;
      break;
    }
    case "autoLaunch":
    case "autoAttachWindows":
    case "requireConsent":
    case "readOnly":
    case "auditLog": {
      const boolean = booleanValue();
      if (boolean === null) return;
      parsed = boolean;
      break;
    }
    case "launchTimeoutMs":
      parsed = boundedNumber(1_000, 300_000);
      if (parsed === null) return;
      break;
    case "askTimeoutSeconds":
    case "watchMinIntervalSeconds":
      parsed = boundedNumber(1, 3_600);
      if (parsed === null) return;
      break;
    case "consentTimeoutSeconds":
      parsed = boundedNumber(1, 600);
      if (parsed === null) return;
      break;
    case "marionettePort":
      parsed = boundedNumber(1, 65_535);
      if (parsed === null) return;
      break;
    case "allowedDomains":
      parsed = value
        ? value.split(",").map((domain) => domain.trim().toLowerCase()).filter(Boolean)
        : [];
      break;
    case "launchArgs":
      parsed = value ? value.split(/\s+/).filter(Boolean) : [];
      break;
    case "toolSurface":
      parsed = value.toLowerCase();
      if (parsed !== "research" && parsed !== "core" && parsed !== "full") {
        console.error("toolSurface must be research, core or full.");
        process.exitCode = 1;
        return;
      }
      break;
  }

  (updates as Record<string, unknown>)[name] = parsed;
  const path = saveConfig(updates);
  console.log(`Saved ${name} = ${JSON.stringify(parsed)} in ${path}`);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function printReport(report: DoctorReportLike, update?: UpdateInfoLike): void {
  for (const check of report.checks) {
    const mark =
      check.status === "ok" ? "[ ok ]" : check.status === "warn" ? "[warn]" : "[FAIL]";
    console.log(`${mark} ${check.name}: ${check.detail}`);
    if (check.hint) console.log(`       ${check.hint}`);
  }
  if (update) {
    if (!update.latestVersion) {
      console.log(`[warn] Update: could not check npm (${update.error ?? "unknown"}).`);
    } else if (update.updateAvailable) {
      console.log(
        `[warn] Update: ${update.latestVersion} is available ` +
          `(installed ${update.currentVersion}).`
      );
      console.log("       Run `zen-control update` to install it.");
    } else {
      console.log(`[ ok ] Update: ${update.currentVersion} is the latest release.`);
    }
  }
  console.log("");
  console.log(
    report.ok
      ? "Ready to launch: the MCP server will start its own Zen window and ask " +
          "for approval in the browser the first time a tool needs it. Run " +
          "`zen-control launch` for a one-shot live check."
      : "Not ready: fix the failed checks above."
  );
}

function parseInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new InvalidArgumentError(`${label} must be a whole number`);
  }
  return Number(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
