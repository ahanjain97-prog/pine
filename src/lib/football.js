// API-Football is shared by all staff. Persist successes, failures and the daily request
// ledger on the volume: reloads, concurrent viewers and restarts must not bypass limits.
import { createHash } from "node:crypto";
import { readDisk, writeDisk } from "./disk_cache.js";

export const FOOTBALL_HOUR = 60 * 60 * 1000;
export const FOOTBALL_DAY = 24 * FOOTBALL_HOUR;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFootballClient({ read = readDisk, write = writeDisk, now = Date.now,
  fetcher = (...args) => fetch(...args), spacingMs = 6500,
  credentials = () => ({ key: process.env.APIFOOTBALL_KEY || process.env.APIFOOTBALL_RAPIDAPI_KEY,
    rapid: !process.env.APIFOOTBALL_KEY && Boolean(process.env.APIFOOTBALL_RAPIDAPI_KEY) }),
  dailyLimit = () => Number(process.env.PINE_FOOTBALL_DAILY_LIMIT || 80),
} = {}) {
  const memory = new Map(), pending = new Map();
  let queue = Promise.resolve(), nextStart = 0, budgetMemory = null;
  const configured = () => Boolean(credentials().key);
  const keyFor = (path, params) => `football-v1-${createHash("sha256").update(path + new URLSearchParams(Object.entries(params).sort()).toString()).digest("hex").slice(0, 24)}`;
  function ledger() {
    const day = new Date(now()).toISOString().slice(0, 10);
    const disk = read("football-budget-v1");
    const saved = budgetMemory?.day === day && (!disk || budgetMemory.count >= disk.count) ? budgetMemory : disk;
    return saved?.day === day ? saved : { day, count: 0, remaining: null, blocked_until: 0 };
  }
  function saveBudget(value) {
    budgetMemory = { ...value };
    write("football-budget-v1", value);
  }
  function remember(key, value) {
    memory.delete(key); memory.set(key, value);
    while (memory.size > 256) memory.delete(memory.keys().next().value);
    write(key, value);
    return value;
  }
  async function request(path, params) {
    const { key, rapid } = credentials();
    if (!key) throw new Error("API-Football is not configured.");
    const limit = Math.max(1, Math.floor(Number(dailyLimit()) || 80));
    let budget = ledger();
    const reserve = Math.max(5, Math.ceil((budget.provider_limit || 0) * 0.2));
    if (budget.count >= limit || (budget.remaining != null && budget.remaining <= reserve)) {
      throw new Error("Today's football API request budget is reserved or used up. Cached schedules are still available.");
    }
    if (budget.blocked_until > now()) throw new Error(budget.error || "The football API is temporarily unavailable. It will retry later.");
    const delay = nextStart - now();
    if (delay > 0) await sleep(delay);
    nextStart = now() + spacingMs;
    // Count attempts before dispatch, including timeouts and provider errors.
    budget = ledger(); budget.count++;
    saveBudget(budget);
    const base = rapid ? "https://api-football-v1.p.rapidapi.com/v3" : "https://v3.football.api-sports.io";
    const headers = rapid ? { "x-rapidapi-key": key, "x-rapidapi-host": "api-football-v1.p.rapidapi.com" } : { "x-apisports-key": key };
    let response;
    try { response = await fetcher(`${base}/${path}?${new URLSearchParams(params)}`, { headers, signal: AbortSignal.timeout(20_000) }); }
    catch { throw new Error("Couldn't reach API-Football. It will retry in an hour."); }
    const remaining = response.headers.get("x-ratelimit-requests-remaining");
    const providerLimit = response.headers.get("x-ratelimit-requests-limit");
    if (remaining != null && Number.isFinite(Number(remaining))) budget.remaining = Number(remaining);
    if (Number(providerLimit) > 0) budget.provider_limit = Number(providerLimit);
    saveBudget(budget);
    let body;
    try { body = await response.json(); } catch { throw new Error("API-Football returned an unreadable response."); }
    const errors = body?.errors;
    const failed = errors && Object.keys(errors).length > 0;
    let message;
    if (errors?.plan) message = "The API-Football plan doesn't cover this season. Enable current-season access on the account.";
    else if ([401, 403].includes(response.status)) message = "API-Football rejected the key or subscription. Check the configured account.";
    else if (response.status === 429 || errors?.requests || errors?.rateLimit || errors?.rate_limit) message = "API-Football's request limit was reached. It will retry later.";
    else if (!response.ok || failed) message = "API-Football couldn't supply this schedule. It will retry in an hour.";
    if (message) {
      if ([401, 403, 429].includes(response.status) || errors?.plan || errors?.requests || errors?.rateLimit || errors?.rate_limit) {
        Object.assign(budget, { blocked_until: now() + FOOTBALL_HOUR, error: message });
        saveBudget(budget);
      }
      throw new Error(message);
    }
    if (!Array.isArray(body?.response) || (body.paging?.total || 1) > 1 || body.results !== body.response.length) {
      throw new Error("API-Football returned incomplete data. The previous schedule has been kept.");
    }
    return body.response;
  }
  async function get(path, params = {}, { ttl = FOOTBALL_HOUR, reduce = (data) => data } = {}) {
    const key = keyFor(path, params), old = memory.get(key) || read(key);
    const cached = old?.format === 1 && Array.isArray(old.data) && Number.isFinite(old.at);
    const maxAge = cached && typeof ttl === "function" ? ttl(old.data) : ttl;
    if (cached && now() - old.at < maxAge) return { ...old, stale: false, error: null };
    if (old?.retry_at > now()) {
      if (cached) return { ...old, stale: true };
      throw new Error(old.error);
    }
    if (pending.has(key)) return pending.get(key);
    const task = queue.catch(() => {}).then(async () => {
      try {
        const data = reduce(await request(path, params));
        return { ...remember(key, { format: 1, at: now(), data }), stale: false, error: null };
      } catch (error) {
        const failed = { ...(cached ? old : {}), format: 1, retry_at: now() + FOOTBALL_HOUR, error: error.message };
        remember(key, failed);
        if (cached) return { ...failed, stale: true };
        throw error;
      }
    });
    pending.set(key, task); queue = task;
    try { return await task; } finally { pending.delete(key); }
  }
  return { configured, get, usage: () => ({ ...ledger(), limit: Math.max(1, Math.floor(Number(dailyLimit()) || 80)) }) };
}

export const football = createFootballClient();
