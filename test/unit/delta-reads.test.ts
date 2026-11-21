import test from "node:test";
import assert from "node:assert/strict";
import { ReadDeltaStore, diffText } from "../../src/zen/read-deltas.js";

test("diffText reports the single changed span in O(n)", () => {
  assert.deepEqual(diffText("hello world", "hello world"), {
    added: "", removed: "", truncated: false,
  });
  assert.deepEqual(diffText("hello world", "hello brave world"), {
    added: "brave ", removed: "", truncated: false,
  });
  assert.deepEqual(diffText("alpha beta gamma", "alpha gamma"), {
    added: "", removed: "beta ", truncated: false,
  });
  assert.deepEqual(diffText("abc", "xyz"), {
    added: "xyz", removed: "abc", truncated: false,
  });
});

test("diffText caps long replacements and marks truncation", () => {
  const after = "x".repeat(200);
  const result = diffText("old", after, 50);
  assert.equal(result.added.length, 50);
  assert.equal(result.truncated, true);
});

test("delta store keeps bounded, expiring, opaque tokens", () => {
  const store = new ReadDeltaStore();
  const token = store.create("tab-1", "body text", "doc-1", "https://example.com/", {
    textHash: 123, textLength: 9,
  });
  assert.match(token, /^dr-[a-f0-9]{8}$/);
  const snapshot = store.get(token);
  assert.equal(snapshot?.tabId, "tab-1");
  assert.equal(snapshot?.textHash, 123);
  assert.equal(snapshot?.textLength, 9);
  assert.equal(store.get("bogus"), null);

  for (let i = 0; i < 150; i += 1) store.create(`t-${i}`, "x", "d", "u");
  assert.ok(store.size <= 100, "store must stay bounded");
  store.clear();
  assert.equal(store.size, 0);
});
