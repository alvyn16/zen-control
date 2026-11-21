import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  SERVER_ARGS,
  SERVER_ENTRY_NAME,
  agentSetupPrompt,
  applyClient,
  catalog,
  clientIds,
  mergeJsonServer,
  mergeJsonServerPath,
  mergeTomlServer,
  type ClientContext,
  type ClientEntry,
} from "../../src/onboard/clients.js";
import {
  buildOptions,
  moveCursor,
  pickerResult,
  scrollWindow,
  toggleAll,
} from "../../src/onboard/picker.js";
import { createTheme } from "../../src/onboard/theme.js";

let root: string;
let savedNoColor: string | undefined;
let savedTerm: string | undefined;

function context(extra: Partial<ClientContext> = {}): ClientContext {
  return {
    command: "zen-control",
    home: root,
    platform: "linux",
    env: { ...process.env, XDG_CONFIG_HOME: join(root, "xdg") },
    ...extra,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zen-control-onboard-"));
  mkdirSync(join(root, "xdg"), { recursive: true });
  savedNoColor = process.env.NO_COLOR;
  savedTerm = process.env.TERM;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
  if (savedTerm === undefined) delete process.env.TERM;
  else process.env.TERM = savedTerm;
});

function looseJson(text: string): Record<string, unknown> {
  // Test-only JSONC reader: strip line comments and trailing commas.
  const stripped = text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped) as Record<string, unknown>;
}

describe("client catalog", () => {
  it("lists exactly 28 unique clients with the required ids", () => {
    const ids = clientIds();
    assert.equal(ids.length, 28);
    assert.equal(new Set(ids).size, 28);
    for (const id of [
      "claude-code", "claude-desktop", "cursor", "vscode", "codex",
      "gemini-cli", "windsurf", "cline", "zed", "opencode", "oh-my-pi",
      "deepseek-harness", "zcode", "roo-code", "kilo-code", "continue",
      "amp", "crush", "qwen-code", "kiro", "warp", "copilot-cli",
      "factory-droid", "amazon-q", "goose", "lm-studio", "junie", "pi",
    ]) {
      assert.ok(ids.includes(id), id);
    }
  });

  it("uses stable server entry constants", () => {
    assert.equal(SERVER_ENTRY_NAME, "zen-control");
    assert.deepEqual(SERVER_ARGS, ["serve"]);
  });

  it("groups popular clients first and resolves paths per platform", () => {
    const entries = catalog(context());
    assert.equal(entries.length, 28);
    assert.ok(entries.every((entry) => entry.popular || !entries.slice(0, entries.findIndex((e) => !e.popular)).includes(entry)));
    const firstNonPopular = entries.findIndex((entry) => !entry.popular);
    assert.ok(entries.slice(0, firstNonPopular).every((entry) => entry.popular));
    assert.ok(entries.slice(firstNonPopular).every((entry) => !entry.popular));

    const codex = entries.find((entry) => entry.id === "codex");
    assert.ok(codex);
    assert.ok(codex.configPath.startsWith(root), codex.configPath);
    assert.match(codex.configPath, /config\.toml$/);
  });

  it("detects installed clients and prefers an existing config path", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const entries = catalog(context());
    const claude = entries.find((entry) => entry.id === "claude-code");
    assert.ok(claude?.detected);
    assert.equal(claude.configPath, join(root, ".claude.json"));

    writeFileSync(join(root, ".claude.json"), "{}");
    assert.equal(
      catalog(context()).find((entry) => entry.id === "claude-code")?.configPath,
      join(root, ".claude.json")
    );
  });
});

