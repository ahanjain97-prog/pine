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

export function benchmark(target, rows, categories, meta, floor = 5) {
  const peers = qualifiedReference(rows, floor);
  const eligible = target.matchShare >= floor;
  const metrics = [...new Set(Object.values(categories).flat())];
  const fitted = new Map(metrics.map((m) => [m, fit(peers.map((p) => p.values[m]))]));
  const sign = (m) => meta.get(m)?.inverted ? -1 : 1;
  const score = (p, ms) => {
    const v = ms.map((m) => {
      const z = fitted.get(m)?.(p.values[m]);
      return Number.isFinite(z) ? z * sign(m) : null;
    }).filter(Number.isFinite);
    return v.length >= Math.ceil(ms.length / 2) ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  return {
    peers: peers.length, eligible,
    categories: Object.entries(categories).map(([name, ms]) => {
      const ref = peers.map((p) => score(p, ms)).filter(Number.isFinite);
      const value = eligible ? score(target, ms) : null;
      return { name, score: value, percentile: percentile(value, ref), peer_count: ref.length,
        components: ms.map((m) => {
          const ref = peers.map((p) => p.values[m]).filter(Number.isFinite).map((v) => v * sign(m));
          return { metric: m, ...(meta.get(m) || {}), value: target.values[m] ?? null,
            percentile: eligible ? percentile(Number.isFinite(target.values[m]) ? target.values[m] * sign(m) : null, ref) : null,
            peer_count: ref.length };
        }) };
    }),
  };
}
