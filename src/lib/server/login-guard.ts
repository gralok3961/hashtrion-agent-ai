const LOGIN_WINDOW_MS = 15 * 60_000;

/** Global, process-local protection: restarting or adding workers resets/separates it. */
export function createLoginGuard({
  now = Date.now,
  limit = 10,
}: {
  now?: () => number;
  limit?: number;
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Invalid login limit.");
  }
  let attempts: number[] = [];
  let lastTime = -Infinity;
  return {
    attempt(): { allowed: boolean; retryAfter: number } {
      const time = now();
      if (!Number.isFinite(time)) {
        return { allowed: false, retryAfter: 900 };
      }
      const observed = Math.max(time, lastTime);
      lastTime = observed;
      attempts = attempts.filter((attempt) => attempt > observed - LOGIN_WINDOW_MS);
      if (attempts.length >= limit) {
        return {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil((attempts[0] + LOGIN_WINDOW_MS - observed) / 1_000)),
        };
      }
      attempts.push(observed);
      return { allowed: true, retryAfter: 0 };
    },
  };
}

const processState = globalThis as typeof globalThis & {
  __hashtrionLoginGuard?: ReturnType<typeof createLoginGuard>;
};
export const loginGuard = (processState.__hashtrionLoginGuard ??= createLoginGuard());
