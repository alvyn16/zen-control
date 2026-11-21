import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWritePrivate, readFileTextBounded } from "../utils/safe-file.js";

const MAX_CLIENT_CONFIG_BYTES = 20 * 1024 * 1024;

/** The key every client registers the server under. */
export const SERVER_ENTRY_NAME = "zenforge";
/** Arguments the client passes to the server command. */
export const SERVER_ARGS: string[] = ["serve"];
/** Default command when the caller does not provide one. */
export const DEFAULT_COMMAND = "zenforge";

export type MergeFormat = "json" | "toml" | "text";

export interface ClientContext {
  command?: string;
  /** Injection points for tests; production callers leave these unset. */
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

interface ResolvedContext {
  command: string;
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  configBase: string;
  xdg: string;
}

interface JsonSpec {
  path: string[];
  entry(ctx: ResolvedContext): Record<string, unknown>;
}

interface TomlSpec {
  section: string;
  values(ctx: ResolvedContext): Record<string, string | string[]>;
}

interface ClientDefinition {
  id: string;
  label: string;
  detail: string;
  popular: boolean;
  format: MergeFormat;
  configPaths(ctx: ResolvedContext): string[];
  detectPaths(ctx: ResolvedContext): string[];
  json?: JsonSpec;
  toml?: TomlSpec;
  text?: (existing: string | undefined, ctx: ResolvedContext) => string;
}

export interface ClientEntry {
  id: string;
  label: string;
  detail: string;
  popular: boolean;
  detected: boolean;
  configPath: string;
  format: MergeFormat;
}

export interface ApplyResult {
  status: "ok" | "failed";
  label: string;
  message: string;
}

/* ------------------------------------------------------------------ *
 * Client catalog
 * ------------------------------------------------------------------ */

const CLINE_SETTINGS = join(
  "User",
  "globalStorage",
  "saoudrizwan.claude-dev",
  "settings",
  "cline_mcp_settings.json"
);

const ROO_SETTINGS = join(
  "User",
  "globalStorage",
  "rooveterinaryinc.roo-cline",
  "settings",
  "mcp_settings.json"
);

function stdioEntry(ctx: ResolvedContext): Record<string, unknown> {
  return { command: ctx.command, args: [...SERVER_ARGS] };
}

function localArrayEntry(ctx: ResolvedContext): Record<string, unknown> {
  return { type: "local", command: [ctx.command, ...SERVER_ARGS] };
}

function tomlValues(ctx: ResolvedContext): Record<string, string | string[]> {
  return { command: ctx.command, args: [...SERVER_ARGS] };
}

const DEFINITIONS: ClientDefinition[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    detail: "Anthropic terminal agent",
    popular: true,
    format: "json",
    configPaths: (c) => [join(c.home, ".claude.json")],
    detectPaths: (c) => [join(c.home, ".claude.json"), join(c.home, ".claude")],
    json: { path: ["mcpServers"], entry: stdioEntry },
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    detail: "Claude desktop application",
    popular: true,
    format: "json",
    configPaths: (c) => [join(c.configBase, "Claude", "claude_desktop_config.json")],
    detectPaths: (c) => [join(c.configBase, "Claude")],
    json: { path: ["mcpServers"], entry: stdioEntry },
  },
  {
    id: "cursor",
    label: "Cursor",
    detail: "Cursor editor",
    popular: true,
    format: "json",
    configPaths: (c) => [join(c.home, ".cursor", "mcp.json")],
    detectPaths: (c) => [join(c.home, ".cursor")],
    json: { path: ["mcpServers"], entry: stdioEntry },
  },
  {
    id: "vscode",
    label: "VS Code",
    detail: "GitHub Copilot agent mode",
    popular: true,
    format: "json",
    configPaths: (c) => [
      join(c.configBase, "Code", "User", "mcp.json"),
      join(c.configBase, "Code - Insiders", "User", "mcp.json"),
    ],
    detectPaths: (c) => [
      join(c.configBase, "Code", "User"),
      join(c.configBase, "Code - Insiders", "User"),
    ],
    json: {
      path: ["servers"],
      entry: (c) => ({ type: "stdio", ...stdioEntry(c) }),
    },
  },
  {
    id: "codex",
    label: "Codex CLI",
    detail: "OpenAI Codex terminal agent",
    popular: true,
    format: "toml",
    configPaths: (c) => [join(c.env.CODEX_HOME ?? join(c.home, ".codex"), "config.toml")],
    detectPaths: (c) => [c.env.CODEX_HOME ?? join(c.home, ".codex")],
    toml: { section: "mcp_servers", values: tomlValues },
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    detail: "Google terminal agent",
    popular: true,
    format: "json",
    configPaths: (c) => [join(c.home, ".gemini", "settings.json")],
    detectPaths: (c) => [join(c.home, ".gemini")],
    json: { path: ["mcpServers"], entry: stdioEntry },
  },
  {
    id: "windsurf",
    label: "Windsurf",
    detail: "Windsurf editor",
    popular: false,
    format: "json",
    configPaths: (c) => [join(c.home, ".codeium", "windsurf", "mcp_config.json")],
    detectPaths: (c) => [join(c.home, ".codeium", "windsurf")],
    json: { path: ["mcpServers"], entry: stdioEntry },
  },
  {
    id: "cline",
    label: "Cline",
    detail: "VS Code compatible extension",
    popular: false,
    format: "json",
    configPaths: (c) => [
      join(c.configBase, "Code", CLINE_SETTINGS),
      join(c.configBase, "Cursor", CLINE_SETTINGS),
      join(c.configBase, "Windsurf", CLINE_SETTINGS),
    ],
    detectPaths: (c) => [
      dirname(join(c.configBase, "Code", CLINE_SETTINGS)),
      dirname(join(c.configBase, "Cursor", CLINE_SETTINGS)),
      dirname(join(c.configBase, "Windsurf", CLINE_SETTINGS)),
    ],
    json: { path: ["mcpServers"], entry: stdioEntry },
  },
  {
    id: "zed",
    label: "Zed",
    detail: "Zed editor",
    popular: false,
    format: "json",
    configPaths: (c) => [join(c.configBase, c.platform === "linux" ? "zed" : "Zed", "settings.json")],
    detectPaths: (c) => [join(c.configBase, c.platform === "linux" ? "zed" : "Zed")],
    json: { path: ["context_servers"], entry: stdioEntry },
  },
  {
    id: "opencode",
    label: "OpenCode",
    detail: "sst terminal agent",
    popular: true,
    format: "json",
    configPaths: (c) => [
      join(c.xdg, "opencode", "opencode.json"),
      join(c.xdg, "opencode", "opencode.jsonc"),
    ],
    detectPaths: (c) => [join(c.xdg, "opencode")],
    json: { path: ["mcp", "servers"], entry: localArrayEntry },
  },
  {
    id: "oh-my-pi",
    label: "oh-my-pi",
    detail: "can1357 terminal agent",
    popular: true,
    format: "json",
    configPaths: (c) => [join(c.env.PI_CONFIG_DIR ?? join(c.home, ".omp"), "agent", "mcp.json")],
    detectPaths: (c) => [c.env.PI_CONFIG_DIR ?? join(c.home, ".omp")],
    json: {
      path: ["mcpServers"],
      entry: (c) => ({ type: "stdio", ...stdioEntry(c) }),
    },
  },
  {
    id: "deepseek-harness",
    label: "DeepSeek Harness",
    detail: "dsh agent framework",
    popular: true,
    format: "text",
    configPaths: (c) => [join(c.env.DSH_HOME ?? join(c.home, ".dsh"), "cordis.patch.yml")],
    detectPaths: (c) => [c.env.DSH_HOME ?? join(c.home, ".dsh")],
    text: (existing, c) => mergeDshPatch(existing, c),
  },
  {
    id: "zcode",
    label: "ZCode",
    detail: "Z.ai coding agent",
    popular: true,
    format: "json",
    configPaths: (c) => [join(c.home, ".zcode", "cli", "config.json")],
    detectPaths: (c) => [join(c.home, ".zcode")],
    json: {
      path: ["mcp", "servers"],
      entry: (c) => ({ ...stdioEntry(c), env: {} }),
    },
  },
  {
    id: "roo-code",
    label: "Roo Code",
    detail: "VS Code extension",
    popular: false,
    format: "json",
    configPaths: (c) => [join(c.configBase, "Code", ROO_SETTINGS)],
    detectPaths: (c) => [dirname(join(c.configBase, "Code", ROO_SETTINGS))],
    json: {
      path: ["mcpServers"],
      entry: (c) => ({
        ...stdioEntry(c),
        disabled: false,
        alwaysAllow: [],
      }),
    },
  },
  {
    id: "kilo-code",
    label: "Kilo Code",
    detail: "Kilo editor extension",
    popular: false,
    format: "json",
    configPaths: (c) => [join(c.xdg, "kilo", "kilo.jsonc")],
    detectPaths: (c) => [join(c.xdg, "kilo")],
    json: {
      path: ["mcp"],
      entry: (c) => ({
        ...localArrayEntry(c),
        enabled: true,
        timeout: 10_000,
      }),
    },
  },
  {
    id: "continue",
    label: "Continue",
    detail: "VS Code and JetBrains extension",
    popular: false,
    format: "text",
    configPaths: (c) => [join(c.home, ".continue", "config.yaml")],
    detectPaths: (c) => [join(c.home, ".continue")],
    text: (existing, c) =>
      mergeYamlList(existing, "mcpServers", SERVER_ENTRY_NAME, [
        `name: ${SERVER_ENTRY_NAME}`,
        "type: stdio",
        `command: ${yamlScalar(c.command)}`,
        `args: ${yamlFlowArray(SERVER_ARGS)}`,
      ]),
  },
  {
    id: "amp",
    label: "Amp",
    detail: "Sourcegraph terminal agent",
    popular: false,
    format: "json",
    configPaths: (c) => [
      c.platform === "win32"
        ? join(c.configBase, "amp", "settings.json")
        : join(c.xdg, "amp", "settings.json"),
    ],
    detectPaths: (c) => [
      c.platform === "win32" ? join(c.configBase, "amp") : join(c.xdg, "amp"),
    ],
    json: { path: ["amp.mcpServers"], entry: stdioEntry },
  },
  {
    id: "crush",
    label: "Crush",
    detail: "Charmbracelet terminal agent",
    popular: false,
    format: "text",
    configPaths: (c) => [c.env.CRUSH_GLOBAL_CONFIG ?? join(c.xdg, "crush", "crushrc")],
    detectPaths: (c) => [join(c.xdg, "crush")],
    text: (existing, c) => mergeCrushrc(existing, c),
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    detail: "Alibaba terminal agent",
    popular: false,
    format: "json",
    configPaths: (c) => [join(c.env.QWEN_HOME ?? join(c.home, ".qwen"), "settings.json")],
    detectPaths: (c) => [c.env.QWEN_HOME ?? join(c.home, ".qwen")],
    json: { path: ["mcpServers"], entry: stdioEntry },
  },
  {
    id: "kiro",
    label: "Kiro",
    detail: "AWS agentic IDE and CLI",
    popular: false,
    format: "json",
    configPaths: (c) => [join(c.home, ".kiro", "settings", "mcp.json")],
    detectPaths: (c) => [join(c.home, ".kiro")],
    json: {
      path: ["mcpServers"],
      entry: (c) => ({ ...stdioEntry(c), disabled: false, autoApprove: [] }),
    },
  },
  {
    id: "warp",
    label: "Warp",
    detail: "Warp terminal agent",
    popular: false,
    format: "json",
    configPaths: (c) => [join(c.home, ".warp", ".mcp.json")],
    detectPaths: (c) => [join(c.home, ".warp")],
    json: { path: ["mcpServers"], entry: stdioEntry },
  },
  {
    id: "copilot-cli",
    label: "Copilot CLI",
    detail: "GitHub Copilot terminal agent",
    popular: false,
    format: "json",
    configPaths: (c) => [join(c.home, ".copilot", "mcp-config.json")],
    detectPaths: (c) => [join(c.home, ".copilot")],
    json: {
      path: ["mcpServers"],
      entry: (c) => ({ type: "local", ...stdioEntry(c), tools: ["*"] }),
    },
  },
  {
    id: "factory-droid",
    label: "Factory Droid",
    detail: "Factory terminal agent",
    popular: false,
    format: "json",
    configPaths: (c) => [join(c.home, ".factory", "mcp.json")],
    detectPaths: (c) => [join(c.home, ".factory")],
    json: {
      path: ["mcpServers"],
      entry: (c) => ({ type: "stdio", ...stdioEntry(c), disabled: false }),
    },
  },
  {
    id: "amazon-q",
    label: "Amazon Q",
    detail: "Amazon Q Developer CLI",
    popular: false,
    format: "json",
    configPaths: (c) => [join(c.home, ".aws", "amazonq", "mcp.json")],
    detectPaths: (c) => [join(c.home, ".aws", "amazonq")],
    json: { path: ["mcpServers"], entry: stdioEntry },
  },
  {
    id: "goose",
    label: "Goose",
    detail: "Block terminal agent",
    popular: false,
    format: "text",
    configPaths: (c) => [
      c.platform === "win32"
        ? join(c.configBase, "Block", "goose", "config", "config.yaml")
        : join(c.xdg, "goose", "config.yaml"),
    ],
    detectPaths: (c) => [
      c.platform === "win32"
        ? join(c.configBase, "Block", "goose")
        : join(c.xdg, "goose"),
    ],
    text: (existing, c) =>
      mergeYamlMapping(existing, "extensions", SERVER_ENTRY_NAME, [
        "type: stdio",
        `name: ${SERVER_ENTRY_NAME}`,
        "enabled: true",
        `cmd: ${yamlScalar(c.command)}`,
        `args: ${yamlFlowArray(SERVER_ARGS)}`,
        "envs: {}",
        "timeout: 300",
      ]),
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    detail: "LM Studio desktop application",
    popular: false,
    format: "json",
    configPaths: (c) => [join(c.home, ".lmstudio", "mcp.json")],
    detectPaths: (c) => [join(c.home, ".lmstudio")],
    json: { path: ["mcpServers"], entry: stdioEntry },
  },
  {
    id: "junie",
    label: "Junie",
    detail: "JetBrains Junie CLI",
    popular: false,
    format: "json",
    configPaths: (c) => [join(c.home, ".junie", "mcp", "mcp.json")],
    detectPaths: (c) => [join(c.home, ".junie")],
    json: { path: ["mcpServers"], entry: stdioEntry },
  },
  {
    id: "pi",
    label: "Pi",
    detail: "pi.dev terminal agent",
    popular: false,
    format: "json",
    configPaths: (c) => [join(c.home, ".pi", "agent", "mcp.json")],
    detectPaths: (c) => [join(c.home, ".pi")],
    json: { path: ["mcpServers"], entry: stdioEntry },
  },
];

