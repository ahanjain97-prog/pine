import { AsyncLocalStorage } from 'node:async_hooks';

// Request-local counters only. SQL text, parameters and provider URLs never enter telemetry.
export const requestTimings = new AsyncLocalStorage();

export const newRequestTiming = () => ({ active: true, databaseMs: 0, queries: 0, externalMs: 0, externalOpen: 0, externalSince: 0 });

// `statement` is false for transaction boundaries: they take time but are not queries.
export function timeDatabase(operation, statement = true) {
  const timing = requestTimings.getStore();
  if (!timing?.active) return operation();
  const start = performance.now();
  try { return operation(); }
  finally {
    timing.databaseMs += performance.now() - start;
    if (statement) timing.queries++;
  }
}

// Wall-clock time with at least one provider call in flight, so parallel calls are not double counted.
export async function timeExternal(operation) {
  const timing = requestTimings.getStore();
  if (!timing?.active) return operation();
  if (!timing.externalOpen++) timing.externalSince = performance.now();
  try { return await operation(); }
  finally {
    if (!--timing.externalOpen && timing.active) timing.externalMs += performance.now() - timing.externalSince;
  }
}

// Provider fetch that counts the download as well as the headers. Outside a measured request it is plain fetch.
export function timedFetch(url, options) {
  if (!requestTimings.getStore()?.active) return fetch(url, options);
  return timeExternal(async () => {
    const res = await fetch(url, options);
    const body = await res.arrayBuffer();
    return new Response([101, 204, 205, 304].includes(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
}
