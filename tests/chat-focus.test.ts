import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

for (const scenario of [
  "reply", "other-input", "other-button", "open-modal", "already-focused",
  "agent-save", "agent-refresh", "agent-cancel", "checkout-action",
  "network-error", "history-limit", "session-ended",
]) {
  test(`chat focus restoration: ${scenario}`, () => {
    const output = execFileSync(process.execPath, [
      "--experimental-test-module-mocks", "--import", "tsx",
      resolve("tests/fixtures/chat-focus.mjs"), scenario,
    ], {
      cwd: process.cwd(), timeout: 15_000, encoding: "utf8", stdio: "pipe",
      env: { NODE_ENV: "test" },
    });
    assert.equal(output.trim(), `Chat focus verified: ${scenario}`);
  });
}