/** Every supported client id, in catalog order. */
export function clientIds(): string[] {
  return DEFINITIONS.map((definition) => definition.id);
}

/** Resolved client rows; popular entries are grouped first for the picker. */
export function catalog(context: ClientContext = {}): ClientEntry[] {
  const resolved = resolveContext(context);
  const entries = DEFINITIONS.map((definition): ClientEntry => {
    const paths = definition.configPaths(resolved);
    return {
      id: definition.id,
      label: definition.label,
      detail: definition.detail,
      popular: definition.popular,
      detected: definition.detectPaths(resolved).some((path) => existsSync(path)),
      configPath: paths.find((path) => existsSync(path)) ?? paths[0],
      format: definition.format,
    };
  });
  return [
    ...entries.filter((entry) => entry.popular),
    ...entries.filter((entry) => !entry.popular),
  ];
}

/** Adds or updates the ZenForge server in one client's configuration. */
export function applyClient(id: string, context: ClientContext = {}): ApplyResult {
  const definition = DEFINITIONS.find((item) => item.id === id);
  if (!definition) {
    return { status: "failed", label: id, message: "unknown client" };
  }

  const resolved = resolveContext(context);
  const paths = definition.configPaths(resolved);
  const path = paths.find((candidate) => existsSync(candidate)) ?? paths[0];
  const existed = existsSync(path);

  try {
    const existing = existed
      ? readFileTextBounded(path, MAX_CLIENT_CONFIG_BYTES)
      : undefined;
    let next: string;
    if (definition.text) {
      next = definition.text(existing, resolved);
    } else if (definition.toml) {
      const spec = definition.toml;
      next = mergeTomlServer(
        existing ?? "",
        `${spec.section}.${SERVER_ENTRY_NAME}`,
        spec.values(resolved)
      );
    } else if (definition.json) {
      const spec = definition.json;
      next = mergeJsonServerPath(existing, spec.path, spec.entry(resolved));
    } else {
      throw new Error("no merger configured for this client");
    }
    atomicWritePrivate(path, next);
    return {
      status: "ok",
      label: definition.label,
      message: `${existed ? "Updated" : "Created"} ${path}`,
    };
  } catch (error) {
    return {
      status: "failed",
      label: definition.label,
      message: `${path}: ${errorMessage(error)}`,
    };
  }
}

