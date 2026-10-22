// Small retry helpers adapted from the OmniRush CLI and modified for OmniCode.
// No logging, analytics, or telemetry belongs in this module.

export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

export function retryAttempts(env = process.env) {
  const value = Number.parseInt(env.OMNICODE_RETRY_ATTEMPTS || env.OMNIRUSH_RETRY_ATTEMPTS || "5", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 1), 10) : 5;
}

export function computeBackoffMs(attempt, { retryAfterSec } = {}) {
  if (Number.isFinite(retryAfterSec) && retryAfterSec >= 0) {
    return Math.min(retryAfterSec * 1000, 30_000);
  }
  const base = Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export async function withRetries(task, {
  attempts = retryAttempts(),
  isRetryable = ({ response, error }) => Boolean(error) || isRetryableStatus(response?.status),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await task(attempt);
      if (attempt >= attempts || !isRetryable({ response: result?.response, result })) return { result };
      lastError = null;
      const retryAfterSec = Number(result?.response?.headers?.get?.("retry-after"));
      await sleep(computeBackoffMs(attempt, { retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : undefined }));
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryable({ error })) return { error };
      await sleep(computeBackoffMs(attempt));
    }
  }
  return { error: lastError || new Error("request failed") };
}
