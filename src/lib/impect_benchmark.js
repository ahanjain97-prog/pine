// Fit only on qualified reference players. Targets never change the reference floor.
export function fixedFloor(value, minimum = 5) {
  const n = Number(value);
  return Number.isFinite(n) && n >= minimum ? n : minimum;
}

export function qualifiedReference(rows, floor) {
  // Transfers contribute once: retain the largest eligible league sample per player.
  const unique = new Map();
  for (const row of rows) {
    if (row.matchShare < floor) continue;
    const old = unique.get(row.playerId);
    if (!old || row.matchShare > old.matchShare) unique.set(row.playerId, row);
  }
  return [...unique.values()];
}

function fit(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (a.length < 8 || new Set(a).size < 3) return null;
  const q = (p) => {
    const i = (a.length - 1) * p;
    return a[Math.floor(i)] + (a[Math.ceil(i)] - a[Math.floor(i)]) * (i % 1);
  };
  const lo = q(.01), hi = q(.99);
  const clipped = a.map((v) => Math.max(lo, Math.min(hi, v)));
  const mean = clipped.reduce((a, b) => a + b, 0) / clipped.length;
  const sd = Math.sqrt(clipped.reduce((a, v) => a + (v - mean) ** 2, 0) / (clipped.length - 1));
  return sd > 0 ? (v) => Number.isFinite(v) ? (Math.max(lo, Math.min(hi, v)) - mean) / sd : null : null;
}

// Midpoint empirical percentile: ties share a rank; an entirely tied cohort is 50.
export function percentile(value, reference) {
  const a = reference.filter(Number.isFinite);
  if (!Number.isFinite(value) || a.length < 8) return null;
  return 100 * (a.filter((v) => v < value).length + .5 * a.filter((v) => v === value).length) / a.length;
}

// byLeague: standardise every KPI within the row's own league (row.league) before pooling, so
// league-wide differences in raw output don't tilt pooled ranks. Component percentiles then rank
// those league-standardised values. Without it, one fit covers the whole pool (the original method).
export function benchmark(target, rows, categories, meta, floor = 5, { byLeague = false } = {}) {
  const peers = qualifiedReference(rows, floor);
  const eligible = target.matchShare >= floor;
  const metrics = [...new Set(Object.values(categories).flat())];
  const groupOf = (p) => (byLeague ? String(p.league ?? "") : "");

  const fits = new Map();
  for (const key of new Set(peers.map(groupOf))) {
    const members = peers.filter((p) => groupOf(p) === key);
    fits.set(key, new Map(metrics.map((m) => [m, fit(members.map((p) => p.values[m]))])));
  }
  const sign = (m) => (meta.get(m)?.inverted ? -1 : 1);
  const z = (p, m) => {
    const v = fits.get(groupOf(p))?.get(m)?.(p.values[m]);
    return Number.isFinite(v) ? v * sign(m) : null;
  };
  const score = (p, ms) => {
    const v = ms.map((m) => z(p, m)).filter(Number.isFinite);
    return v.length >= Math.ceil(ms.length / 2) ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const oriented = (p, m) =>
    byLeague ? z(p, m) : Number.isFinite(p.values[m]) ? p.values[m] * sign(m) : null;

  return {
    peers: peers.length, eligible, league_adjusted: byLeague,
    categories: Object.entries(categories).map(([name, ms]) => {
      const ref = peers.map((p) => score(p, ms)).filter(Number.isFinite);
      const value = eligible ? score(target, ms) : null;
      return { name, score: value, percentile: percentile(value, ref), peer_count: ref.length,
        components: ms.map((m) => {
          const ref = peers.map((p) => oriented(p, m)).filter(Number.isFinite);
          return { metric: m, ...(meta.get(m) || {}), value: target.values[m] ?? null,
            percentile: eligible ? percentile(oriented(target, m), ref) : null,
            peer_count: ref.length };
        }) };
    }),
  };
}
