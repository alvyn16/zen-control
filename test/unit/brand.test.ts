import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BRAND,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RESOURCE_ALIAS,
  SERVER_NAME,
  SERVER_VERSION,
} from "../../src/shared/brand.js";

describe("brand constants", () => {
  it("keeps a stable identity", () => {
    assert.equal(BRAND, "ZenForge");
    assert.equal(SERVER_NAME, "zen-mcp");
    assert.equal(SERVER_VERSION, "0.1.0");
  });

  it("keeps bridge protocol constants coherent", () => {
    assert.equal(BRIDGE_PROTOCOL_VERSION, 2);
    assert.match(BRIDGE_RESOURCE_ALIAS, /zenforge/i);
  });
});
