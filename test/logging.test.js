import test from "node:test";
import assert from "node:assert/strict";
import { logError } from "../src/logging.js";

test("writes structured error diagnostics to stderr and redacts credentials", () => {
  const originalWrite = process.stderr.write;
  const lines = [];
  process.stderr.write = (line) => {
    lines.push(line);
    return true;
  };
  try {
    const error = Object.assign(
      new Error(
        "Request failed with Authorization: Bearer abc123 at https://example.test/pay?checkoutToken=secret123",
      ),
      { code: "APPROVAL_UNAVAILABLE", status: 503 },
    );
    logError("tool_failed", error, {
      tool: "purchase_checkout",
      intentId: "intent-123",
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.level, "error");
  assert.equal(record.component, "wrhse-buyer");
  assert.equal(record.event, "tool_failed");
  assert.equal(record.tool, "purchase_checkout");
  assert.equal(record.intentId, "intent-123");
  assert.equal(record.error.code, "APPROVAL_UNAVAILABLE");
  assert.equal(record.error.status, 503);
  assert.doesNotMatch(record.error.message, /abc123/);
  assert.doesNotMatch(record.error.message, /secret123/);
});