/* ------------------------------------------------------------------ *
 * JSON / JSONC merge
 * ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nestedValue(keys: string[], entry: Record<string, unknown>): Record<string, unknown> {
  return keys.reduceRight<Record<string, unknown>>(
    (value, key) => ({ [key]: value }),
    { [SERVER_ENTRY_NAME]: entry }
  );
}

function placeJsonServer(
  root: Record<string, unknown>,
  path: string[],
  entry: Record<string, unknown>
): void {
  let node = root;
  for (const key of path) {
    const current = node[key];
    if (current === undefined) {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
      continue;
    }
    if (!isPlainObject(current)) {
      throw new Error(`"${key}" is not a JSON object`);
    }
    node = current;
  }
  node[SERVER_ENTRY_NAME] = entry;
}

/** Merge into a top-level server map. */
export function mergeJsonServer(
  existing: string | undefined,
  key: string,
  entry: Record<string, unknown>
): string {
  return mergeJsonServerPath(existing, [key], entry);
}

/**
 * Merge into a nested server map. Strict JSON is reserialized; JSONC with
 * comments or trailing commas is spliced in place so the document is intact.
 */
export function mergeJsonServerPath(
  existing: string | undefined,
  path: string[],
  entry: Record<string, unknown>
): string {
  let text = existing ?? "";
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) {
    return `${JSON.stringify(nestedValue(path, entry), null, 2)}\n`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (strictError) {
    try {
      return mergeJsonc(text, path, entry);
    } catch {
      throw new Error(
        `existing file is not valid JSON or JSONC (${errorMessage(strictError)})`
      );
    }
  }

  if (!isPlainObject(parsed)) {
    throw new Error("existing file is not a JSON object");
  }
  placeJsonServer(parsed, path, entry);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

interface JsoncToken {
  kind: "{" | "}" | "[" | "]" | ":" | "," | "str" | "val";
  start: number;
  end: number;
  raw: string;
}

interface JsoncMember {
  key: string;
  keyStart: number;
  value: JsoncNode;
}

interface JsoncObject {
  kind: "object";
  start: number;
  end: number;
  members: JsoncMember[];
  trailingComma: boolean;
}

interface JsoncOther {
  kind: "array" | "scalar";
  start: number;
  end: number;
}

type JsoncNode = JsoncObject | JsoncOther;

/** Tokenize JSONC, discarding whitespace, // and /* *\/ comments. */
function tokenizeJsonc(text: string): JsoncToken[] {
  const tokens: JsoncToken[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(index + 2, text.length);
      continue;
    }
    if (char === '"') {
      const start = index;
      index += 1;
      let closed = false;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === '"') {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw new Error("unterminated string");
      tokens.push({ kind: "str", start, end: index, raw: text.slice(start, index) });
      continue;
    }
    if ("{}[]:,".includes(char)) {
      tokens.push({
        kind: char as JsoncToken["kind"],
        start: index,
        end: index + 1,
        raw: char,
      });
      index += 1;
      continue;
    }
    const start = index;
    while (index < text.length) {
      const current = text[index];
      if (/[\s,{}\[\]:]/.test(current)) break;
      if (current === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) break;
      index += 1;
    }
    if (index === start) throw new Error(`unexpected character ${char}`);
    tokens.push({ kind: "val", start, end: index, raw: text.slice(start, index) });
  }
  return tokens;
}

