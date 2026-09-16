// Transfermarkt profile scraper. Regex-based (no DOM) so it runs on Node and on edge runtimes.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

export function parseTmUrl(input) {
  const s = String(input || "").trim();
  const m = s.match(/transfermarkt\.[a-z.]+\/([^/?#]+)\/[a-z_]+\/spieler\/(\d+)/i) || s.match(/spieler\/(\d+)/i);
  if (!m) return null;
  const id = m.length === 3 ? m[2] : m[1];
  const slug = m.length === 3 ? m[1] : "player";
  return { id, slug, url: `https://www.transfermarkt.com/${slug}/profil/spieler/${id}` };
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#039": "'", apos: "'", nbsp: " " };
function decode(s) {
  return s
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : all;
      }
      return ENT[e.toLowerCase()] ?? all;
    });
}
const text = (h) => decode(String(h || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// "24/06/1987 (39)" or "Jun 24, 1987 (39)" -> "1987-06-24"
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function parseTmDate(s) {
  if (!s) return null;
  let m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

// "€ 15.00 m" -> 15000000, "€500k" -> 500000
export function parseMarketValue(s) {
  const m = String(s || "").match(/([\d.,]+)\s*(bn|m|k|th\.?)?/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  const mult = { bn: 1e9, m: 1e6, k: 1e3, th: 1e3, "th.": 1e3 }[(m[2] || "").toLowerCase()] || 1;
  return Number.isFinite(n) ? Math.round(n * mult) : null;
}

export function parseTmProfile(html, tmId) {
  const out = { tm_id: String(tmId), source: "transfermarkt" };

  const h1 = html.match(/<h1 class="data-header__headline-wrapper">([\s\S]*?)<\/h1>/);
  if (!h1) throw new Error("Not a Transfermarkt player profile (no header found)");
  const shirt = h1[1].match(/data-header__shirt-number">\s*#?(\d+)/);
  out.shirt_number = shirt ? Number(shirt[1]) : null;
  out.name = text(h1[1].replace(/<span class="data-header__shirt-number">[\s\S]*?<\/span>/, ""));

  const img = html.match(/<img src="([^"]+)"[^>]*class="data-header__profile-image"/);
  out.photo_url = img && !/default\.jpg/.test(img[1]) ? img[1] : null;

  // info table: label/value pairs
  const info = {};
  const start = html.indexOf('class="info-table');
  const block = start >= 0 ? html.slice(start, start + 15000) : "";
  const re = /info-table__content--regular">([\s\S]*?)<\/span>\s*<span[^>]*info-table__content--bold[^>]*>([\s\S]*?)<\/span>\s*(?=<span|<\/div)/g;
  for (const [, lab, val] of block.matchAll(re)) info[text(lab).replace(/:$/, "")] = val;

  const dobRaw = text(info["Date of birth/Age"] || info["Date of birth"]);
  out.birthdate = parseTmDate(dobRaw);
  out.birthplace = text(info["Place of birth"]) || null;
  const h = text(info["Height"]).match(/(\d)[,.](\d{2})/);
  out.height_cm = h ? Number(h[1]) * 100 + Number(h[2]) : null;
  out.citizenship = [...String(info["Citizenship"] || "").matchAll(/title="([^"]+)"/g)].map((x) => decode(x[1]));
  if (!out.citizenship.length && info["Citizenship"]) out.citizenship = [text(info["Citizenship"])];
  out.citizenship = [...new Set(out.citizenship)];
  out.foot = text(info["Foot"]) || null;
  // The agency cell can hold a link, a truncated name whose full form is in a span title, and a
  // "verified" badge image. Take the agency name and never the badge.
  const agentCell = String(info["Player agent"] || "");
  const agentSpan = agentCell.match(/<span[^>]*class="cp"[^>]*title="([^"]+)"/);
  const agentLink = agentCell.match(/<a[^>]*>([\s\S]*?)<\/a>/);
  const agentName = agentSpan ? decode(agentSpan[1]) : agentLink ? text(agentLink[1]) : text(agentCell.replace(/<img[^>]*>/g, ""));
  out.agent = agentName && !/^verified$/i.test(agentName) ? agentName : null;
  out.joined = parseTmDate(text(info["Joined"]));
  out.contract_expires = parseTmDate(text(info["Contract expires"]));
  out.loan_from = text(info["On loan from"]) || null;
  out.loan_contract_expires = parseTmDate(text(info["Contract there expires"]));

  const pos = html.match(/class="detail-position__box">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/);
  const main = html.match(/detail-position__title">Main position:<\/dt>\s*<dd class="detail-position__position">([\s\S]*?)<\/dd>/);
  out.position = main ? text(main[1]) : text(info["Position"]).replace(/^.* - /, "") || null;
  const other = html.match(/Other position:<\/dt>([\s\S]*?)<\/dl>/);
  out.other_positions = other ? [...other[1].matchAll(/detail-position__position">([\s\S]*?)<\/dd>/g)].map((x) => text(x[1])) : [];
  if (!pos && !main) out.other_positions = [];

  const club = html.match(/data-header__club"[^>]*>\s*<a title="([^"]+)" href="[^"]*\/verein\/(\d+)"/);
  out.club = club ? decode(club[1]) : text(info["Current club"]) || null;
  out.club_tm_id = club ? club[2] : null;
  out.club_logo_url = out.club_tm_id ? `https://tmssl.akamaized.net/images/wappen/head/${out.club_tm_id}.png` : null;
  const lg = html.match(/data-header__league-link" href="[^"]*\/wettbewerb\/([^"/]+)">([\s\S]*?)<\/a>/);
  out.league_code = lg ? lg[1] : null;
  out.league = lg ? text(lg[2]) || null : null;

  const mv = html.match(/data-header__market-value-wrapper">([\s\S]*?)<(?:p|\/a)/);
  const mvText = mv ? text(mv[1]).replace(/Last update.*$/, "").trim() : "";
  out.market_value_eur = mvText ? parseMarketValue(mvText) : null;
  out.market_value_display = mvText || null;

  const intl = html.match(/Current international:[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || html.match(/National player:[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
  out.national_team = intl ? text(intl[1]) : null;

  out.tm_url = null;
  return out;
}

export async function fetchTmPlayer(input) {
  const parsed = parseTmUrl(input);
  if (!parsed) throw new Error("That doesn't look like a Transfermarkt player link");
  const res = await fetch(parsed.url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Transfermarkt returned ${res.status}`);
  const html = await res.text();
  const p = parseTmProfile(html, parsed.id);
  p.tm_url = parsed.url;
  return p;
}

// Rows from the "Search results for players" table of Transfermarkt's quick search.
export function parseTmSearch(html) {
  const start = html.indexOf("Search results for players");
  if (start < 0) return [];
  const end = html.indexOf("Search results for", start + 30);
  const block = html.slice(start, end > 0 ? end : undefined);
  return block
    .split(/<tr class="(?:odd|even)">/)
    .slice(1)
    .map((r) => {
      const link = r.match(/<td class="hauptlink"><a title="([^"]*)" href="(\/[^"]+\/profil\/spieler\/(\d+))"/);
      if (!link) return null;
      const club = r.match(/<\/tr><tr><td>(?:<a title="([^"]*)"[^>]*>[^<]*<\/a>|([^<]*))<\/td><\/tr><\/table>/);
      const cells = [...r.matchAll(/<td class="zentriert">([\s\S]*?)<\/td>/g)].map((m) => m[1]); // position, crest, age, flags
      const photo = r.match(/<img src="([^"]+)"[^>]*class="bilderrahmen-fixed"/);
      const mv = r.match(/<td class="rechts hauptlink">([\s\S]*?)<\/td>/);
      const age = text(cells[2]);
      return {
        tm_id: link[3],
        name: decode(link[1]),
        url: `https://www.transfermarkt.com${link[2]}`,
        club: club ? decode(club[1] || club[2] || "").trim() || null : null,
        position: text(cells[0]) || null,
        age: /^\d+$/.test(age) ? Number(age) : null,
        citizenship: [...String(cells[3] || "").matchAll(/title="([^"]+)"/g)].map((m) => decode(m[1])),
        market_value: mv ? text(mv[1]).replace(/^-$/, "") || null : null,
        photo_url: photo && !/default/.test(photo[1]) ? photo[1] : null,
      };
    })
    .filter(Boolean);
}

export async function searchTmPlayers(query) {
  const url = `https://www.transfermarkt.com/schnellsuche/ergebnis/schnellsuche?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html" } });
  if (!res.ok) throw new Error(`Transfermarkt search returned ${res.status}`);
  return parseTmSearch(await res.text());
}
