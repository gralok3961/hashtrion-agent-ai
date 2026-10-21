import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

for (const [fixture, message] of [
  ["agent-platform-connection", "Agent Platform Connection route verified."],
  ["agent-id-modal", "Agent ID modal Save behavior verified."],
]) {
  test(message, () => {
    const output = execFileSync(process.execPath, [
      "--experimental-test-module-mocks", "--import", "tsx", resolve(`tests/fixtures/${fixture}.mjs`),
    ], {
      cwd: process.cwd(), timeout: 15_000, encoding: "utf8", stdio: "pipe",
      env: {
        NODE_ENV: "test",
        AGENT_AI_ACCESS_PASSWORD: "synthetic-modal-test-password",
        AGENT_AI_SESSION_SECRET: "synthetic-modal-test-session-key-not-real-0123456789",
        CONNECTION_API_BASE_URL: "https://platform.example/api",
        UCP_PLATFORM_PROFILE_URL: "https://agent.example/.well-known/ucp",
      },
    });
    assert.equal(output.trim(), message);
  });
}
