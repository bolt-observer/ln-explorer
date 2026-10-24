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
