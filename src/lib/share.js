// Link previews for shared URLs (WhatsApp, iMessage, Slack).
//
// Those crawlers fetch the URL without a session and never see the #fragment, so a shared
// #/player/7 link can only ever preview as the bare site. /p/7 is the shareable form: the server
// can read the id there, so it can fill in that player's tags. Only the identity a scout would
// read off Transfermarkt goes out this way — never a decision, verdict, note or summary.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

export function ogTags({ url, title, description, image }) {
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="PINE">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta name="description" content="${esc(description)}">`,
    `<meta name="twitter:card" content="summary">`,
  ].join("\n");
}

export const sitePreview = (origin) => ({
  url: `${origin}/`,
  title: "PINE — Portland Hearts of Pine",
  description: "Player Identification Network Evaluation: the club's scouting database and big board.",
  image: `${origin}/hop-crest.png`,
});

// The one line under the title: "28 · Centre Back · Hearts of Pine · USL League One".
export function playerPreview(player, origin) {
  const line = [player.age != null ? String(player.age) : null, player.position, player.club, player.league]
    .filter((x) => x != null && x !== "")
    .join(" · ");
  return {
    url: `${origin}/p/${player.id}`,
    title: `${player.name} · PINE`,
    description: line || "Player Identification Network Evaluation",
    // Transfermarkt portraits are hotlinkable; anything else falls back to the club crest.
    image: /^https:\/\//.test(player.photo_url || "") ? player.photo_url : `${origin}/hop-crest.png`,
  };
}
