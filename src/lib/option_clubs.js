// The clubs whose end-of-season roster decisions PINE follows, each with the name PINE uses for it, its league,
// where it posts news, and the other ways releases and research files write its name. Club names and news pages
// are public; no players live here. Used by the option watcher (src/lib/option_watch.js) and to file uploaded
// decisions under one name per club (src/lib/roster_decisions.js).
//
// feed: "wp:<host>" is a USL club site's news feed (WordPress); "mls:<host/path>" is an MLS-platform news page.
// np (MLS first teams only): which Next Pro team a first-team page's headline is about, so "Crew 2 announce ..."
// posted on the Crew's page counts for Columbus Crew 2.
export const LEAGUES = {
  USLC: "USL Championship",
  USL1: "USL League One",
  MLSNP: "MLS Next Pro",
  MLS: "MLS",
};
// How PINE's players table writes each league, for the Add player form.
export const PINE_LEAGUE = { USLC: "USLC", USL1: "USL1", MLSNP: "MLS Next Pro", MLS: "MLS" };

const uslc = [
  ["Birmingham Legion FC", "www.bhmlegion.com", ["Birmingham Legion", "Legion FC"]],
  ["Brooklyn FC", "www.brooklynfootballclub.com", ["Brooklyn Football Club"]],
  ["Charleston Battery", "www.charlestonbattery.com"],
  ["Colorado Springs Switchbacks FC", "www.switchbacksfc.com", ["Switchbacks FC", "Colorado Springs Switchbacks"]],
  ["Detroit City FC", "www.detcityfc.com", ["Detroit City"]],
  ["El Paso Locomotive FC", "www.eplocomotivefc.com", ["El Paso Locomotive"]],
  ["Hartford Athletic", "www.hartfordathletic.com"],
  ["Indy Eleven", "www.indyeleven.com"],
  ["Las Vegas Lights FC", "www.lasvegaslightsfc.com", ["Las Vegas Lights"]],
  ["Lexington SC", "lexsporting.com", ["Lexington Sporting Club"]],
  ["Loudoun United FC", "www.loudoununitedfc.com", ["Loudoun United"]],
  ["Louisville City FC", "www.loucity.com", ["Louisville City", "LouCity"]],
  ["Miami FC", "www.miamifc.com", ["The Miami FC"]],
  ["Monterey Bay FC", "www.montereybayfc.com", ["Monterey Bay"]],
  ["New Mexico United", "www.newmexicoutd.com"],
  ["Oakland Roots SC", "oaklandrootssc.com", ["Oakland Roots"]],
  ["Orange County SC", "www.orangecountysoccer.com", ["Orange County"]],
  ["Phoenix Rising FC", "www.phxrisingfc.com", ["Phoenix Rising"]],
  ["Pittsburgh Riverhounds SC", "www.riverhounds.com", ["Pittsburgh Riverhounds", "Riverhounds"]],
  ["Rhode Island FC", "www.rhodeislandfc.com"],
  ["Sacramento Republic FC", "www.sacrepublicfc.com", ["Sacramento Republic"]],
  ["San Antonio FC", "www.sanantoniofc.com"],
  ["Sporting Club Jacksonville", "www.sportingjax.com", ["Sporting JAX", "Sporting Jacksonville"]],
  ["Tampa Bay Rowdies", "www.rowdiessoccer.com", ["Rowdies"]],
  ["FC Tulsa", "www.fctulsa.com", ["Tulsa"]],
];
const usl1 = [
  ["Athletic Club Boise", "www.acboise.com", ["AC Boise"]],
  ["AV Alta FC", "www.avaltafc.com", ["AV Alta"]],
  ["Charlotte Independence", "www.charlotteindependence.com"],
  ["Chattanooga Red Wolves SC", "www.chattanoogaredwolves-sc.com", ["Chattanooga Red Wolves"]],
  ["Corpus Christi FC", "www.corpuscfc.com"],
  ["Fort Wayne FC", "www.fortwaynefc.com"],
  ["Forward Madison FC", "www.forwardmadisonfc.com", ["Forward Madison"]],
  ["Greenville Triumph SC", "www.greenvilletriumph.com", ["Greenville Triumph"]],
  ["One Knoxville SC", "www.oneknoxsc.com", ["One Knoxville"]],
  ["FC Naples", "www.fcnaples.com"],
  ["New York Cosmos", "www.nycosmos.com"],
  ["Portland Hearts of Pine", "www.heartsofpine.com", ["Hearts of Pine"]],
  ["Richmond Kickers", "www.richmondkickers.com"],
  ["Sarasota Paradise", "www.sarasotaparadise.us"],
  ["Spokane Velocity FC", "www.uslspokane.com", ["Spokane Velocity"]],
  ["Union Omaha", "www.unionomaha.com"],
  ["Westchester SC", "www.westchestersc.com"],
];
const mlsnp = [
  ["Atlanta United 2", "www.atlutd.com/2/news", ["ATL UTD 2"]],
  ["Austin FC II", "www.austinfc.com/austinfcii/news"],
  ["Carolina Core FC", "www.carolinacorefc.com/news/"],
  ["Chattanooga FC", "www.chattanoogafc.com/news/topics/cfc-latest-news/"],
  ["Chicago Fire FC II", "www.chicagofirefc.com/two/news", ["Chicago Fire II"]],
  ["Colorado Rapids 2", "www.coloradorapids.com/rapids2/news", ["Rapids 2"]],
  ["Columbus Crew 2", null, ["Crew 2"]],
  ["Connecticut United FC", "www.mlsnextpro.com/ctunited/news", ["CT United FC", "CT United"]],
  ["Crown Legacy FC", null, ["Crown Legacy"]],
  ["FC Cincinnati 2", "www.fccincinnati.com/fccincinnati2/news"],
  ["Houston Dynamo FC 2", "www.houstondynamofc.com/dynamo2/news", ["Houston Dynamo 2", "Dynamo 2"]],
  ["Huntsville City FC", "huntsvillecityfc.com/news"],
  ["Inter Miami CF II", "www.intermiamicf.com/news/topics/inter-miami-cf-ii", ["Inter Miami II"]],
  ["Los Angeles FC 2", "www.lafc.com/lafc2/news", ["LAFC2", "LAFC 2", "Los Angeles FC 2 (LAFC2)"]],
  ["Minnesota United FC 2", "www.mnufc.com/mnufc2/news", ["MNUFC2", "MNUFC 2", "Minnesota United 2"]],
  ["New England Revolution II", "www.revolutionsoccer.net/revolutionii/news", ["Revolution II"]],
  ["New York City FC II", "www.newyorkcityfc.com/news/topics/nycfcii-latest-news", ["NYCFC II"]],
  ["North Texas SC", "www.fcdallas.com/northtexassc/news"],
  ["Orlando City B", "www.orlandocitysc.com/ocb/news"],
  ["Philadelphia Union II", "www.philadelphiaunion.com/unionii/news", ["Union II"]],
  ["Portland Timbers 2", "www.timbers.com/t2/news", ["Timbers2", "Timbers 2", "T2"]],
  ["Real Monarchs SLC", "www.rsl.com/monarchs/news", ["Real Monarchs"]],
  ["Red Bull New York II", "www.newyorkredbulls.com/2/news", ["New York Red Bulls II", "Red Bulls II"]],
  ["San Jose Earthquakes II", "www.sjearthquakes.com/earthquakesii/news", ["Quakes II", "The Town FC", "Quakes II (San Jose Earthquakes II)"]],
  ["Sporting Kansas City II", null, ["Sporting KC II", "SKC II"]],
  ["St. Louis CITY SC 2", null, ["St. Louis CITY2", "St Louis CITY2", "STL CITY2", "St. Louis City 2"]],
  ["Tacoma Defiance", "www.soundersfc.com/tacoma-defiance/news"],
  ["Toronto FC II", "www.torontofc.ca/tfc2/news", ["TFC II"]],
  ["Ventura County FC", "www.lagalaxy.com/venturacountyfc/news"],
  ["Whitecaps FC 2", "www.whitecapsfc.com/wfc2/news", ["WFC2", "Vancouver Whitecaps FC 2"]],
];
// MLS first teams: their news pages carry most Next Pro releases, and their own decisions bundle Next Pro players.
// [club, page, aliases, Next Pro team, headline words that mean the Next Pro team]
const mls = [
  ["Atlanta United FC", "www.atlutd.com/news", [], "Atlanta United 2", /\b(atlanta united|atl utd) 2\b/i],
  ["Austin FC", "www.austinfc.com/news", [], "Austin FC II", /\baustin fc ii\b/i],
  ["Charlotte FC", "www.charlottefootballclub.com/news", [], "Crown Legacy FC", /\bcrown legacy\b/i],
  ["Chicago Fire FC", "www.chicagofirefc.com/news", [], "Chicago Fire FC II", /\bfire (fc )?ii\b/i],
  ["Colorado Rapids", "www.coloradorapids.com/news", [], "Colorado Rapids 2", /\brapids 2\b/i],
  ["Columbus Crew", "www.columbuscrew.com/news", [], "Columbus Crew 2", /\bcrew ?2\b/i],
  ["D.C. United", "www.dcunited.com/news", ["DC United"]],
  ["FC Cincinnati", "www.fccincinnati.com/news", [], "FC Cincinnati 2", /\b(fc )?cincinnati 2\b/i],
  ["FC Dallas", "www.fcdallas.com/news", [], "North Texas SC", /\bnorth texas sc\b/i],
  ["Houston Dynamo FC", "www.houstondynamofc.com/news", [], "Houston Dynamo FC 2", /\bdynamo (fc )?2\b/i],
  ["Inter Miami CF", "www.intermiamicf.com/news", [], "Inter Miami CF II", /\binter miami (cf )?ii\b/i],
  ["LA Galaxy", "www.lagalaxy.com/news", [], "Ventura County FC", /\bventura county\b/i],
  ["Los Angeles FC", "www.lafc.com/news", ["LAFC"], "Los Angeles FC 2", /\blafc ?2\b/i],
  ["Minnesota United FC", "www.mnufc.com/news", ["MNUFC", "Minnesota United"], "Minnesota United FC 2", /\bmnufc ?2\b/i],
  ["CF Montréal", "www.cfmontreal.com/en/news", ["CF Montreal"]],
  ["Nashville SC", "www.nashvillesc.com/news", [], "Huntsville City FC", /\bhuntsville city\b/i],
  ["New England Revolution", "www.revolutionsoccer.net/news", [], "New England Revolution II", /\brevolution ii\b/i],
  ["New York City FC", "www.newyorkcityfc.com/news", ["NYCFC"], "New York City FC II", /\b(nycfc|new york city fc) ii\b/i],
  ["New York Red Bulls", "www.newyorkredbulls.com/news", ["Red Bull New York"], "Red Bull New York II", /\b(red bull new york|red bulls) ii\b/i],
  ["Orlando City SC", "www.orlandocitysc.com/news", [], "Orlando City B", /\borlando city b\b/i],
  ["Philadelphia Union", "www.philadelphiaunion.com/news", [], "Philadelphia Union II", /\bunion ii\b/i],
  ["Portland Timbers", "www.timbers.com/news", [], "Portland Timbers 2", /\btimbers ?2\b/i],
  ["Real Salt Lake", "www.rsl.com/news", ["RSL"], "Real Monarchs SLC", /\breal monarchs\b/i],
  ["San Diego FC", "www.sandiegofc.com/news", ["SDFC"]],
  ["San Jose Earthquakes", "www.sjearthquakes.com/news", [], "San Jose Earthquakes II", /\b(quakes ii|earthquakes ii|the town fc)\b/i],
  ["Seattle Sounders FC", "www.soundersfc.com/news", [], "Tacoma Defiance", /\btacoma defiance\b/i],
  ["Sporting Kansas City", "www.sportingkc.com/news", ["Sporting KC"], "Sporting Kansas City II", /\b(sporting kc|skc|sporting kansas city) ii\b/i],
  ["St. Louis CITY SC", "www.stlcitysc.com/news", ["St. Louis City SC"], "St. Louis CITY SC 2", /\b(st\.? louis )?city ?2\b/i],
  ["Toronto FC", "www.torontofc.ca/news", [], "Toronto FC II", /\b(toronto fc|tfc) ii\b/i],
  ["Vancouver Whitecaps FC", "www.whitecapsfc.com/news", [], "Whitecaps FC 2", /\b(whitecaps fc 2|wfc2)\b/i],
];

export const OPTION_CLUBS = [
  ...uslc.map(([club, host, aliases = []]) => ({ club, league: "USLC", feed: `wp:${host}`, aliases })),
  ...usl1.map(([club, host, aliases = []]) => ({ club, league: "USL1", feed: `wp:${host}`, aliases })),
  ...mlsnp.map(([club, page, aliases = []]) => ({ club, league: "MLSNP", feed: page ? `mls:${page}` : null, aliases })),
  ...mls.map(([club, page, aliases = [], np = null, npWords = null]) => ({ club, league: "MLS", feed: `mls:${page}`, aliases, np, npWords })),
];

const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const BY_NAME = new Map();
for (const c of OPTION_CLUBS) for (const n of [c.club, ...c.aliases]) BY_NAME.set(norm(n), c);

// The club PINE follows under the name a release or research file used, or null when it isn't one of them.
export function findClub(name) {
  return BY_NAME.get(norm(name)) || null;
}
