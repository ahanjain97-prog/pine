// The option watcher. Every couple of hours PINE reads the news of each USL Championship, USL League One and MLS
// Next Pro club (and of the MLS first teams, where most Next Pro clubs post) and records any new end-of-season
// roster release ("2027 roster decisions", "end-of-year roster update") in option_releases. Staff then get a badge
// on the Options tab and a line in Activity as soon as a club posts. It reads headlines and publish dates only;
// the players are coded separately and arrive with scripts/free-agents.mjs.
//
// Headlines and links come from other sites, so they're kept as text, links must be http(s) on the club's own
// site, and the front end escapes both. A news page's first good read is taken in quietly (no alerts for what was
// already there), and a run that suddenly finds a pile of releases (a site redesign, say) alerts for none of them.
import { logActivity } from "../db.js";
import { ALERT_LEAGUES, seasonFor } from "./roster_decisions.js";
import { OPTION_CLUBS } from "./option_clubs.js";

// A Next Pro team's page also lists its first team's news: a headline naming the first team (and not the Next Pro
// side) is the first team's release.
const norm = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const PARENT = new Map(OPTION_CLUBS.filter((c) => c.np).map((c) => [c.np, c]));
function whose(feedClub, title) {
  if (feedClub.np && feedClub.npWords?.test(title)) return { club: feedClub.np, league: "MLSNP" };
  const parent = PARENT.get(feedClub.club);
  if (parent && !parent.npWords?.test(title) && [parent.club, ...parent.aliases].some((n) => norm(title).includes(norm(n)))) return { club: parent.club, league: "MLS" };
  return { club: feedClub.club, league: feedClub.league };
}

const HOUR = 60 * 60 * 1000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 PINE-roster-watch";
const MAX_ALERTS_PER_RUN = 12;   // more than this at once is a site change, not a run of releases
const MAX_ARTICLE_READS = 25;    // undated headlines whose article is opened for its date, per run

// Is this headline a club's end-of-season roster release (not a single signing, a match-day "roster notes", or a
// national-team call-up)? season is the season that just ended.
const RELEASE = [
  /\broster (decisions?|updates?|moves|status(es)?|announcements?|news)\b/i,
  /\b(contract|team|club) options\b/i,
  /\b(picks? up|exercises?|exercised|declines?|declined)\b.{0,40}\boptions?\b/i,
  /\boptions? (decisions?|exercised|declined|picked up)\b/i,
  /\bcontract decisions?\b/i,
  /\b(end[- ]of[- ](the[- ])?(season|year)|year[- ]end) roster\b/i,
  /\bsays? goodbye to \w+ players\b/i,
  /\b(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b.{0,30}\bplayers\b.{0,40}\breturn\b/i,
  /\bretains? \w+ players\b/i,
];
const NOT_RELEASE = [
  /\broster notes?\b/i, /\bnamed to\b/i, /\bnational team\b/i, /\bu-?\d{2}\b/i, /\bworld cup\b/i, /\bnations league\b/i,
  /\b(announces?|releases?|unveils?) (\S+ ){0,4}roster for\b/i, /\bschedule\b/i, /\broster slot\b/i, /\bpurchase option\b/i, /\broster[- ]building\b/i, /\bcalendar\b/i, /\bpre-?season\b/i,
];
export function isReleaseTitle(title, season) {
  const t = String(title || "");
  if (!RELEASE.some((re) => re.test(t)) || NOT_RELEASE.some((re) => re.test(t))) return false;
  // "... to Conclude 2025 Season" is last year's.
  const years = (t.match(/\b20\d{2}\b/g) || []).map(Number);
  return !years.length || Math.max(...years) >= season;
}

const decode = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&quot;/g, '"').replace(/&apos;|&rsquo;|&lsquo;/g, "'")
  .replace(/&ldquo;|&rdquo;/g, '"').replace(/&ndash;|&mdash;/g, "-").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const siteOf = (host) => String(host).replace(/^www\./, "").split("/")[0];
// A link on the club's own site (or a subdomain of it), http(s) only.
export function ownLink(href, host) {
  try {
    const u = new URL(href, `https://${host.split("/")[0]}/`);
    if (!/^https?:$/.test(u.protocol)) return null;
    const site = siteOf(host), h = u.hostname.replace(/^www\./, "");
    return h === site || h.endsWith(`.${site}`) ? u.href : null;
  } catch { return null; }
}

