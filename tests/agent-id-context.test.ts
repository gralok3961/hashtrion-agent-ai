import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("the actual chat route preserves Agent ID only in request-scoped runChat options", () => {
  const output = execFileSync(process.execPath, [
    "--experimental-test-module-mocks", "--import", "tsx", resolve("tests/fixtures/agent-id-context.mjs"),
  ], {
    cwd: process.cwd(), timeout: 15_000, encoding: "utf8", stdio: "pipe",
    // Do not inherit credentials, .env loaders, or runtime startup options.
    env: {
      NODE_ENV: "test",
      AGENT_AI_ACCESS_PASSWORD: "synthetic-context-test-password",
      AGENT_AI_SESSION_SECRET: "synthetic-context-signing-key-not-real-0123456789",
      OPENAI_API_KEY: "synthetic-context-api-key-not-real",
      OPENAI_BASE_URL: "https://openai.invalid/v1",
      OPENAI_MODEL: "synthetic-context-model",
      MERCHANT_DISCOVERY_ENABLED: "true",
    },
  });
  assert.equal(output.trim(), "Agent ID request context verified.");
});
