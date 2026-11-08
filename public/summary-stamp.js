// What's added to the summary is stamped with the date and who added it, as "[Nov 8, 2026 · Ahan] …", the way staff
// were dating their updates by hand. Only a plain addition of a dozen or more characters is stamped, and only where an
// update starts: the top, a new line, or after a full sentence. Edits to existing text aren't.
export const SUMMARY_STAMP = /\[([A-Z][a-z]{2} \d{1,2}, \d{4}) · ([^\]\n]{1,40})\]/g;
export function stampSummary(before, after, name, now = new Date()) {
  const a = before || "", b = after;
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const removed = a.slice(pre, a.length - suf), added = b.slice(pre, b.length - suf);
  if (removed.trim() || added.replace(/\s/g, "").length < 12) return b;
  const lead = added.match(/^\s*/)[0];
  const head = b.slice(0, pre) + lead;
  const startsUpdate = pre === 0 || lead.includes("\n") || b[pre - 1] === "\n" || /[.!?)"”]\s*$/.test(head);
  if (!startsUpdate) return b;
  const date = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${b.slice(0, pre)}${lead}[${date} · ${name}] ${added.slice(lead.length)}${b.slice(b.length - suf)}`;
}