function parseJsoncValue(tokens: JsoncToken[], cursor: { index: number }): JsoncNode {
  const token = tokens[cursor.index];
  if (!token) throw new Error("unexpected end of JSONC input");

  if (token.kind === "{") {
    cursor.index += 1;
    const members: JsoncMember[] = [];
    let trailingComma = false;
    while (true) {
      const next = tokens[cursor.index];
      if (!next) throw new Error("unterminated object");
      if (next.kind === "}") {
        cursor.index += 1;
        return { kind: "object", start: token.start, end: next.end, members, trailingComma };
      }
      if (next.kind !== "str") throw new Error("object keys must be strings");
      let key: string;
      try {
        key = JSON.parse(next.raw) as string;
      } catch {
        throw new Error("invalid object key");
      }
      const keyStart = next.start;
      cursor.index += 1;
      if (tokens[cursor.index]?.kind !== ":") throw new Error("expected ':' after object key");
      cursor.index += 1;
      const value = parseJsoncValue(tokens, cursor);
      members.push({ key, keyStart, value });

      const separator = tokens[cursor.index];
      if (separator?.kind === ",") {
        trailingComma = true;
        cursor.index += 1;
        if (tokens[cursor.index]?.kind === "}") continue;
        trailingComma = false;
        continue;
      }
      if (separator?.kind === "}") {
        cursor.index += 1;
        return {
          kind: "object",
          start: token.start,
          end: separator.end,
          members,
          trailingComma: false,
        };
      }
      throw new Error("expected ',' or '}' in object");
    }
  }

  if (token.kind === "[") {
    cursor.index += 1;
    let depth = 1;
    while (cursor.index < tokens.length && depth > 0) {
      const current = tokens[cursor.index];
      cursor.index += 1;
      if (current.kind === "[") depth += 1;
      else if (current.kind === "]") depth -= 1;
    }
    if (depth !== 0) throw new Error("unterminated array");
    return { kind: "array", start: token.start, end: tokens[cursor.index - 1].end };
  }

  if (token.kind === "str" || token.kind === "val") {
    cursor.index += 1;
    return { kind: "scalar", start: token.start, end: token.end };
  }

  throw new Error(`unexpected token '${token.kind}'`);
}

