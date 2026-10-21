type UsageGuardOptions = {
  now?: () => number;
  perMinute?: number;
  perDay?: number;
  concurrency?: number;
};

type ReleaseSlot = () => void;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * A conservative, process-local ceiling for paid chat requests. This is not
 * authentication or a distributed spend budget: instances/restarts have separate
 * counters. Intended only for the password-protected, single-instance hackathon.
 * Call before the first OpenAI request and release in finally after all requests.
 * Failed requests still consume budget; release only frees concurrency capacity.
 */
export function createUsageGuard({
  now = Date.now,
  perMinute = 20,
  perDay = 200,
  concurrency = 2,
}: UsageGuardOptions = {}) {
  for (const limit of [perMinute, perDay, concurrency]) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Usage limits must be positive safe integers.");
    }
  }

  let acceptedAt: number[] = [];
  let inFlight = 0;
  let lastObservedTime = -Infinity;

  return {
    acquire(): ReleaseSlot | null {
      const currentTime = now();
      if (!Number.isFinite(currentTime)) {
        return null;
      }

      // A backward wall-clock adjustment must not clear existing quota usage.
      const observedTime = Math.max(currentTime, lastObservedTime);
      lastObservedTime = observedTime;
      acceptedAt = acceptedAt.filter((time) => time > observedTime - DAY_MS);

      if (
        inFlight >= concurrency ||
        acceptedAt.length >= perDay ||
        acceptedAt.filter((time) => time > observedTime - MINUTE_MS).length >= perMinute
      ) {
        return null;
      }

      acceptedAt.push(observedTime);
      inFlight += 1;
      let released = false;

      return () => {
        if (!released) {
          released = true;
          inFlight -= 1;
        }
      };
    },
  };
}

// Retain the same ceiling through development module reloads. Separate workers
// and Azure instances still do not share this state.
const processState = globalThis as typeof globalThis & {
  __hashtrionChatUsageGuard?: ReturnType<typeof createUsageGuard>;
};
const chatGuard = (processState.__hashtrionChatUsageGuard ??= createUsageGuard());

export function acquireChatSlot(): ReleaseSlot | null {
  return chatGuard.acquire();
}

/**
 * Explicit server-side opt-in for both discovery and catalog search.
 * The HTTP route must authenticate before calling runChat; this flag is not auth.
 */
export function discoveryEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env.MERCHANT_DISCOVERY_ENABLED === "true";
}
