import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type AppConfig } from "../../src/config.js";
import { agentDoctor, type AgentDoctorInput } from "../../src/mcp/diagnostics.js";

/**
 * Minimal fakes: the doctor is deliberately local, so it needs only a few
 * in-memory fields rather than a live browser, hub or on-disk stores.
 */
function makeInput(overrides: Partial<AppConfig> = {}): AgentDoctorInput {
  return {
    config: { ...DEFAULT_CONFIG, ...overrides },
    runtime: {
      sessionInfo: () => ({
        ownsBrowser: false,
        browserPid: null,
        lockedDown: false,
        consent: "none",
        paused: false,
      }),
      hub: { connectionCount: 0, bridgeScriptPath: "/definitely/missing/bridge.js" },
      marionette: { isConnected: false },
    } as unknown as AgentDoctorInput["runtime"],
    sessions: {
      list: () => [{ name: "one" }],
    } as unknown as AgentDoctorInput["sessions"],
    templates: {
      list: () => [{ name: "a" }, { name: "b" }],
    } as unknown as AgentDoctorInput["templates"],
    guard: {
      auditPath: "/tmp/zen-audit.jsonl",
      tail: () => [
        {
          at: "2026-01-01T00:00:00.000Z",
          tool: "zen_click",
          ok: false,
          executed: false,
          durationMs: 0,
          args: { text: "SUPERSECRET" },
          urls: ["https://user:TOPSECRET@example.com/p"],
        },
      ],
    } as unknown as AgentDoctorInput["guard"],
    counts: { tools: 56, resources: 3, prompts: 0 },
  };
}

test("agentDoctor reports a local, boolean, populated result", () => {
  const result = agentDoctor(makeInput());

  assert.equal(typeof result.ok, "boolean");
  assert.ok(Array.isArray(result.checks) && result.checks.length > 0);
  for (const entry of result.checks) {
    assert.equal(typeof entry.ok, "boolean");
    assert.ok(entry.name.length > 0);
    assert.ok(entry.detail.length > 0);
    if (entry.fix !== undefined) assert.equal(typeof entry.fix, "string");
  }

  assert.equal(result.surface, "research");
  assert.deepEqual(result.counts, { tools: 56, resources: 3, prompts: 0 });
  assert.equal(result.policy.readOnly, DEFAULT_CONFIG.readOnly);
  assert.equal(result.policy.auditLog, DEFAULT_CONFIG.auditLog);
  assert.equal(result.policy.requireConsent, DEFAULT_CONFIG.requireConsent);
  assert.ok(Array.isArray(result.policy.allowedDomains));
  assert.ok(result.session && typeof result.session === "object");
});

test("agentDoctor never echoes page text, credentials or audit arguments", () => {
  const text = JSON.stringify(agentDoctor(makeInput()));
  assert.doesNotMatch(text, /SUPERSECRET/);
  assert.doesNotMatch(text, /TOPSECRET/);
  assert.doesNotMatch(text, /user:TOPSECRET@example/);
});

test("agentDoctor surfaces the audit and store summaries", () => {
  const result = agentDoctor(makeInput());
  const audit = result.checks.find((entry) => entry.name === "Audit log");
  assert.ok(audit);
  assert.match(audit.detail, /1 blocked\/denied/);

  const stores = result.checks.find((entry) => entry.name === "Stores");
  assert.ok(stores);
  assert.match(stores.detail, /1 saved session/);
  assert.match(stores.detail, /2 template/);
});

test("agentDoctor flags invalid registry counts in the surface check", () => {
  const input = makeInput();
  input.counts = { tools: Number.NaN, resources: 0, prompts: 0 };
  const surface = agentDoctor(input).checks.find((entry) => entry.name === "Tool surface");
  assert.ok(surface);
  assert.equal(surface.ok, false);
  assert.ok(surface.fix);
});
