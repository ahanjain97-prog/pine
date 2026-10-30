// Normalize only for matching; keep the original spelling for display.
const searchText = (value) => String(value ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

export const textMatch = (q, ...values) => {
  if (!q) return true;
  const query = searchText(q);
  return values.some((value) => searchText(value).includes(query));
};

export const matchText = (p, q) => textMatch(q, p.name, p.club, p.league, p.position, (p.citizenship || []).join(" "));