function fallbackIndent(text: string, object: JsoncObject): string {
  const lineStart = text.lastIndexOf("\n", object.start - 1) + 1;
  return " ".repeat(Math.max(0, object.start - lineStart + 2));
}

function indentAt(text: string, position: number, fallback: string): string {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1;
  const leading = text.slice(lineStart, position);
  return /^[ \t]*$/.test(leading) ? leading : fallback;
}

function indentLines(value: string, indent: string): string {
  return value.replace(/\n/g, `\n${indent}`);
}

function insertJsoncMember(
  text: string,
  object: JsoncObject,
  key: string,
  value: Record<string, unknown>
): string {
  // `end` is exclusive; the closing brace itself sits at `end - 1`.
  const close = object.end - 1;
  const lineStart = text.lastIndexOf("\n", close - 1) + 1;
  const beforeClose = text.slice(lineStart, close);
  const last = object.members[object.members.length - 1];

  if (lineStart > object.start && beforeClose.trim() === "") {
    let source = text;
    let insertAt = lineStart;
    if (last && !object.trailingComma) {
      source = `${source.slice(0, last.value.end)},${source.slice(last.value.end)}`;
      insertAt += 1;
    }
    const indent = last
      ? indentAt(source, last.keyStart, fallbackIndent(source, object))
      : `${fallbackIndent(source, object)}  `;
    const member =
      `${indent}${JSON.stringify(key)}: ` +
      `${indentLines(JSON.stringify(value, null, 2), indent)}\n`;
    return source.slice(0, insertAt) + member + source.slice(insertAt);
  }

  const inline = `${last ? ", " : ""}${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  return text.slice(0, close) + inline + text.slice(close);
}

function upsertJsoncEntry(
  text: string,
  serverMap: JsoncObject,
  entry: Record<string, unknown>
): string {
  const current = serverMap.members.find((member) => member.key === SERVER_ENTRY_NAME);
  if (!current) {
    return insertJsoncMember(text, serverMap, SERVER_ENTRY_NAME, entry);
  }
  const multiline = text.slice(current.value.start, current.value.end).includes("\n");
  const indent = indentAt(text, current.keyStart, fallbackIndent(text, serverMap));
  const replacement = multiline
    ? indentLines(JSON.stringify(entry, null, 2), indent)
    : JSON.stringify(entry);
  return (
    text.slice(0, current.value.start) + replacement + text.slice(current.value.end)
  );
}

function mergeJsonc(
  text: string,
  path: string[],
  entry: Record<string, unknown>
): string {
  const tokens = tokenizeJsonc(text);
  const cursor = { index: 0 };
  const root = parseJsoncValue(tokens, cursor);
  if (root.kind !== "object") throw new Error("top-level value is not a JSON object");

  let map = root;
  for (let depth = 0; depth < path.length; depth += 1) {
    const key = path[depth];
    const member = map.members.find((item) => item.key === key);
    if (!member) {
      return insertJsoncMember(
        text,
        map,
        key,
        nestedValue(path.slice(depth + 1), entry)
      );
    }
    if (member.value.kind !== "object") {
      throw new Error(`"${key}" is not a JSON object`);
    }
    if (depth === path.length - 1) {
      return upsertJsoncEntry(text, member.value, entry);
    }
    map = member.value;
  }
  throw new Error("empty server path");
}

/* ------------------------------------------------------------------ *
 * TOML merge
 * ------------------------------------------------------------------ */

export function mergeTomlServer(
  existing: string,
  table: string,
  values: Record<string, string | string[]>
): string {
  const lines = existing ? existing.replace(/\r\n/g, "\n").split("\n") : [];
  const escaped = escapeRegExp(table);
  const headerPattern = new RegExp(
    `^\\s*\\[\\s*(?:"${escaped}"|'${escaped}'|${escaped})\\s*\\]\\s*(?:#.*)?$`
  );
  const block = [
    `[${table}]`,
    ...Object.entries(values).map(([name, value]) => `${name} = ${tomlValue(value)}`),
  ];

  const start = lines.findIndex((line) => headerPattern.test(line));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
    lines.splice(start, end - start, ...block);
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(...block);
  }
  return `${lines.join("\n")}\n`;
}

