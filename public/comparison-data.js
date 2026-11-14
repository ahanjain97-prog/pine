// Presentation only: align existing values by source IDs; never re-score players.
export const finite = v => typeof v === 'number' && Number.isFinite(v);
export const pct = v => finite(v) && v >= 0 && v <= 100 ? v : null;
export const positionGroup = p => ({ LB: 'FB', RB: 'FB', LW: 'W', RW: 'W' })[p] || p;
const keys = ['tab', 'sort', 'k0', 'k1', 'p0', 'p1', 'f0', 'f1', 'c0', 'c1'];
export function parseComparison(arg = '') {
  const [pair, query = ''] = arg.split('?');
  const ids = (pair || '').split(',').slice(0, 2).map(x => /^\d+$/.test(x) && Number(x) > 0 ? Number(x) : null);
  if (ids[0] === ids[1]) ids[1] = null;
  const params = new URLSearchParams(query), state = { ids: [ids[0] || null, ids[1] || null], tab: 'kpi', sort: 'phase' };
  for (const key of keys) if (params.has(key)) state[key] = params.get(key);
  if (!['kpi', 'physical', 'card'].includes(state.tab)) state.tab = 'kpi';
  if (!['phase', 'gap', 'close'].includes(state.sort)) state.sort = 'phase';
  return state;
}
export function comparisonPath(state) {
  const params = new URLSearchParams();
  for (const key of keys) if (state[key] && !(key === 'tab' && state[key] === 'kpi') && !(key === 'sort' && state[key] === 'phase')) params.set(key, state[key]);
  return `#/compare/${state.ids.map(x => x || '').join(',')}${params.size ? `?${params}` : ''}`;
}
export function mergeRows(a = [], b = []) {
  const right = new Map(b.map(r => [r.id, r]));
  const rows = a.map(r => ({ ...r, a: r, b: right.get(r.id) || null }));
  const seen = new Set(a.map(r => r.id));
  return [...rows, ...b.filter(r => !seen.has(r.id)).map(r => ({ ...r, a: null, b: r }))];
}
export function gap(row, comparable = true) {
  if (!comparable || !row.a || !row.b || row.a.direction !== row.b.direction ||
      pct(row.a.percentile) == null || pct(row.b.percentile) == null) return null;
  return row.a.percentile - row.b.percentile;
}
export function orderRows(rows, sort, comparable = true) {
  if (sort === 'phase' || !comparable) return rows;
  return [...rows].sort((a, b) => {
    const x = gap(a), y = gap(b);
    return x == null ? y == null ? 0 : 1 : y == null ? -1 : sort === 'close' ? Math.abs(x) - Math.abs(y) : Math.abs(y) - Math.abs(x);
  });
}
// An explicit unavailable choice is not replaced behind the user's back.
export function choosePair(a, b, selected = [], match = (x, y) => x.season === y.season) {
  const lists = [a, b], out = lists.map((list, i) => selected[i] ? list.find(x => String(x.key) === String(selected[i])) || null : null);
  if (!selected[0] && !selected[1]) {
    const pair = a.flatMap(x => b.filter(y => match(x, y)).map(y => [x, y]))
      .sort((x, y) => String(y[0].season).localeCompare(String(x[0].season), undefined, { numeric: true }))[0];
    if (pair) return pair;
  }
  for (const i of [0, 1]) if (!selected[i]) out[i] = lists[i].find(x => out[1 - i] && match(x, out[1 - i])) || lists[i][0] || null;
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function kpiComparable(a, b) {
  return !!(a && b && !a.empty && !b.empty && a.position && a.position === b.position && a.iteration?.season != null && b.iteration?.season != null &&
    String(a.iteration?.season) === String(b.iteration?.season) &&
    a.benchmark_competitions?.length && same([...a.benchmark_competitions].sort(), [...(b.benchmark_competitions || [])].sort()) &&
    finite(a.min_share_used) && a.min_share_used > 0 && a.min_share_used === b.min_share_used);
}
export function kpiRows(data) {
  if (!data || data.empty) return [];
  return (data.phases || []).flatMap(phase => (data.categories || []).filter(c => c.phase === phase.id).map(c => ({
    id: `category:${c.name}`, label: c.label, group: phase.name, description: c.description,
    percentile: pct(c.percentile), direction: 'higher', outlook: c.outlook,
    note: c.phase === 'defstyle' ? 'Role and workload, not a quality ranking' : '',
    children: (c.components || []).map(m => ({ id: m.metric, label: m.label, group: m.kind,
      value: m.value, percentile: pct(m.percentile), direction: m.inverted ? 'lower' : 'higher',
      note: m.inverted ? 'Lower raw values are better; percentile already accounts for this' : m.kind === 'volume' ? 'More, not necessarily better' : '',
      description: m.meaning || m.definition,
    })),
  })));
}
export function physicalComparable(a, b) {
  return !!(a && b && a.league && a.grp && a.season != null && a.league === b.league && a.season === b.season && a.grp === b.grp && a.pool === b.pool && a.pool >= 10);
}
export function physicalRows(data, row, groups = []) {
  if (!row) return [];
  const groupOf = new Map(groups.flatMap(([group, metrics]) => metrics.map(([label]) => [label, group])));
  const result = (data.meta?.metrics || []).map((m, i) => ({ id: m.k || m.l, label: m.l,
    group: groupOf.get(m.l) || 'Other physical metrics', value: row.raw?.[i], percentile: pct(row.pct?.[i]), direction: 'higher',
    note: '',
  }));
  const order = [...groups.map(([g]) => g), 'Other physical metrics'];
  return result.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}
export function scoutingRows(envelope) {
  const r = envelope?.render_input, profile = r?.subject?.profiles?.[0];
  if (r?.schema_version !== 16 || !profile) return [];
  const tiles = Object.entries(r.value || {}).flatMap(([family, metrics]) => metrics.map((metric, i) => ({
    id: `tile:${metric}`, label: `${family} · ${['Overall', 'Attack', 'Defend'][i] || metric}`, group: 'Value',
    percentile: pct(profile.percentiles?.[metric]), direction: 'higher',
  })));
  const names = { overall: 'Overall', passing: 'Passing', receiving: 'Receiving', carrying: 'Carrying', shooting: 'Shooting', defending: 'Defending', set_pieces: 'Set pieces' };
  return [...tiles, ...(profile.grid || []).filter(m => m.metric && !m.film).map(m => ({
    id: `metric:${m.metric}`, label: m.name || m.short, group: names[m.bucket] || m.bucket,
    value: m.value, percentile: m.rare ? null : pct(m.percentile), direction: m.direction,
    note: m.rare ? 'Rare for this position; percentile not graded' : m.code === 'D' ? 'Describes style or volume; not a quality ranking' : m.direction === 'lower' ? 'Lower raw values are better; percentile already accounts for this' : '',
    rare: m.rare,
  }))];
}
function gridHash(r) {
  const hashes = r?.provenance?.sha256 || {};
  return hashes[r?.grid?.source] || null;
}
export function scoutingComparable(a, b) {
  const x = a?.render_input, y = b?.render_input;
  return !!(x?.schema_version === 16 && y?.schema_version === 16 && x.subject?.profiles?.[0]?.group && x.subject.profiles[0].group === y.subject?.profiles?.[0]?.group && x.subject.season != null && x.subject.league &&
    x.subject?.season === y.subject?.season && x.subject?.league === y.subject?.league &&
    a.data_as_of && a.data_as_of === b.data_as_of && gridHash(x) && gridHash(x) === gridHash(y) && x.grid?.ledger && x.grid.ledger === y.grid?.ledger);
}