// A USL club site's WordPress news feed: [{ title, url, published }].
export function parseWpFeed(json, host) {
  if (!Array.isArray(json)) return [];
  return json.map((x) => ({ title: decode(x?.title?.rendered), url: ownLink(x?.link, host), published: /^\d{4}-\d{2}-\d{2}/.test(x?.date || "") ? x.date.slice(0, 10) : null }))
    .filter((x) => x.title && x.url);
}
// An MLS-platform news page's cards: [{ title, url }] (the cards carry no date).
export function parseMlsCards(html, host) {
  const out = [], seen = new Set();
  for (const m of String(html).matchAll(/<a class="fm-card-wrap[^"]*" href="([^"]+)" title="([^"]*)"/g)) {
    const url = ownLink(decode(m[1]), host), title = decode(m[2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url); out.push({ title, url, published: null });
  }
  return out;
}
// An article's publish date from its page: JSON-LD datePublished or the article:published_time meta.
export function articleDate(html) {
  const m = String(html).match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/) || String(html).match(/article:published_time"\s+content="(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export const watchState = { enabled: false, running: false, last_run: null, next_run: null, feeds: 0, failed: [], found: 0, note: null };

async function get(fetchFn, url, wantJson) {
  const res = await fetchFn(url, { headers: { "User-Agent": UA, Accept: wantJson ? "application/json" : "text/html" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return wantJson ? res.json() : res.text();
}

// One pass over every news page. Returns the releases it recorded.
export async function runOptionWatch(db, { fetch: fetchFn = globalThis.fetch, now = new Date(), concurrency = 4 } = {}) {
  if (watchState.running) return [];
  watchState.running = true;
  try {
    const season = seasonFor(now), floor = `${season}-09-15`;
    const feeds = OPTION_CLUBS.filter((c) => c.feed);
    const failed = [], items = [];
    let next = 0;
    const worker = async () => {
      while (next < feeds.length) {
        const c = feeds[next++];
        const [kind, where] = [c.feed.slice(0, c.feed.indexOf(":")), c.feed.slice(c.feed.indexOf(":") + 1)];
        try {
          const list = kind === "wp"
            ? parseWpFeed(await get(fetchFn, `https://${where}/wp-json/wp/v2/sec_news?per_page=30&_fields=date,link,title&_=${now.getTime()}`, true), where)
            : parseMlsCards(await get(fetchFn, `https://${where}`, false), where);
          if (!list.length) throw new Error("no headlines found");
          items.push(...list.map((x) => ({ ...x, feed: c.feed, club: c, host: where })));
        } catch (e) { failed.push({ club: c.club, feed: c.feed, error: String(e.message || e).slice(0, 120) }); }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    const seeded = new Set(db.all("SELECT feed FROM option_watch_feeds").map((r) => r.feed));
    const okFeeds = [...new Set(items.map((x) => x.feed))];
    // Next Pro pages first, so an article on both a Next Pro page and its first team's counts for the Next Pro club.
    items.sort((a, b) => (a.club.league === "MLS") - (b.club.league === "MLS"));
    const fresh = [], marks = new Set();
    let reads = 0;
    for (const x of items) {
      if (marks.has(x.url) || db.get("SELECT 1 FROM option_watch_seen WHERE url = ?", x.url)) continue;
      const { club, league } = whose(x.club, x.title);
      if (!isReleaseTitle(x.title, season)) { marks.add(x.url); continue; }
      const quiet = !seeded.has(x.feed);
      let published = x.published;
      if (!published) {
        // A page's first read takes in what was already there: an article it can't date then is let go rather than
        // left to alert later. After that, one it can't open now is looked at again next run.
        if (reads >= (quiet ? MAX_ARTICLE_READS * 3 : MAX_ARTICLE_READS)) { if (quiet) marks.add(x.url); continue; }
        reads++;
        try { published = articleDate(await get(fetchFn, x.url, false)); } catch { if (quiet) marks.add(x.url); continue; }
      }
      marks.add(x.url);
      if (published && published < floor) continue;
      fresh.push({ club, league, title: x.title.slice(0, 300), url: x.url, published, quiet });
    }
    const alerting = fresh.filter((r) => !r.quiet && ALERT_LEAGUES.has(r.league));
    const capped = alerting.length > MAX_ALERTS_PER_RUN;
    const recorded = [];
    db.tx(() => {
      for (const r of fresh) {
        // An upload (or another page) may already have announced this club's release that day under a slightly different link.
        const known = db.get("SELECT 1 FROM option_releases WHERE season = ? AND club = ? AND published = ?", season, r.club, r.published);
        const alert = !r.quiet && !capped && !known && ALERT_LEAGUES.has(r.league) ? 1 : 0;
        const res = db.run(`INSERT OR IGNORE INTO option_releases(season, club, league, title, url, published, source, alert)
          VALUES (?,?,?,?,?,?, 'watcher', ?)`, season, r.club, r.league, r.title, r.url, r.published, alert);
        if (res.changes) recorded.push({ ...r, id: Number(res.lastInsertRowid), alert });
        // Already there from an upload: give it the club's own headline, without a second alert.
        else db.run("UPDATE option_releases SET title = ?, published = coalesce(published, ?) WHERE url = ? AND source = 'upload'", r.title, r.published, r.url);
      }
      for (const url of marks) db.run("INSERT OR IGNORE INTO option_watch_seen(url) VALUES (?)", url);
      for (const f of okFeeds) db.run("INSERT OR IGNORE INTO option_watch_feeds(feed) VALUES (?)", f);
      db.run("DELETE FROM option_watch_seen WHERE seen_at < datetime('now', '-240 days')");
      for (const r of recorded.filter((r) => r.alert)) {
        logActivity(db, null, null, "found_option_release", { release_id: r.id, club: r.club, league: r.league, title: r.title, url: r.url });
      }
    });
    Object.assign(watchState, { last_run: now.toISOString(), feeds: feeds.length, failed, found: recorded.length,
      note: capped ? `Found ${alerting.length} new releases at once, so none raised an alert (probably a site change)` : null });
    return recorded;
  } finally { watchState.running = false; }
}

// Runs a minute after start, then every two hours. PINE_OPTION_WATCH=off turns it off (tests, local copies).
export function startOptionWatch(db, { firstMs = 60_000, everyMs = 2 * HOUR } = {}) {
  if (process.env.PINE_OPTION_WATCH === "off") return;
  watchState.enabled = true;
  const run = () => {
    watchState.next_run = new Date(Date.now() + everyMs).toISOString();
    runOptionWatch(db).catch((e) => console.warn("[options] watch failed:", e.message));
  };
  watchState.next_run = new Date(Date.now() + firstMs).toISOString();
  setTimeout(run, firstMs).unref?.();
  setInterval(run, everyMs).unref?.();
}