describe("applying a client", () => {
  it("creates a new JSON config with the zen-control entry", () => {
    const result = applyClient("claude-code", context());
    assert.equal(result.status, "ok");
    assert.match(result.message, /created|created/i);
    const parsed = JSON.parse(readFileSync(join(root, ".claude.json"), "utf8")) as Record<string, unknown>;
    const servers = parsed.mcpServers as Record<string, unknown>;
    assert.deepEqual(servers["zen-control"], { command: "zen-control", args: ["serve"] });
  });

  it("preserves unrelated keys and replaces only the zen-control entry", () => {
    writeFileSync(
      join(root, ".claude.json"),
      JSON.stringify({
        theme: "dark",
        mcpServers: { other: { command: "other" }, "zen-control": { command: "old" } },
      })
    );
    applyClient("claude-code", context());
    const parsed = JSON.parse(readFileSync(join(root, ".claude.json"), "utf8")) as Record<string, unknown>;
    assert.equal(parsed.theme, "dark");
    const servers = parsed.mcpServers as Record<string, unknown>;
    assert.deepEqual(servers.other, { command: "other" });
    assert.deepEqual(servers["zen-control"], { command: "zen-control", args: ["serve"] });
  });

  it("preserves comments and trailing commas in JSONC", () => {
    const xdg = join(root, "xdg");
    const file = join(xdg, "opencode", "opencode.json");
    mkdirSync(join(xdg, "opencode"), { recursive: true });
    writeFileSync(
      file,
      [
        "{",
        "  // keep this comment",
        '  "theme": "dark",',
        '  "mcp": {',
        '    "servers": {',
        '      "other": { "type": "local", "command": ["other"] },',
        "    },",
        "  },",
        "}",
      ].join("\n")
    );

    const result = applyClient("opencode", context());
    assert.equal(result.status, "ok", result.message);
    const text = readFileSync(file, "utf8");
    assert.match(text, /\/\/ keep this comment/);
    const parsed = looseJson(text);
    const servers = ((parsed.mcp as Record<string, unknown>).servers) as Record<string, unknown>;
    assert.ok(servers.other);
    assert.deepEqual(servers["zen-control"], { type: "local", command: ["zen-control", "serve"] });
  });

  it("writes a TOML table for Codex and keeps other tables", () => {
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    const file = join(codexHome, "config.toml");
    writeFileSync(file, 'model = "o4-mini"\n\n[other]\ncommand = "x"\n');

    const result = applyClient("codex", context({ env: { CODEX_HOME: codexHome } }));
    assert.equal(result.status, "ok", result.message);
    const text = readFileSync(file, "utf8");
    assert.match(text, /model = "o4-mini"/);
    assert.match(text, /\[other\]/);
    assert.match(text, /\[mcp_servers\.zen-control\]/);
    assert.match(text, /command = "zen-control"/);
    assert.match(text, /args = \["serve"\]/);
  });

  it("merges a YAML mapping for Goose", () => {
    const file = join(root, "xdg", "goose", "config.yaml");
    mkdirSync(join(root, "xdg", "goose"), { recursive: true });
    writeFileSync(file, 'extensions:\n  other:\n    type: stdio\n');

    const result = applyClient("goose", context());
    assert.equal(result.status, "ok", result.message);
    const text = readFileSync(file, "utf8");
    assert.match(text, /other:/);
    assert.match(text, /zen-control:/);
    assert.match(text, /cmd: "zen-control"/);
  });

  it("reports unknown clients as failures", () => {
    const result = applyClient("not-a-client", context());
    assert.equal(result.status, "failed");
    assert.equal(result.message, "unknown client");
  });
});

