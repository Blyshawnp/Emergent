export const SAM_SNAPSHOT_CACHE_MS = 60000;
export const SAM_SNAPSHOT_BACKOFF_BASE_MS = 60000;
export const SAM_SNAPSHOT_BACKOFF_MAX_MS = 300000;

function mergeSnapshot(previous, incoming) {
  if (!previous) return incoming;
  const next = { ...previous, ...incoming };
  ['candidateTracking', 'pendingRequests', 'headsetReviews'].forEach((key) => {
    if (incoming?.[key]?.ok === false && previous?.[key]?.ok !== false) {
      next[key] = { ...previous[key], error: incoming[key].error || previous[key].error || '', stale: true };
    }
  });
  return next;
}

export function createSamSnapshotCoordinator(fetchSnapshot, options = {}) {
  const now = options.now || (() => Date.now());
  const cacheMs = options.cacheMs || SAM_SNAPSHOT_CACHE_MS;
  const baseBackoffMs = options.baseBackoffMs || SAM_SNAPSHOT_BACKOFF_BASE_MS;
  const maxBackoffMs = options.maxBackoffMs || SAM_SNAPSHOT_BACKOFF_MAX_MS;
  let cached = null;
  let cachedAt = 0;
  let inFlight = null;
  let failures = 0;
  let backoffUntil = 0;

  const load = ({ force = false } = {}) => {
    const requestedAt = now();
    if (!force && cached && requestedAt - cachedAt < cacheMs) return Promise.resolve(cached);
    if (inFlight) return inFlight;
    if (!force && requestedAt < backoffUntil) {
      return Promise.resolve(cached ? { ...cached, stale: true, backoffUntil } : { ok: false, stale: true, backoffUntil });
    }

    let fetchResult;
    try {
      fetchResult = fetchSnapshot({ force });
    } catch (error) {
      fetchResult = Promise.reject(error);
    }
    inFlight = Promise.resolve(fetchResult)
      .then((incoming) => {
        const next = mergeSnapshot(cached, incoming || { ok: false });
        if (incoming?.ok !== false) {
          failures = 0;
          backoffUntil = 0;
          cachedAt = now();
          cached = next;
          return next;
        }
        failures += 1;
        backoffUntil = now() + Math.min(maxBackoffMs, baseBackoffMs * (2 ** Math.max(0, failures - 1)));
        cached = next;
        return { ...next, stale: Boolean(cached), backoffUntil };
      })
      .catch((error) => {
        failures += 1;
        backoffUntil = now() + Math.min(maxBackoffMs, baseBackoffMs * (2 ** Math.max(0, failures - 1)));
        if (cached) return { ...cached, ok: false, stale: true, backoffUntil, coordinatorError: error };
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return { load };
}
