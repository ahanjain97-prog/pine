import { AsyncLocalStorage } from 'node:async_hooks';

// Request-local counters only. SQL text and parameters never enter telemetry.
export const requestTimings = new AsyncLocalStorage();

export function timeDatabase(operation) {
  const timing = requestTimings.getStore();
  if (!timing?.active) return operation();
  const start = performance.now();
  try { return operation(); }
  finally { timing.databaseMs += performance.now() - start; }
}
