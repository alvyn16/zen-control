/**
 * Gated live smoke test: drives the built CLI against a real, headless Zen
 * Browser. It is always defined so the test runner stays stable, but does
 * nothing unless ZEN_CONTROL_E2E=1:
 *
 *   npm run build && ZEN_CONTROL_E2E=1 npm run test:live
 *
 * Everything the browser touches is throwaway: a fresh profile and data
 * directory under os.tmpdir(), plus a config file that is written there. No
 * user config, profile or audit log is read or modified.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const QUOTE = "The lighthouse keeper checked the lamp at dawn.";
const CLICKED_TEXT = "The lamp is lit.";
const BUTTON_SELECTOR = "#zen-live-smoke-button";
const EXPECTED_TOOL_COUNT = 56;
const EXPECTED_RESOURCE_COUNT = 6;
const TEST_TIMEOUT_MS = 15 * 60 * 1000;
const TOOL_TIMEOUT_MS = 120_000;

/** Deterministic fixture: one unique quote and one idempotent button. */
const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Zen Control live smoke</title></head>
<body><main>
<h1>Live smoke fixture</h1>
<p>${QUOTE}</p>
<button id="zen-live-smoke-button" type="button" onclick="this.textContent='${CLICKED_TEXT}'">Light the lamp</button>
</main></body></html>`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value;
}

function asArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function asString(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} must be a string`);
  return value as string;
}

/** Tools return their value as structuredContent; fall back to the text block. */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const raw = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: TOOL_TIMEOUT_MS }
  );
  if (!("content" in raw) || !Array.isArray(raw.content)) {
    throw new Error(`${name} returned no tool content.`);
  }
  // The SDK's result type also allows a task variant with an opaque payload;
  // an ordinary tool call always has the shape below.
  const result = raw as {
    content: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  const text =
    result.content.find((part) => part.type === "text")?.text ?? "";
  if (result.isError === true) {
    throw new Error(`${name} failed: ${text || JSON.stringify(result.structuredContent ?? {})}`);
  }
  if (isRecord(result.structuredContent)) return result.structuredContent;
  return asRecord(JSON.parse(text), `${name} result`);
}

