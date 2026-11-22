// Uploads end-of-season free agents (option declined / out of contract) to PINE. Reads one or more research CSVs
// with the columns club, player, decision, source_url, pub_date (decision: option_declined, out_of_contract,
// option_exercised, signed, negotiating, ...), prints what it found, and with --upload sends it.
// The list never goes in this repository; see src/lib/free_agents.js.
//
// --season is the season that just ended (2026 for the decisions made after the 2026 season), never guessed from
// the release dates: some clubs post in January.
//
//   node scripts/free-agents.mjs decisions.csv [more.csv ...] --season 2026
//   PINE_URL=https://... PINE_WORKER_TOKEN=... node scripts/free-agents.mjs decisions.csv --season 2026 --upload
import { readFileSync } from "node:fs";
import { entriesFromDecisions } from "../src/lib/free_agents.js";

// RFC 4180: quoted fields may hold commas, newlines and doubled quotes.
export function parseCsv(textIn) {
  const out = [];
  let row = [], field = "", quoted = false;
  const s = textIn.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) out.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v !== "")) out.push(row);
  const [head, ...body] = out;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

async function main(argv) {
  const files = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--season");
  const upload = argv.includes("--upload");
  const season = argv.includes("--season") ? Number(argv[argv.indexOf("--season") + 1]) : NaN;
  if (!files.length || !Number.isInteger(season)) { console.error("Usage: node scripts/free-agents.mjs decisions.csv [more.csv ...] --season 2026 [--upload]"); process.exit(1); }
  const rows = files.flatMap((f) => parseCsv(readFileSync(f, "utf8")));
  const need = ["club", "player", "decision"];
  if (!rows.length || need.some((k) => !(k in rows[0]))) { console.error(`Each CSV needs the columns ${need.join(", ")}`); process.exit(1); }
  const { entries, skipped } = entriesFromDecisions(rows);
  // The clubs that have posted: anyone with a player row. Each upload replaces those clubs' lists only.
  const clubs = [...new Set(rows.filter((r) => r.player).map((r) => r.club))];
  console.log(`${season}: ${entries.length} free agents from ${clubs.length} clubs (${entries.filter((e) => e.reason === "option_declined").length} options declined, ${entries.filter((e) => e.reason === "out_of_contract").length} out of contract)`);
  for (const s of skipped) console.log(`  left out ${s.name} (${s.club}): ${s.because}`);
  if (!upload) { console.log("Dry run. Add --upload to send it to PINE."); return; }
  const base = String(process.env.PINE_URL || "").replace(/\/+$/, ""), token = process.env.PINE_WORKER_TOKEN || "";
  if (!/^https:\/\//.test(base) || !token) { console.error("Uploads need an https PINE_URL and PINE_WORKER_TOKEN"); process.exit(1); }
  const res = await fetch(`${base}/api/worker/free-agents`, { method: "PUT", body: JSON.stringify({ season, clubs, entries }),
    headers: { "Content-Type": "application/json", "X-PINE": "1", "X-PINE-Worker-Token": token } });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`PINE said ${res.status}: ${out.error || "upload failed"}`); process.exit(1); }
  console.log(`Uploaded: ${out.entries} free agents, ${out.in_pine} of them in PINE.`);
  if (out.not_in_pine?.length) console.log(`Not in PINE (${out.not_in_pine.length}): ${out.not_in_pine.join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