function tomlValue(value: string | string[]): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => JSON.stringify(entry)).join(", ")}]`;
  }
  return JSON.stringify(value);
}

/* ------------------------------------------------------------------ *
 * YAML / shell text merges
 * ------------------------------------------------------------------ */

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function yamlFlowArray(values: string[]): string {
  return `[${values.map(yamlScalar).join(", ")}]`;
}

function splitTextLines(existing: string | undefined): string[] {
  const lines = (existing ?? "").replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface YamlSection {
  start: number;
  end: number;
  indent: string;
}

function findYamlSection(lines: string[], section: string): YamlSection | null {
  const header = new RegExp(`^${escapeRegExp(section)}:\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return null;

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (
      line.trim() === "" ||
      /^[ \t]/.test(line) ||
      line.trimStart().startsWith("#")
    ) {
      end += 1;
    } else {
      break;
    }
  }
  const child = lines
    .slice(start + 1, end)
    .find((line) => /^[ \t]+\S/.test(line));
  return { start, end, indent: child?.match(/^[ \t]+/)?.[0] ?? "  " };
}

function mergeYamlMapping(
  existing: string | undefined,
  section: string,
  key: string,
  block: string[]
): string {
  const lines = splitTextLines(existing);
  const found = findYamlSection(lines, section);
  if (!found) {
    if (lines.length > 0) lines.push("");
    lines.push(`${section}:`, `${key}:`, ...block.map((line) => `  ${line}`));
    return `${lines.join("\n")}\n`;
  }

  const indent = found.indent;
  const keyPattern = new RegExp(
    `^${escapeRegExp(indent)}${escapeRegExp(key)}:\\s*(?:#.*)?$`
  );
  const index = lines.findIndex(
    (line, position) =>
      position > found.start && position < found.end && keyPattern.test(line)
  );
  const replacement = [`${indent}${key}:`, ...block.map((line) => `${indent}  ${line}`)];
  if (index >= 0) {
    let end = index + 1;
    while (end < found.end) {
      const line = lines[end];
      if (line.trim() === "") {
        end += 1;
        continue;
      }
      if ((line.match(/^[ \t]*/)?.[0].length ?? 0) <= indent.length) break;
      end += 1;
    }
    lines.splice(index, end - index, ...replacement);
  } else {
    lines.splice(found.end, 0, ...replacement);
  }
  return `${lines.join("\n")}\n`;
}

