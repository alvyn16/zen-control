import test from "node:test";
import assert from "node:assert/strict";
import { EventLog } from "../../src/bridge/event-log.js";
import { buildPageDelta, type PageControlSignature } from "../../src/shared/delta.js";
import { buildEvidenceHighlightScript, createEvidenceMarker } from "../../src/shared/evidence-script.js";
import { buildReadScript } from "../../src/shared/read-script.js";
import { normalizeTargetInput, TargetInputError } from "../../src/shared/target.js";
import { readTabPage } from "../../src/zen/page.js";
import { loadConfig } from "../../src/config.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function signature(role: string, name: string): PageControlSignature {
  return {
    key: "same-key", role, name, type: null,
    state: { visible: true, disabled: false },
  };
}

test("delta reports role and name changes even when the key is unchanged", () => {
  const before = { url: "u", title: "t", readyState: "complete", textLength: 10, textHash: 1, elementCount: 2, valueHash: 0, controls: [signature("button", "Go")], headings: [], alerts: [] };
  const after = { ...before, controls: [signature("link", "Go")] };
  const changed = buildPageDelta(before, after, false);
  assert.ok(changed.delta.changedControls.some((c) => c.changes.includes("role")));

  const afterName = { ...before, controls: [signature("button", "Cancel")] };
  assert.ok(buildPageDelta(before, afterName, false).delta.changedControls.some(
    (c) => c.changes.includes("name")
  ));
});

test("event log distinguishes consecutive dialogs by label", () => {
  const log = new EventLog();
  const first = log.push({ kind: "dialog", phase: "shown", title: "Dialog shown", detail: "alert" });
  const second = log.push({ kind: "dialog", phase: "shown", title: "Dialog shown", detail: "confirm" });
  assert.ok(first && second, "both distinct dialogs must be stored");
  assert.equal(log.read(0).events.length, 2);
});

test("event log returns null for deduplicated browser observations", () => {
  const log = new EventLog();
  assert.ok(log.push({ kind: "tab", phase: "opened", title: "open", tabId: "t1" }));
  assert.equal(log.push({ kind: "tab", phase: "opened", title: "open", tabId: "t1" }), null);
  assert.equal(log.read(0).events.length, 1);
});

test("highlight script clears earlier markers before painting", () => {
  const marker = createEvidenceMarker();
  const previous = createEvidenceMarker();
  const script = buildEvidenceHighlightScript({
    start: 0, end: 3, expectedText: "abc", ttlMs: 1000, scroll: true,
    marker, clearMarkers: [previous],
  });
  assert.match(script, new RegExp(`const clearMarkers = \\[[^\\]]*${previous}[^\\]]*\\]`));
  assert.match(script, /dropMarkers\(clearMarkers\.concat\(\[marker\]\)\)/);
});

test("semantic generator tracks cards, links and region parents", () => {
  const script = buildReadScript({ format: "semantic" });
  assert.match(script, /counts\.cards \+= 1/);
  assert.match(script, /counts\.links \+= 1/);
  assert.match(script, /parent: nearestRegion\(el\)/);
  assert.match(script, /links: counts\.links/);
});

test("target input errors carry structured details", () => {
  try {
    normalizeTargetInput({ target: { text: "x".repeat(501) } });
    assert.fail("expected an error");
  } catch (error) {
    assert.ok(error instanceof TargetInputError);
    assert.equal(error.details.field, "target.text");
    assert.equal(error.details.limit, 500);
    assert.equal(error.details.length, 501);
  }
});

test("single-page reads route through hub.readTab so the hub injects its allowlist", async () => {
  let called = false;
  const hub = {
    readTab: async (params: Record<string, unknown>) => {
      called = true;
      assert.equal(params.tabId, "tab-1");
      assert.equal(Object.hasOwn(params, "allowedDomains"), false);
      return { title: "t", url: "https://example.com/", frames: [] };
    },
  };
  const page = await readTabPage(hub as never, "tab-1", { format: "text" });
  assert.equal(called, true);
  assert.equal(page.url, "https://example.com/");
});

test("malformed allowedDomains in the config file fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "zf-cfg-"));
  const path = join(dir, "config.json");
  const previous = process.env.ZENFORGE_CONFIG;
  try {
    writeFileSync(path, JSON.stringify({ allowedDomains: "example.com" }));
    process.env.ZENFORGE_CONFIG = path;
    assert.throws(() => loadConfig(), /allowedDomains/);
    writeFileSync(path, JSON.stringify({ allowedDomains: ["example.com", 7] }));
    assert.throws(() => loadConfig(), /allowedDomains/);
  } finally {
    if (previous === undefined) delete process.env.ZENFORGE_CONFIG;
    else process.env.ZENFORGE_CONFIG = previous;
  }
});