describe("merge helpers", () => {
  it("merges JSON without touching siblings", () => {
    const merged = JSON.parse(
      mergeJsonServer(
        JSON.stringify({ keep: 1, mcpServers: { other: { command: "x" } } }),
        "mcpServers",
        { command: "zen-control", args: ["serve"] }
      )
    ) as Record<string, unknown>;
    assert.equal(merged.keep, 1);
    const servers = merged.mcpServers as Record<string, unknown>;
    assert.deepEqual(servers["zen-control"], { command: "zen-control", args: ["serve"] });
    assert.deepEqual(servers.other, { command: "x" });
  });

  it("creates nested paths and replaces an existing zen-control entry", () => {
    const created = JSON.parse(mergeJsonServerPath(undefined, ["mcp", "servers"], {
      command: "zen-control",
    })) as Record<string, unknown>;
    assert.ok(((created.mcp as Record<string, unknown>).servers as Record<string, unknown>)["zen-control"]);

    const replaced = JSON.parse(
      mergeJsonServerPath(JSON.stringify({ mcp: { servers: { "zen-control": { command: "old" } } } }), ["mcp", "servers"], {
        command: "zen-control",
        args: ["serve"],
      })
    ) as Record<string, unknown>;
    assert.deepEqual(
      (((replaced.mcp as Record<string, unknown>).servers as Record<string, unknown>)["zen-control"]),
      { command: "zen-control", args: ["serve"] }
    );
  });

  it("refuses a non-object server map", () => {
    assert.throws(
      () => mergeJsonServer('{"mcpServers": []}', "mcpServers", { command: "x" }),
      /not a JSON object/
    );
  });

  it("replaces only the target TOML table", () => {
    const next = mergeTomlServer(
      '# note\n[other]\ncommand = "x"\n\n[mcp_servers.zen-control]\ncommand = "old"\n',
      "mcp_servers.zen-control",
      { command: "zen-control", args: ["serve"] }
    );
    assert.match(next, /# note/);
    assert.match(next, /\[other\]/);
    assert.equal(next.match(/\[mcp_servers\.zen-control\]/g)?.length, 1);
    assert.match(next, /command = "zen-control"/);
  });
});

describe("other-client runbook", () => {
  it("includes paths, entry shapes, merge rules, validation and a report", () => {
    const prompt = agentSetupPrompt("/opt/zen-control/cli.js");
    assert.match(prompt, /\/opt\/zen-control\/cli\.js/);
    assert.match(prompt, /zen-control/);
    assert.match(prompt, /mcpServers/);
    assert.match(prompt, /context_servers/);
    assert.match(prompt, /mcp_servers\.zen-control/);
    assert.match(prompt, /Preserve every existing server/);
    assert.match(prompt, /Validation checklist/);
    assert.match(prompt, /Completion report/);
    assert.match(prompt, /~|\.config|APPDATA|XDG_CONFIG_HOME/);
  });
});

describe("picker helpers", () => {
  const entries: ClientEntry[] = [
    { id: "a", label: "Alpha", detail: "first", popular: true, detected: true, configPath: "/a", format: "json" },
    { id: "b", label: "Beta", detail: "second", popular: true, detected: false, configPath: "/b", format: "json" },
    { id: "c", label: "Gamma", detail: "third", popular: false, detected: false, configPath: "/c", format: "toml" },
  ];

  it("preselects detected clients and appends the other row", () => {
    const options = buildOptions(entries);
    assert.equal(options.length, 4);
    assert.deepEqual(options.slice(0, 3).map((option) => option.selected), [true, false, false]);
    assert.equal(options[3].id, "other");
    assert.equal(options[3].selected, false);
  });

  it("moves the cursor with wrapping", () => {
    const options = buildOptions(entries);
    assert.equal(moveCursor(options, 0, -1), options.length - 1);
    assert.equal(moveCursor(options, options.length - 1, 1), 0);
    assert.equal(moveCursor([], 0, 1), 0);
  });

  it("keeps the cursor inside a scrolling window", () => {
    assert.deepEqual(scrollWindow(28, 0, 8), { start: 0, end: 8 });
    assert.deepEqual(scrollWindow(28, 27, 8), { start: 20, end: 28 });
    assert.deepEqual(scrollWindow(28, 10, 8, 0), { start: 3, end: 11 });
  });

  it("toggles all clients but not other, and builds a result", () => {
    const options = buildOptions(entries);
    const all = toggleAll(options, true);
    assert.ok(all.slice(0, 3).every((option) => option.selected));
    assert.equal(all[3].selected, false);

    const result = pickerResult(all);
    assert.deepEqual(result.selected, ["a", "b", "c"]);
    assert.equal(result.other, false);

    const withOther = [...all.slice(0, 3), { ...all[3], selected: true }];
    assert.equal(pickerResult(withOther).other, true);
  });
});

describe("theme", () => {
  function stream(isTTY: boolean): NodeJS.WriteStream {
    return { isTTY, write: () => true } as unknown as NodeJS.WriteStream;
  }

  it("disables styling for pipes and NO_COLOR", () => {
    process.env.NO_COLOR = "1";
    const flat = createTheme(stream(true));
    assert.equal(flat.bold("x"), "x");
    assert.equal(flat.unicode, true);
    assert.equal(createTheme(stream(false)).unicode, false);
  });

  it("wraps text in ANSI codes on a coloured TTY", () => {
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
    const themed = createTheme(stream(true));
    assert.match(themed.bold("x"), /^\u001b\[1m/);
    assert.match(themed.green("x"), /^\u001b\[32m/);
    assert.match(themed.red("x"), /^\u001b\[31m/);
    assert.match(themed.yellow("x"), /^\u001b\[33m/);
    assert.match(themed.dim("x"), /^\u001b\[2m/);
  });
});