function mergeYamlList(
  existing: string | undefined,
  section: string,
  name: string,
  block: string[]
): string {
  const lines = splitTextLines(existing);
  const found = findYamlSection(lines, section);
  const item = [`- name: ${name}`, ...block.slice(1)];
  if (!found) {
    if (lines.length > 0) lines.push("");
    lines.push(`${section}:`, ...item.map((line) => `  ${line}`));
    return `${lines.join("\n")}\n`;
  }

  const itemIndent =
    lines
      .slice(found.start + 1, found.end)
      .find((line) => /^[ \t]*-[ \t]+\S/.test(line))
      ?.match(/^[ \t]*/)?.[0] ?? "  ";
  const namePattern = new RegExp(
    `^${escapeRegExp(itemIndent)}-[ \\t]+name:\\s*['"]?${escapeRegExp(
      name
    )}['"]?\\s*(?:#.*)?$`
  );
  const index = lines.findIndex(
    (line, position) =>
      position > found.start && position < found.end && namePattern.test(line)
  );
  const replacement = [
    `${itemIndent}${item[0]}`,
    ...item.slice(1).map((line) => `${itemIndent}  ${line}`),
  ];
  if (index >= 0) {
    let end = index + 1;
    while (end < found.end) {
      const line = lines[end];
      if (line.trim() === "") {
        end += 1;
        continue;
      }
      if (new RegExp(`^${escapeRegExp(itemIndent)}-[ \\t]`).test(line)) break;
      if ((line.match(/^[ \t]*/)?.[0].length ?? 0) < itemIndent.length) break;
      end += 1;
    }
    lines.splice(index, end - index, ...replacement);
  } else {
    lines.splice(found.end, 0, ...replacement);
  }
  return `${lines.join("\n")}\n`;
}

