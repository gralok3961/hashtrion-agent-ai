import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("actual shopping UI renders only confirmed order links and preserves safe pending/unknown controls", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", resolve("tests/fixtures/shopping-context.mjs")], {
    cwd: process.cwd(), timeout: 15_000, encoding: "utf8", stdio: "pipe", env: { NODE_ENV: "test" },
  });
  assert.equal(output.trim(), "Order, pending and uncertain shopping UI verified.");
});
