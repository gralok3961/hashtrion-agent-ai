import assert from "node:assert/strict";
import test from "node:test";
import { createUsageGuard, discoveryEnabled } from "../src/lib/server/usage-guard";

test("concurrency is bounded and releasing twice does not free another request", () => {
  const guard = createUsageGuard({ now: () => 0, concurrency: 2 });
  const first = guard.acquire();
  const second = guard.acquire();
  assert.ok(first);
  assert.ok(second);
  assert.equal(guard.acquire(), null);

  first();
  first();
  const third = guard.acquire();
  assert.ok(third);
  assert.equal(guard.acquire(), null);

  second();
  third();
  assert.ok(guard.acquire());
});

test("released and failed calls keep their rolling minute budget", () => {
  let time = 0;
  const guard = createUsageGuard({ now: () => time, perMinute: 2 });
  const first = guard.acquire();
  assert.ok(first);
  first();

  time = 1_000;
  const second = guard.acquire();
  assert.ok(second);
  // Release in a real API request's finally also follows this path after failure.
  second();
  assert.equal(guard.acquire(), null);
  time = 59_999;
  assert.equal(guard.acquire(), null);
  time = 60_000;
  assert.ok(guard.acquire());
  assert.equal(guard.acquire(), null);
});

test("daily spend does not reset at midnight and expires after a rolling day", () => {
  const day = 24 * 60 * 60_000;
  let time = day - 1_000;
  const guard = createUsageGuard({ now: () => time, perDay: 1 });
  const release = guard.acquire();
  assert.ok(release);
  release();

  time = day + 60_000;
  assert.equal(guard.acquire(), null);
  time = 2 * day - 1_001;
  assert.equal(guard.acquire(), null);
  time = 2 * day - 1_000;
  assert.ok(guard.acquire());
});

test("rejected concurrency attempts do not consume paid-call quota", () => {
  const guard = createUsageGuard({ now: () => 0, concurrency: 1, perDay: 2 });
  const first = guard.acquire();
  assert.ok(first);
  assert.equal(guard.acquire(), null);
  assert.equal(guard.acquire(), null);
  first();
  const second = guard.acquire();
  assert.ok(second);
  second();
  assert.equal(guard.acquire(), null);
});

test("a backward or invalid clock cannot restore exhausted quota", () => {
  let time = 100_000;
  const guard = createUsageGuard({ now: () => time, perMinute: 1 });
  const release = guard.acquire();
  assert.ok(release);
  release();
  time = 0;
  assert.equal(guard.acquire(), null);
  time = Number.NaN;
  assert.equal(guard.acquire(), null);
  time = 159_999;
  assert.equal(guard.acquire(), null);
  time = 160_000;
  assert.ok(guard.acquire());
});

test("invalid budget configuration is rejected", () => {
  for (const invalid of [0, -1, 1.5, Infinity, Number.NaN]) {
    assert.throws(() => createUsageGuard({ perMinute: invalid }), RangeError);
    assert.throws(() => createUsageGuard({ perDay: invalid }), RangeError);
    assert.throws(() => createUsageGuard({ concurrency: invalid }), RangeError);
  }
});

test("discovery requires an exact, explicit server-side opt-in", () => {
  assert.equal(discoveryEnabled({ NODE_ENV: "development" }), false);
  for (const value of ["false", "1", "TRUE", " true ", ""]) {
    assert.equal(discoveryEnabled({ NODE_ENV: "development", MERCHANT_DISCOVERY_ENABLED: value }), false);
  }
  assert.equal(discoveryEnabled({ NODE_ENV: "development", MERCHANT_DISCOVERY_ENABLED: "true" }), true);
  assert.equal(discoveryEnabled({ NODE_ENV: "test", MERCHANT_DISCOVERY_ENABLED: "true" }), true);
});

test("production and Azure honor the discovery flag after API authentication", () => {
  assert.equal(discoveryEnabled({ NODE_ENV: "production", MERCHANT_DISCOVERY_ENABLED: "true" }), true);
  for (const azureInstance of ["test-instance", ""]) {
    assert.equal(discoveryEnabled({
      NODE_ENV: "production",
      MERCHANT_DISCOVERY_ENABLED: "true",
      WEBSITE_INSTANCE_ID: azureInstance,
    }), true);
    assert.equal(discoveryEnabled({ NODE_ENV: "production", WEBSITE_INSTANCE_ID: azureInstance }), false);
  }
});
