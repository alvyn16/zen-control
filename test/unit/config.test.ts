import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  configFilePath,
  dataDirPath,
  loadConfig,
  saveConfig,
} from "../../src/config.js";

let tempDir: string;
let configPath: string;
let savedEnv: Array<[string, string | undefined]> = [];

function clearZenEnv(): void {
  savedEnv = Object.entries(process.env)
    .filter(([key]) => key.startsWith("ZEN_CONTROL_"))
    .map(([key, value]) => [key, value]);
  for (const [key] of savedEnv) delete process.env[key];
}

function restoreZenEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  clearZenEnv();
  tempDir = mkdtempSync(join(tmpdir(), "zen-control-config-"));
  configPath = join(tempDir, "config.json");
  process.env.ZEN_CONTROL_CONFIG = configPath;
});

afterEach(() => {
  restoreZenEnv();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("config paths", () => {
  it("honours ZEN_CONTROL_CONFIG and derives the data dir", () => {
    assert.equal(configFilePath(), configPath);
    assert.equal(dataDirPath(), join(tempDir, "data"));
    process.env.ZEN_CONTROL_DATA_DIR = "/custom/data";
    assert.equal(dataDirPath(), "/custom/data");
  });

  it("exports the full set of documented keys", () => {
    for (const key of [
      "zenPath", "profilePath", "useDefaultProfile", "requireConsent",
      "consentTimeoutSeconds", "autoLaunch", "askTimeoutSeconds",
      "marionettePort", "readOnly", "allowedDomains", "toolSurface",
    ]) {
      assert.ok((CONFIG_KEYS as readonly string[]).includes(key), key);
    }
  });
});

describe("config loading", () => {
  it("returns fail-closed defaults with no file", () => {
    const config = loadConfig();
    for (const [key, expected] of Object.entries(DEFAULT_CONFIG)) {
      assert.deepEqual(config[key as keyof typeof config], expected, key);
    }
    assert.equal(config.requireConsent, true);
    assert.equal(config.readOnly, false);
    assert.equal(config.toolSurface, "research");
  });

  it("reads file values and lets environment override them", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        readOnly: true,
        toolSurface: "core",
        allowedDomains: ["*.Example.com", ".Docs.Org."],
        launchArgs: ["-new-window"],
      })
    );
    const fromFile = loadConfig();
    assert.equal(fromFile.readOnly, true);
    assert.equal(fromFile.toolSurface, "core");
    assert.deepEqual(fromFile.allowedDomains, ["example.com", "docs.org"]);
    assert.deepEqual(fromFile.launchArgs, ["-new-window"]);

    process.env.ZEN_CONTROL_ASK_TIMEOUT_SECONDS = "77";
    process.env.ZEN_CONTROL_READ_ONLY = "false";
    process.env.ZEN_CONTROL_TOOL_SURFACE = "full";
    process.env.ZEN_CONTROL_ALLOWED_DOMAINS = "Alpha.Example, *.beta.test";
    const overridden = loadConfig();
    assert.equal(overridden.askTimeoutSeconds, 77);
    assert.equal(overridden.readOnly, false);
    assert.equal(overridden.toolSurface, "full");
    assert.deepEqual(overridden.allowedDomains, ["alpha.example", "beta.test"]);
  });

  it("clamps numeric values to their documented ranges", () => {
    process.env.ZEN_CONTROL_MARIONETTE_PORT = "999999";
    process.env.ZEN_CONTROL_CONSENT_TIMEOUT_SECONDS = "0";
    process.env.ZEN_CONTROL_WATCH_MIN_INTERVAL_SECONDS = "-5";
    const config = loadConfig();
    assert.equal(config.marionettePort, 65_535);
    assert.equal(config.consentTimeoutSeconds, 1);
    assert.equal(config.watchMinIntervalSeconds, 1);
  });

  it("falls back to defaults for non-numeric values", () => {
    process.env.ZEN_CONTROL_ASK_TIMEOUT_SECONDS = "not-a-number";
    assert.equal(loadConfig().askTimeoutSeconds, DEFAULT_CONFIG.askTimeoutSeconds);
  });

  it("parses launch arguments from the environment", () => {
    process.env.ZEN_CONTROL_LAUNCH_ARGS = "  -new-window   --kiosk  ";
    assert.deepEqual(loadConfig().launchArgs, ["-new-window", "--kiosk"]);
  });
});

describe("config fail-closed behaviour", () => {
  it("rejects malformed environment booleans", () => {
    process.env.ZEN_CONTROL_REQUIRE_CONSENT = "maybe";
    assert.throws(() => loadConfig(), /Invalid REQUIRE_CONSENT/);
  });

  it("accepts every documented boolean spelling", () => {
    for (const [value, expected] of [
      ["1", true], ["true", true], ["YES", true], ["on", true],
      ["0", false], ["false", false], ["no", false], ["OFF", false],
    ] as const) {
      process.env.ZEN_CONTROL_AUDIT_LOG = value;
      assert.equal(loadConfig().auditLog, expected, value);
    }
  });

  it("requires real JSON booleans in the file", () => {
    writeFileSync(configPath, JSON.stringify({ requireConsent: "true" }));
    assert.throws(() => loadConfig(), /expected a JSON boolean/);
  });

  it("rejects unknown tool surfaces", () => {
    process.env.ZEN_CONTROL_TOOL_SURFACE = "everything";
    assert.throws(() => loadConfig(), /Invalid tool surface/);
  });

  it("rejects a non-object config file", () => {
    writeFileSync(configPath, "[]");
    assert.throws(() => loadConfig(), /must be a JSON object/);
  });
});

describe("saveConfig", () => {
  it("does not bake environment overrides into the file", () => {
    writeFileSync(configPath, JSON.stringify({ readOnly: true }));
    process.env.ZEN_CONTROL_READ_ONLY = "false";
    process.env.ZEN_CONTROL_ASK_TIMEOUT_SECONDS = "42";

    saveConfig({ marionettePort: 4000 });
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(raw.readOnly, true);
    assert.equal(raw.marionettePort, 4000);
    assert.equal(raw.askTimeoutSeconds, DEFAULT_CONFIG.askTimeoutSeconds);
  });

  it("merges updates into unrelated file keys", () => {
    writeFileSync(configPath, JSON.stringify({ zenPath: "/opt/zen", custom: 7 }));
    saveConfig({ useDefaultProfile: true, profilePath: undefined });
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(raw.zenPath, "/opt/zen");
    assert.equal(raw.custom, 7);
    assert.equal(raw.useDefaultProfile, true);
  });
});