function mergeDshPatch(existing: string | undefined, ctx: ResolvedContext): string {
  const lines = splitTextLines(existing);
  const item = [
    "- id: zenforge",
    "  name: '@deepseek-ai/dsh-mcp-client'",
    "  config:",
    "    serverName: zenforge",
    "    transport: stdio",
    `    command: ${yamlScalar(ctx.command)}`,
    `    args: ${yamlFlowArray(SERVER_ARGS)}`,
  ];
  const pattern = /^([ \t]*)-[ \t]*id:\s*['"]?zenforge['"]?\s*$/;
  const index = lines.findIndex((line) => pattern.test(line));
  if (index < 0) {
    if (lines.length > 0) lines.push("");
    lines.push("- insert:", ...item.map((line) => `    ${line}`));
    return `${lines.join("\n")}\n`;
  }
  const indent = lines[index].match(pattern)?.[1] ?? "  ";
  let start = index;
  while (start > 0) {
    const previous = lines[start - 1];
    const previousIndent = previous.match(/^[ \t]*/)?.[0].length ?? 0;
    if (previousIndent < indent.length) break;
    if (previousIndent === indent.length && /^[ \t]*-[ \t]/.test(previous)) break;
    start -= 1;
  }
  let end = index + 1;
  while (end < lines.length) {
    const line = lines[end];
    const lineIndent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (line.trim() !== "" && lineIndent < indent.length) break;
    if (lineIndent === indent.length && /^[ \t]*-[ \t]/.test(line)) break;
    end += 1;
  }
  lines.splice(start, end - start, ...item.map((line) => `${indent}${line}`));
  return `${lines.join("\n")}\n`;
}

function mergeCrushrc(existing: string | undefined, ctx: ResolvedContext): string {
  const lines = splitTextLines(existing);
  const command =
    `mcp add zenforge --command ${shellQuote(ctx.command)}` +
    ` --args ${SERVER_ARGS.map(shellQuote).join(" ")}`;
  const index = lines.findIndex((line) => /^\s*mcp\s+add\s+zenforge(?:\s|$)/.test(line));
  if (index >= 0) {
    lines[index] = command;
  } else {
    if (lines.length > 0) lines.push("");
    lines.push(command);
  }
  return `${lines.join("\n")}\n`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ *
 * "Other client" runbook
 * ------------------------------------------------------------------ */

/** A paste-ready prompt for clients the catalog does not know. */
export function agentSetupPrompt(command = DEFAULT_COMMAND): string {
  const resolved = resolveContext({ command });
  const locations = DEFINITIONS.map((definition) => {
    const path = placeholderPath(definition.configPaths(resolved)[0], resolved);
    const jsonPath = definition.json?.path;
    const shape =
      definition.format === "toml"
        ? `a TOML table \`[${definition.toml?.section}.${SERVER_ENTRY_NAME}]\``
        : definition.format === "text"
          ? "a YAML or shell configuration; keep existing entries"
          : jsonPath?.length === 1 && jsonPath[0] === "servers"
            ? 'top-level `servers`, entry needs `"type": "stdio"`'
            : jsonPath?.[0] === "context_servers"
              ? "top-level `context_servers`"
              : jsonPath && jsonPath.length > 1
                ? `nested \`${jsonPath.join(".")}\` object`
                : "top-level `mcpServers`";
    return `- ${definition.label}: \`${path}\`, ${shape}.`;
  }).join("\n");

  return [
    "# Set up ZenForge in this agent",
    "",
    "Add a local stdio MCP server named `zenforge` to the client you are running in.",
    "Do the work yourself: run commands and edit configuration files. Do not ask",
    "me to run anything. Only ask me when a browser approval card appears or when",
    "no configuration file can be located.",
    "",
    "## Server definition",
    "",
    `- Name: ${SERVER_ENTRY_NAME}`,
    "- Transport: stdio, local child process (no URL, no OAuth, no API key)",
    `- Command: ${command}`,
    `- Arguments: ${JSON.stringify(SERVER_ARGS)}`,
    "- Environment: none required",
    "",
    "Resolve the command with `command -v zenforge` (macOS/Linux) or",
    "`where zenforge` (Windows). If it is not on PATH, use the absolute path to",
    "the built CLI and keep the arguments unchanged.",
    "",
    "## 1. Prefer the client's own add command",
    "",
    "If the client can register a stdio server, use it, for example:",
    "",
    `    zenforge onboard --clients <id>`,
    `    # or, generically:`,
    `    mcp add ${SERVER_ENTRY_NAME} -- "${command}" serve`,
    "",
    "Skip to the validation step if an add command succeeds.",
    "",
    "## 2. Locate the configuration file",
    "",
    "Use the first path that exists for this client:",
    "",
    locations,
    "",
    "For an unknown client, look for a top-level `mcpServers`, `servers` or",
    "`context_servers` object, or follow the client's official MCP documentation.",
    "",
    "## 3. Merge the entry",
    "",
    "- Preserve every existing server, key, comment and trailing comma.",
    `- Edit only the \`${SERVER_ENTRY_NAME}\` member; never replace the entire file.`,
    "- If the entry already exists, update it in place instead of duplicating it.",
    "- For JSONC (VS Code, Zed, kilo-code), splice the member so comments survive.",
    "- Do not reorder or reformat unrelated settings.",
    "",
    "Standard JSON shape:",
    "",
    "    {",
    '      "mcpServers": {',
    `        "${SERVER_ENTRY_NAME}": {`,
    '          "command": "' + command + '",',
    '          "args": ["serve"]',
    "        }",
    "      }",
    "    }",
    "",
    "VS Code shape:",
    "",
    "    {",
    '      "servers": {',
    `        "${SERVER_ENTRY_NAME}": {`,
    '          "type": "stdio",',
    '          "command": "' + command + '",',
    '          "args": ["serve"]',
    "        }",
    "      }",
    "    }",
    "",
    "Codex CLI TOML shape:",
    "",
    `    [mcp_servers.${SERVER_ENTRY_NAME}]`,
    `    command = "${command}"`,
    '    args = ["serve"]',
    "",
    "## 4. Validation checklist",
    "",
    `- Parse the file in its own format; confirm exactly one \`${SERVER_ENTRY_NAME}\` entry.`,
    `- Confirm \`command\` is \`${command}\` and \`args\` is \`["serve"]\`.`,
    "- Confirm no other server was removed, renamed or modified.",
    `- If the client has a list command (for example \`claude mcp list\`), run it and`,
    `  confirm \`${SERVER_ENTRY_NAME}\` appears. Do not launch the server by hand.`,
    "",
    "## 5. Reload",
    "",
    "Restart the client (or run its reload command) and tell me which you did.",
    "",
    "## 6. Completion report",
    "",
    "Reply with the client name, the file or command you changed, the validation",
    "result, and the reload step. End with:",
    "",
    `    ZenForge setup: server ${SERVER_ENTRY_NAME} (stdio) registered;`,
    "    config validated; restart the client to load the server.",
    "",
    "## Constraints",
    "",
    "- ZenForge runs locally over stdio. Do not add a remote URL, token or OAuth flow.",
    "- Do not install or patch anything inside Zen; the bridge is injected at runtime.",
    "- Do not launch a browser merely to test the server. On the first browser tool",
    '  call, Zen shows an approval card. Ask me to click "Allow this session".',
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * Context resolution
 * ------------------------------------------------------------------ */

function resolveContext(context: ClientContext): ResolvedContext {
  const platform = context.platform ?? process.platform;
  const home = context.home ?? homedir();
  const env = context.env ?? process.env;
  const command = context.command?.trim() || DEFAULT_COMMAND;
  const configBase =
    platform === "win32"
      ? env.APPDATA ?? join(home, "AppData", "Roaming")
      : platform === "darwin"
        ? join(home, "Library", "Application Support")
        : env.XDG_CONFIG_HOME ?? join(home, ".config");
  const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
  return { command, home, platform, env, configBase, xdg };
}

/** Replace machine-specific roots so prompts never embed a real user name. */
function placeholderPath(path: string, ctx: ResolvedContext): string {
  const windows = ctx.platform === "win32";
  const roots: Array<[string, string]> = [];
  if (ctx.env.CODEX_HOME) {
    roots.push([ctx.env.CODEX_HOME, windows ? "%CODEX_HOME%" : "$CODEX_HOME"]);
  }
  if (windows) roots.push([ctx.configBase, "%APPDATA%"]);
  else if (ctx.env.XDG_CONFIG_HOME) roots.push([ctx.configBase, "$XDG_CONFIG_HOME"]);
  roots.push([ctx.home, windows ? "%USERPROFILE%" : "~"]);

  const normalize = (value: string): string => {
    const slashed = value.replace(/\\/g, "/");
    return windows ? slashed.toLowerCase() : slashed;
  };
  const target = normalize(path);

  for (const [root, label] of roots) {
    const prefix = normalize(root);
    if (target === prefix) return label;
    if (target.startsWith(`${prefix}/`)) {
      const rest = path.slice(root.length);
      const separator = windows ? "\\" : "/";
      return label + rest.replace(windows ? /\//g : /\\/g, separator);
    }
  }
  return path;
}
