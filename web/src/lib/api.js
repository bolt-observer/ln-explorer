// JSON API client. Every view passes its AbortSignal so a navigation cancels
// the previous view's requests.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { signal } = {}) {
  const response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error || `Request failed (${response.status})`, response.status);
  }
  return response.json();
}

/** AbortSignal.any with a fallback for browsers without it (Safari < 17.4, Chrome < 116, Firefox < 124). */
export function anySignal(signals) {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
      signal: controller.signal,
    });
  }
  return controller.signal;
}

export const isAbort = (error) => error && error.name === "AbortError";

// Short-lived cache for payloads many views share (network stats).
const cache = new Map();

export function cached(path, ttlMs = 60_000) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = api(path).catch((error) => {
    cache.delete(path);
    throw error;
  });
  cache.set(path, { at: Date.now(), promise });
  return promise;
}