test(
  "live MCP smoke against a real headless Zen Browser",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    if (process.env.ZEN_CONTROL_E2E !== "1") {
      t.skip("Set ZEN_CONTROL_E2E=1 to run the live smoke test.");
      return;
    }

    let client: Client | null = null;
    let httpServer: Server | null = null;
    let tempRoot: string | null = null;

    t.after(async () => {
      try {
        await client?.close();
      } catch {
        // Best effort: the transport also kills the CLI it spawned.
      }
      const server = httpServer;
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      const root = tempRoot;
      if (root) {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    });

    const root = mkdtempSync(join(tmpdir(), "zen-control-live-"));
    tempRoot = root;
    const profilePath = join(root, "profile");
    const dataDir = join(root, "data");
    mkdirSync(profilePath, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    // Zen currently always listens on 2828: -marionette takes no port argument,
    // so the configured port only tells the server where to connect.
    writeFileSync(
      join(root, "config.json"),
      `${JSON.stringify(
        {
          zenPath: process.env.ZEN_CONTROL_ZEN_PATH ?? "/usr/bin/zen-browser",
          profilePath,
          dataDir,
          useDefaultProfile: false,
          requireConsent: false,
          consentTimeoutSeconds: 5,
          autoLaunch: true,
          autoAttachWindows: true,
          launchTimeoutMs: 45_000,
          askTimeoutSeconds: 30,
          marionettePort: 2828,
          readOnly: false,
          allowedDomains: [],
          auditLog: false,
          watchMinIntervalSeconds: 5,
          launchArgs: ["--headless"],
          toolSurface: "full",
        },
        null,
        2
      )}\n`
    );

    // Strip inherited ZEN_CONTROL_* overrides so only this temp config decides
    // policy, while keeping PATH/HOME so the CLI can find node and Zen.
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("ZEN_CONTROL_")) childEnv[key] = value;
    }
    childEnv.ZEN_CONTROL_CONFIG = join(root, "config.json");
    childEnv.ZEN_CONTROL_NO_UPDATE_CHECK = "1";
    childEnv.MOZ_HEADLESS = "1";

    const fixture = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(FIXTURE_HTML);
    });
    httpServer = fixture;
    await new Promise<void>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", resolve);
    });
    const address = fixture.address();
    if (!address || typeof address === "string") {
      throw new Error("The fixture server has no TCP address.");
    }
    const pageUrl = `http://127.0.0.1:${address.port}/fixture`;

    const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
    assert.ok(existsSync(cliPath), "Run `npm run build` before the live smoke test.");

    const sdkClient = new Client({ name: "zen-control-live-smoke", version: "0.0.0" });
    client = sdkClient;
    await sdkClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cliPath, "serve"],
        cwd: process.cwd(),
        env: childEnv,
        stderr: "inherit",
      })
    );

    const tools = await sdkClient.listTools();
    assert.equal(
      tools.tools.length,
      EXPECTED_TOOL_COUNT,
      `Expected ${EXPECTED_TOOL_COUNT} tools on the full surface.`
    );
    const resources = await sdkClient.listResources();
    assert.equal(
      resources.resources.length,
      EXPECTED_RESOURCE_COUNT,
      `Expected ${EXPECTED_RESOURCE_COUNT} resources.`
    );

    const status = await callTool(sdkClient, "zen_status");
    assert.ok(asString(status.appName, "zen_status.appName").length > 0);

    const opened = await callTool(sdkClient, "zen_tabs_open", {
      urls: [pageUrl],
      background: true,
      switchTo: false,
    });
    const openedTabs = asArray(opened.tabs, "zen_tabs_open.tabs");
    assert.equal(openedTabs.length, 1, "The fixture should open in exactly one tab.");
    const tabId = asString(
      asRecord(openedTabs[0], "opened tab").id,
      "opened tab id"
    );

    const listed = await callTool(sdkClient, "zen_tabs_list");
    assert.ok(
      asArray(listed.tabs, "zen_tabs_list.tabs").some(
        (entry) => isRecord(entry) && entry.id === tabId
      ),
      "The opened tab must be listed."
    );

    const textRead = await callTool(sdkClient, "zen_read_page", {
      tabId,
      format: "text",
    });
    assert.ok(
      asString(textRead.text, "zen_read_page text").includes(QUOTE),
      "The text read must contain the fixture quote."
    );
    const semanticRead = await callTool(sdkClient, "zen_read_page", {
      tabId,
      format: "semantic",
    });
    const semantic = asRecord(semanticRead.semantic, "zen_read_page semantic");
    assert.ok(
      asString(semantic.classification, "semantic classification").length > 0
    );

    const found = await callTool(sdkClient, "zen_find_text", {
      tabId,
      query: QUOTE,
    });
    assert.equal(found.ok, true, JSON.stringify(found.error));
    assert.ok(Number(found.totalMatches ?? 0) >= 1, "The quote must be found.");

    const evidence = await callTool(sdkClient, "zen_show_evidence", {
      url: pageUrl,
      quote: QUOTE,
      claim: "The lamp was checked at dawn.",
    });
    assert.equal(evidence.ok, true, JSON.stringify(evidence.error));
    assert.equal(evidence.verified, true, JSON.stringify(evidence));

    const clicked = await callTool(sdkClient, "zen_click", {
      tabId,
      target: { selector: BUTTON_SELECTOR },
    });
    assert.equal(clicked.error, undefined, JSON.stringify(clicked.error));
    assert.equal(clicked.clicked, true, JSON.stringify(clicked));

    const waited = await callTool(sdkClient, "zen_wait_for", {
      tabId,
      text: CLICKED_TEXT,
      timeout_ms: 10_000,
    });
    assert.equal(waited.matched, true, JSON.stringify(waited));

    const config = await callTool(sdkClient, "zen_config");
    assert.equal(config.toolSurface, "full");
    assert.equal(config.requireConsent, false);
    assert.equal(config.auditLog, false);

    const doctor = await callTool(sdkClient, "zen_doctor");
    assert.equal(doctor.ok, true, JSON.stringify(doctor.checks));
    assert.ok(asArray(doctor.checks, "zen_doctor checks").length > 0);

    const closed = await callTool(sdkClient, "zen_tabs_close", { tabIds: [tabId] });
    assert.ok(Number(closed.closed ?? 0) >= 1, JSON.stringify(closed));
  }
);
