#!/usr/bin/env node
/**
 * fetch-usage.mjs
 *
 * Downloads Smogon's public monthly "chaos" usage-stats JSON for the
 * Pokémon Champions VGC formats you care about, across all four rating
 * cutoffs (0 / 1500+ / 1630+ / 1760+), so the site can show usage trends
 * across skill levels and each Pokémon's most common teammates. Only the
 * Champions VGC formats listed in FORMATS are ever fetched — no other
 * format's data is downloaded or stored.
 *
 * Smogon publishes one chaos JSON per format per rating cutoff, at:
 *   https://www.smogon.com/stats/{YYYY-MM}/chaos/{format-slug}-{rating}.json
 *
 * Confirmed slug pattern for Champions VGC Bo3 formats:
 *   gen9championsvgc2026reg{letters}bo3   e.g. gen9championsvgc2026regmbbo3
 * (Verified against https://www.smogon.com/stats/2026-07/gen9championsvgc2026regmbbo3-1760.txt)
 * If a regulation's slug doesn't follow this pattern, check the directory
 * listing at https://www.smogon.com/stats/{YYYY-MM}/chaos/ to confirm it
 * before adding it to FORMATS below.
 *
 * IMPORTANT — percentage math: only the top-level "usage" field in chaos
 * JSON is a ready-to-use fraction of the whole metagame. The per-Pokémon
 * breakdowns (Abilities/Items/Moves/Spreads/Teammates/Checks and
 * Counters) are raw weighted counts, not fractions — they must be
 * divided by that Pokémon's OWN total weighted count to become a
 * percentage. Abilities and held items are mutually exclusive per battle
 * (one ability, one item), so the sum of all Ability weights for a
 * Pokémon equals its total weighted appearances — that sum is the
 * denominator used for every category below, matching how Smogon's own
 * site displays these numbers. Natures and EV spreads are split out of
 * Smogon's combined "Nature:EVs" Spreads keys into two independent
 * ranked lists, matching how the Champions page shows them.
 *
 * IMPORTANT — names: chaos JSON keys (moves/items/abilities/species) are
 * Pokémon Showdown internal IDs — lowercase, no spaces or punctuation
 * ("suckerpunch", "focussash"). Move/item/ability names are prettified
 * via a PokeAPI id→name dictionary built once per run.
 *
 * IMPORTANT — sprites/types/base stats: these come from your LOCAL
 * data/pokedex.json (built by scripts/fetch-pokedex.mjs), not PokeAPI —
 * both Smogon-sourced and Champions-sourced Pokémon then share the same
 * sprite assets and stat numbers site-wide. Run fetch-pokedex.mjs BEFORE
 * this script; if data/pokedex.json is missing, this script stops with
 * an error telling you to do that.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

// Surface ANY failure, no matter where it happens — a silent exit with
// no error message (which is what you hit) means something threw
// outside the normal try/catch path. These make that impossible.
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err?.stack || err);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err?.stack || err);
  process.exit(1);
});

// ---- Configure: only the Champions VGC formats this app supports ----
const MONTH_OVERRIDE = null;        // set to "YYYY-MM" to pin a month, or leave null to auto-use last month
const RATINGS = [0, 1500, 1630, 1760]; // all four cutoffs, low ladder to top cut

const FORMATS = {
  "Regulation M-B — Bo1 (Ladder, Closed Teamsheet)": "gen9championsvgc2026regmb", // ⚠ verify — see note below
  "Regulation M-B — Bo3 (Open Teamsheet)": "gen9championsvgc2026regmbbo3",       // confirmed against the .txt report
  // "Regulation M-A (Bo3)": "gen9championsvgc2026regmabo3", // add once slug is confirmed
  // "Regulation M-C (Bo3)": "gen9championsvgc2026regmcbo3", // add when M-C launches
};
// Note on the Bo1 slug: Bo3/open-teamsheet formats get a "bo3" suffix
// (confirmed), so Bo1/ladder is assumed to be the plain slug with no
// suffix — that's Smogon's usual convention, but it hasn't been checked
// against a live directory listing. Confirm at
// https://www.smogon.com/stats/{YYYY-MM}/chaos/ before relying on it;
// adjust the string above if the real slug differs.
const DETAIL_LIMITS = { teammates: 6, abilities: 4, items: 6, moves: 8, spreads: 4, natures: 4, checks: 6 };
const POKEDEX_PATH = path.join(process.cwd(), "data", "pokedex.json");
// -----------------------------------------------------------------------

function previousMonth() {
  const d = new Date();
  d.setUTCDate(1); // avoid month-length rollover issues
  d.setUTCMonth(d.getUTCMonth() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
const MONTH = MONTH_OVERRIDE || previousMonth();

const OUT_DIR = path.join(process.cwd(), "data");

async function fetchChaosJson(slug, rating) {
  const url = `https://www.smogon.com/stats/${MONTH}/chaos/${slug}-${rating}.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s — a hang here shouldn't hang forever
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Fetch failed for ${slug} @ ${rating}: ${res.status} ${res.statusText} (${url})`);
    }
    const text = await res.text();
    console.log(`    fetched ${(text.length / 1024).toFixed(0)} KB from ${url}`);
    return JSON.parse(text);
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Timed out after 30s fetching ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------
// Local pokedex lookup (sprites, types, base stats) — built by
// scripts/fetch-pokedex.mjs. Both championsbattledata's showdownId and
// Smogon's chaos.json keys are Pokémon Showdown internal IDs, so a plain
// toId() normalization is enough to match one to the other.
// ---------------------------------------------------------------------
const toId = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const titleCase = (s) => s.split(/[- ]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

let POKEDEX = null;
async function loadPokedex() {
  try {
    const raw = await readFile(POKEDEX_PATH, "utf-8");
    POKEDEX = JSON.parse(raw).pokemon || {};
  } catch {
    throw new Error(
      `Couldn't read ${POKEDEX_PATH}. Run "node scripts/fetch-pokedex.mjs" first — ` +
      `Bo1/Bo3 sprites, types, and base stats are sourced from that local file now.`
    );
  }
}

// Species-specific naming exceptions you've confirmed or described —
// checked BEFORE the generic Mega/regional-suffix rules below, since
// these don't follow that pattern cleanly.
const SPECIAL_FORM_RULES = [
  // Floette's "Eternal Flower" form isn't really a Mega Evolution, but
  // this asset library files its art as "Mega Floette" anyway — the
  // actual species identity (for stats + export) is Floette-Eternal.
  { test: /^floette(mega|eternal)$/,
    asset: () => "Mega Floette", display: () => "Floette-Eternal", slug: () => "floette-eternal" },

  // Lycanroc: asset filenames use the literal word "Form"; Showdown/
  // PokeAPI use a hyphen suffix, and Midday has none (it's the default).
  { test: /^lycanroc-?(dusk|midnight)$/,
    asset: (m) => `Lycanroc ${titleCase(m[1])} Form`, display: (m) => `Lycanroc-${titleCase(m[1])}`, slug: (m) => `lycanroc-${m[1]}` },
  { test: /^lycanrocmidday$/,
    asset: () => "Lycanroc Midday Form", display: () => "Lycanroc", slug: () => "lycanroc" },

  // Aegislash: only Blade forme needs this — Shield is the default/base
  // entry and already goes through the normal path.
  { test: /^aegislash-?blade$/,
    asset: () => "Aegislash Blade Forme", display: () => "Aegislash-Blade", slug: () => "aegislash-blade" },

  // Vivillon: many cosmetic wing patterns, all sharing the same
  // "{Pattern} Pattern" asset-name shape.
  { test: /^vivillon-?(.+)$/,
    asset: (m) => `Vivillon ${titleCase(m[1])} Pattern`, display: (m) => `Vivillon-${titleCase(m[1])}`, slug: (m) => `vivillon-${m[1]}` },

  // Paldean Tauros: three "Breed" forms.
  { test: /^tauros-?paldea-?(combat|aqua|blaze)$/,
    asset: (m) => `Paldean Tauros ${titleCase(m[1])} Breed`, display: (m) => `Tauros-Paldea-${titleCase(m[1])}`, slug: (m) => `tauros-paldea-${m[1]}-breed` },
];

function matchSpecialForm(chaosKey){
  const id = chaosKey.toLowerCase();
  for (const rule of SPECIAL_FORM_RULES){
    const m = id.match(rule.test);
    if (m) return { assetName: rule.asset(m), displayName: rule.display(m), pokeApiSlug: rule.slug(m) };
  }
  return null;
}

// Best-effort slug guess for Pokémon not in the local Champions pokedex —
// mainly Mega forms, which Smogon may ID with OR without a hyphen before
// the suffix ("garchompmega" or "garchomp-mega") — the "-?" here makes
// both work and, critically, keeps a real hyphen from ending up INSIDE
// the captured species name (that was the cause of a trailing "%20" in
// the built URLs — the hyphen was leaking into the name via titleCase's
// hyphen-splitting, leaving an empty trailing segment).
// PokeAPI wants "garchomp-mega" / "-mega-x" / "-mega-y".
function guessPokeApiSlug(chaosKey){
  const special = matchSpecialForm(chaosKey);
  if (special) return special.pokeApiSlug;
  const id = chaosKey.toLowerCase();
  let m;
  if ((m = id.match(/^(.+?)-?megax$/))) return `${m[1]}-mega-x`;
  if ((m = id.match(/^(.+?)-?megay$/))) return `${m[1]}-mega-y`;
  if ((m = id.match(/^(.+?)-?megaz$/))) return `${m[1]}-mega-z`;
  if ((m = id.match(/^(.+?)-?mega$/))) return `${m[1]}-mega`;
  if ((m = id.match(/^(.+?)-?alola$/))) return `${m[1]}-alola`;
  if ((m = id.match(/^(.+?)-?galar$/))) return `${m[1]}-galar`;
  if ((m = id.match(/^(.+?)-?hisui$/))) return `${m[1]}-hisui`;
  return id;
}

// Display name for species not in the local Champions pokedex — Showdown
// convention, hyphen-separated ("Charizard-Mega-X", "Raichu-Alola",
// "Floette-Eternal"), matching how you asked these to read and how
// Showdown itself names formes (this is what team-export text should
// show as the species name). Different from championsbattledata's own
// asset-filename convention below — the two are kept separate.
function guessDisplayName(chaosKey){
  const special = matchSpecialForm(chaosKey);
  if (special) return special.displayName;
  const id = chaosKey.toLowerCase();
  let m;
  if ((m = id.match(/^(.+?)-?megax$/))) return `${titleCase(m[1])}-Mega-X`;
  if ((m = id.match(/^(.+?)-?megay$/))) return `${titleCase(m[1])}-Mega-Y`;
  if ((m = id.match(/^(.+?)-?megaz$/))) return `${titleCase(m[1])}-Mega-Z`;
  if ((m = id.match(/^(.+?)-?mega$/))) return `${titleCase(m[1])}-Mega`;
  if ((m = id.match(/^(.+?)-?alola$/))) return `${titleCase(m[1])}-Alola`;
  if ((m = id.match(/^(.+?)-?galar$/))) return `${titleCase(m[1])}-Galar`;
  if ((m = id.match(/^(.+?)-?hisui$/))) return `${titleCase(m[1])}-Hisui`;
  return titleCase(id);
}

// championsbattledata's own asset folder uses a different, SPACE-based
// naming convention ("Mega Charizard X", not "Charizard-Mega-X") —
// confirmed via
// https://championsbattledata.com/pokemon_champions_assets/pokemon/Mega%20Charizard%20X.png
function guessChampionsAssetName(chaosKey){
  const special = matchSpecialForm(chaosKey);
  if (special) return special.assetName;
  const id = chaosKey.toLowerCase();
  let m;
  if ((m = id.match(/^(.+?)-?megax$/))) return `Mega ${titleCase(m[1])} X`;
  if ((m = id.match(/^(.+?)-?megay$/))) return `Mega ${titleCase(m[1])} Y`;
  if ((m = id.match(/^(.+?)-?megaz$/))) return `Mega ${titleCase(m[1])} Z`;
  if ((m = id.match(/^(.+?)-?mega$/))) return `Mega ${titleCase(m[1])}`;
  if ((m = id.match(/^(.+?)-?alola$/))) return `Alolan ${titleCase(m[1])}`;
  if ((m = id.match(/^(.+?)-?galar$/))) return `Galarian ${titleCase(m[1])}`;
  if ((m = id.match(/^(.+?)-?hisui$/))) return `Hisuian ${titleCase(m[1])}`;
  return titleCase(id);
}

// Try the championsbattledata asset path (confirmed format above) before
// ever touching PokeAPI for a sprite, downloading it locally so Bo1/Bo3
// pages load from the same local asset folder as everything else. Logs
// each failure once (not per Pokémon-format-rating call) so a systematic
// naming mismatch is visible without spamming the console.
const CHAMPIONS_ASSET_BASE = "https://championsbattledata.com/pokemon_champions_assets/pokemon/";
const SPRITE_DIR = path.join(process.cwd(), "assets", "sprites");
const CHAMPIONS_SPRITE_CACHE = new Map();
const loggedSpriteFailures = new Set();
// PNG magic bytes — confirms we actually got an image, not a 404 error
// page or empty body that happened to arrive with a 200 status.
function isValidPng(buf) {
  return buf.length > 200 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
}

async function fetchChampionsSpriteByName(assetName, chaosKey){
  if (CHAMPIONS_SPRITE_CACHE.has(chaosKey)) return CHAMPIONS_SPRITE_CACHE.get(chaosKey);
  const url = CHAMPIONS_ASSET_BASE + encodeURIComponent(assetName) + ".png";
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!isValidPng(buf)) throw new Error(`not a valid PNG (${buf.length} bytes)`);
    const localName = `${toId(chaosKey)}.png`;
    await writeFile(path.join(SPRITE_DIR, localName), buf);
    const result = `assets/sprites/${localName}`;
    CHAMPIONS_SPRITE_CACHE.set(chaosKey, result);
    return result;
  } catch (err) {
    if (!loggedSpriteFailures.has(chaosKey)) {
      console.warn(`    ⚠ sprite not found at ${url} (${err.message}) — trying PokeAPI art instead`);
      loggedSpriteFailures.add(chaosKey);
    }
    CHAMPIONS_SPRITE_CACHE.set(chaosKey, null);
    return null;
  }
}

// Base stats/type for anything not in the local pokedex — PokeAPI is
// the source here (sprite comes from championsbattledata above, tried
// first; this only fills in the numbers).
const POKEAPI_STATS_CACHE = new Map();
async function fetchPokeApiStats(chaosKey){
  const slug = guessPokeApiSlug(chaosKey);
  if (POKEAPI_STATS_CACHE.has(slug)) return POKEAPI_STATS_CACHE.get(slug);
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${slug}`);
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    const find = (n) => data.stats?.find(s => s.stat.name === n)?.base_stat ?? 0;
    const baseStats = {
      hp: find("hp"), attack: find("attack"), defense: find("defense"),
      sp_attack: find("special-attack"), sp_defense: find("special-defense"), speed: find("speed"),
    };
    const result = {
      type: data.types?.[0]?.type?.name ? titleCase(data.types[0].type.name) : "Unknown",
      fallbackSprite: data.sprites?.other?.["official-artwork"]?.front_default || data.sprites?.front_default || null,
      baseStats,
      baseStatTotal: Object.values(baseStats).reduce((a, b) => a + b, 0),
    };
    POKEAPI_STATS_CACHE.set(slug, result);
    return result;
  } catch {
    const result = { type: "Unknown", fallbackSprite: null, baseStats: null, baseStatTotal: null };
    POKEAPI_STATS_CACHE.set(slug, result);
    return result;
  }
}

async function fetchFallbackSpecies(chaosKey){
  const displayName = guessDisplayName(chaosKey);
  const assetName = guessChampionsAssetName(chaosKey);
  const [championsSprite, stats] = await Promise.all([
    fetchChampionsSpriteByName(assetName, chaosKey),
    fetchPokeApiStats(chaosKey),
  ]);
  return {
    name: displayName,
    type: stats.type,
    sprite: championsSprite || stats.fallbackSprite, // championsbattledata first, PokeAPI art only if that 404s
    baseStats: stats.baseStats,
    baseStatTotal: stats.baseStatTotal,
  };
}

// Mega/regional forms specifically get sprite-metadata from
// championsbattledata that points at the WRONG path (their own raw,
// unencoded ID-style naming, not the actual "Mega Name.png" convention
// their asset server uses) — trusting entry.sprite for these downloads
// broken/empty files. For these categories, always run our own guesser
// (confirmed correct against a real URL) instead of trusting their data.
function isSpecialForm(chaosKey){
  return matchSpecialForm(chaosKey) !== null
    || /^(.+?)-?(megax|megay|megaz|mega|alola|galar|hisui)$/i.test(chaosKey.toLowerCase());
}

async function localSpecies(chaosKey) {
  const entry = POKEDEX[toId(chaosKey)];
  const special = isSpecialForm(chaosKey);

  // A local entry existing isn't enough on its own — some Champions
  // pokedex entries (mainly single-form Megas, e.g. Abomasnow-Mega) have
  // a badly-formed internal slug that fails their own PokeAPI base-stat
  // lookup, leaving sprite/baseStats null even though the entry exists.
  // Treat "exists but incomplete" the same as "missing": run the
  // fallback guesser too, and fill in only the gaps.
  if (entry && entry.sprite && entry.baseStats && !special) {
    return {
      name: entry.name,
      type: entry.types?.[0] || "Unknown",
      sprite: entry.sprite,
      baseStats: entry.baseStats,
      baseStatTotal: entry.baseStatTotal || null,
    };
  }

  const fallback = await fetchFallbackSpecies(chaosKey);
  if (!entry) return fallback;

  if (special) {
    // Prefer OUR sprite guess over their (unreliable) metadata for
    // these forms; still use their name/stats if present.
    return {
      name: entry.name || fallback.name,
      type: entry.types?.[0] || fallback.type,
      sprite: fallback.sprite || entry.sprite,
      baseStats: entry.baseStats || fallback.baseStats,
      baseStatTotal: entry.baseStatTotal || fallback.baseStatTotal,
    };
  }

  return {
    name: entry.name || fallback.name,
    type: entry.types?.[0] || fallback.type,
    sprite: entry.sprite || fallback.sprite,
    baseStats: entry.baseStats || fallback.baseStats,
    baseStatTotal: entry.baseStatTotal || fallback.baseStatTotal,
  };
}

// ---------------------------------------------------------------------
// Move/item/ability name dictionaries: showdown-id -> display name,
// built once from PokeAPI (pokedex.json doesn't cover these).
// ---------------------------------------------------------------------
let MOVE_NAMES = new Map();
let ITEM_NAMES = new Map();
let ABILITY_NAMES = new Map();

async function fetchList(endpoint, limit) {
  const res = await fetch(`https://pokeapi.co/api/v2/${endpoint}?limit=${limit}`);
  if (!res.ok) throw new Error(`PokeAPI list failed for ${endpoint}`);
  const data = await res.json();
  return data.results || [];
}

async function buildNameDictionaries() {
  console.log("Building move/item/ability name dictionaries from PokeAPI…");
  const [moves, items, abilities] = await Promise.all([
    fetchList("move", 2000),
    fetchList("item", 3000),
    fetchList("ability", 500),
  ]);
  moves.forEach(m => MOVE_NAMES.set(toId(m.name), titleCase(m.name)));
  items.forEach(i => ITEM_NAMES.set(toId(i.name), titleCase(i.name)));
  abilities.forEach(a => ABILITY_NAMES.set(toId(a.name), titleCase(a.name)));
  console.log(`  ${MOVE_NAMES.size} moves, ${ITEM_NAMES.size} items, ${ABILITY_NAMES.size} abilities`);
}

function prettifyMove(id) { return MOVE_NAMES.get(toId(id)) || titleCase(id); }
function prettifyItem(id) { return ITEM_NAMES.get(toId(id)) || titleCase(id); }
function prettifyAbility(id) { return ABILITY_NAMES.get(toId(id)) || titleCase(id); }

// ---------------------------------------------------------------------
// Chaos JSON parsing
// ---------------------------------------------------------------------
function sumWeights(obj = {}) {
  return Object.entries(obj)
    .filter(([k]) => k !== "empty" && k !== "nothing")
    .reduce((sum, [, w]) => sum + w, 0);
}

// total = that Pokémon's own weighted appearance count (see file header
// for why Abilities/Items make the best denominator). prettify is the
// name-lookup function for this specific category.
function topEntries(rawObj = {}, limit, total, prettify) {
  return Object.entries(rawObj)
    .filter(([name]) => name !== "empty" && name !== "nothing")
    .map(([name, weight]) => ({
      name: prettify ? prettify(name) : name,
      pct: total ? Math.round((weight / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, limit);
}

// Smogon bundles nature+EVs into one "Spreads" key, e.g.
// "Adamant:252/0/0/0/4/252". To show a standalone Natures box (like the
// Champions page has) and a pure-numbers EV spreads box, split each key
// on ":" and re-aggregate weights by just the nature, or just the EVs,
// so multiple different EV spreads sharing a nature all count toward it.
function splitSpreadEntries(spreadsObj = {}, part, limit, total) {
  const tally = new Map();
  Object.entries(spreadsObj).forEach(([key, weight]) => {
    if (key === "empty" || key === "nothing") return;
    const [nature, evs] = key.split(":");
    const bucketKey = part === "nature" ? nature : (evs || key);
    tally.set(bucketKey, (tally.get(bucketKey) || 0) + weight);
  });
  return [...tally.entries()]
    .map(([name, weight]) => ({ name, pct: total ? Math.round((weight / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, limit);
}

// Smogon's "Checks and Counters" is keyed by opponent species, each
// value an array where [0] is the check/counter rating (%). Same shape
// as Teammates but scored differently — reuses the same species-name
// resolution map.
function checksEntries(rawObj = {}, limit, nameResolver) {
  return Object.entries(rawObj)
    .filter(([name]) => name !== "empty")
    .map(([name, arr]) => ({
      name: nameResolver(name),
      pct: Array.isArray(arr) && typeof arr[0] === "number" ? Math.round(arr[0] * 10) / 10 : 0,
    }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, limit);
}

async function parseChaosJson(chaos) {
  const entries = Object.entries(chaos.data || {}).filter(([name]) => name !== "empty");

  // Pre-resolve every species name that shows up anywhere as a
  // Teammate or a Check/Counter, so the synchronous callbacks below can
  // just look names up instead of needing to be async themselves.
  const speciesKeys = new Set();
  entries.forEach(([, stats]) => {
    Object.keys(stats.Teammates || {}).forEach(k => { if (k !== "empty") speciesKeys.add(k); });
    Object.keys(stats["Checks and Counters"] || {}).forEach(k => { if (k !== "empty") speciesKeys.add(k); });
  });
  const speciesNames = new Map();
  for (const key of speciesKeys) {
    speciesNames.set(key, (await localSpecies(key)).name);
  }
  const resolveName = (n) => speciesNames.get(n) || titleCase(n);

  const result = [];
  let done = 0;
  for (const [name, stats] of entries) {
    const species = await localSpecies(name);
    done++;
    if (done % 100 === 0) console.log(`      ${done}/${entries.length} species resolved…`);
    // Abilities/Items are 1-per-battle, so their weight sum is this
    // Pokémon's true total weighted appearances. Fall back to Moves/4
    // (roughly 4 moves per set) only if both are missing.
    const total = sumWeights(stats.Abilities) || sumWeights(stats.Items)
      || sumWeights(stats.Moves) / 4 || 0;

    result.push({
      name: species.name,
      type: species.type,
      sprite: species.sprite,
      baseStats: species.baseStats,
      baseStatTotal: species.baseStatTotal,
      usage: Math.round((stats.usage ?? 0) * 1000) / 10,
      teammates: topEntries(stats.Teammates, DETAIL_LIMITS.teammates, total, resolveName),
      abilities: topEntries(stats.Abilities, DETAIL_LIMITS.abilities, total, prettifyAbility),
      items: topEntries(stats.Items, DETAIL_LIMITS.items, total, prettifyItem),
      moves: topEntries(stats.Moves, DETAIL_LIMITS.moves, total, prettifyMove),
      natures: splitSpreadEntries(stats.Spreads, "nature", DETAIL_LIMITS.natures, total),
      evSpreads: splitSpreadEntries(stats.Spreads, "evs", DETAIL_LIMITS.spreads, total),
      checks: checksEntries(stats["Checks and Counters"], DETAIL_LIMITS.checks, resolveName),
    });
  }
  return result.sort((a, b) => b.usage - a.usage);
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(SPRITE_DIR, { recursive: true });
  await loadPokedex();
  await buildNameDictionaries();

  const manifest = [];

  for (const [label, slug] of Object.entries(FORMATS)) {
    console.log(`Fetching ${label} (${slug}) — ${MONTH}, ratings ${RATINGS.join("/")}`);
    const byRating = {};

    for (const rating of RATINGS) {
      console.log(`  Rating ${rating}+…`);
      try {
        const chaos = await fetchChaosJson(slug, rating);
        console.log(`    parsing…`);
        byRating[rating] = await parseChaosJson(chaos);
        if (byRating[rating].length === 0) {
          console.warn(`    ⚠ 0 species parsed for ${slug}-${rating} — check the JSON shape, it may not match "chaos.data" anymore`);
        } else {
          console.log(`    ${byRating[rating].length} species parsed`);
        }
      } catch (err) {
        console.error(`    ✗ ${slug}-${rating} failed: ${err.message}`);
        console.error(`      Continuing with remaining ratings/formats rather than stopping here.`);
        byRating[rating] = []; // keep going — an empty rating beats losing the whole run
      }
    }

    const fileName = `usage-${slug}.json`;
    await writeFile(
      path.join(OUT_DIR, fileName),
      JSON.stringify({ label, slug, month: MONTH, ratings: byRating }, null, 2)
    );
    console.log(`  Wrote ${fileName}`);

    manifest.push({ label, slug, file: fileName, month: MONTH, availableRatings: RATINGS });
  }

  await writeFile(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  console.log(`Wrote manifest.json with ${manifest.length} format(s).`);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
