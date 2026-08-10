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
 * breakdowns (Abilities/Items/Moves/Spreads/Teammates) are raw weighted
 * counts, not fractions — they must be divided by that Pokémon's OWN
 * total weighted count to become a percentage. Abilities and held items
 * are mutually exclusive per battle (one ability, one item), so the sum
 * of all Ability weights for a Pokémon equals its total weighted
 * appearances — that sum is the denominator used for every category
 * below, matching how Smogon's own site displays these numbers.
 *
 * IMPORTANT — names: chaos JSON keys (moves/items/abilities/species) are
 * Pokémon Showdown internal IDs — lowercase, no spaces or punctuation
 * ("suckerpunch", "focussash"). We build id→display-name dictionaries
 * from PokeAPI once per run and use them to show real names.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

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
const DETAIL_LIMITS = { teammates: 6, abilities: 4, items: 6, moves: 8, spreads: 4 };
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
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Fetch failed for ${slug} @ ${rating}: ${res.status} ${res.statusText} (${url})`);
  }
  return res.json();
}

// ---------------------------------------------------------------------
// Name dictionaries: showdown-id -> display name, built once from PokeAPI
// ---------------------------------------------------------------------
const toId = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const titleCase = (s) => s.split(/[- ]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

let MOVE_NAMES = new Map();
let ITEM_NAMES = new Map();
let ABILITY_NAMES = new Map();
let SPECIES_NAMES = new Map(); // id -> {display, sprite}

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

// Species need their own map since slugs keep hyphens for forms
// ("landorus-therian") while chaos JSON strips them entirely
// ("landorustherian") — same id() as everything else, but the display
// name preserves the hyphen (matches real Pokémon naming conventions).
async function buildSpeciesDictionary() {
  console.log("Building species name/sprite dictionary from PokeAPI…");
  const list = await fetchList("pokemon", 2000);
  let done = 0;
  for (const p of list) {
    const id = toId(p.name);
    const display = p.name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("-");
    SPECIES_NAMES.set(id, { display, slug: p.name });
    done++;
  }
  console.log(`  ${SPECIES_NAMES.size} species/forms indexed`);
}

function prettifyMove(id) { return MOVE_NAMES.get(toId(id)) || titleCase(id); }
function prettifyItem(id) { return ITEM_NAMES.get(toId(id)) || titleCase(id); }
function prettifyAbility(id) { return ABILITY_NAMES.get(toId(id)) || titleCase(id); }
function speciesInfo(id) {
  return SPECIES_NAMES.get(toId(id)) || { display: titleCase(id), slug: toId(id) };
}

// Sprite + type come from a per-species PokeAPI call (cached), reusing
// the same slug the name dictionary resolved above.
const SPECIES_DETAIL_CACHE = new Map();
async function lookupSpeciesDetail(showdownName) {
  const { slug } = speciesInfo(showdownName);
  if (SPECIES_DETAIL_CACHE.has(slug)) return SPECIES_DETAIL_CACHE.get(slug);
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${slug}`);
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    const type = data.types?.[0]?.type?.name ?? "unknown";
    const sprite = data.sprites?.other?.["official-artwork"]?.front_default
      || data.sprites?.front_default || null;
    const result = { type: type.charAt(0).toUpperCase() + type.slice(1), sprite };
    SPECIES_DETAIL_CACHE.set(slug, result);
    return result;
  } catch {
    const result = { type: "Unknown", sprite: null };
    SPECIES_DETAIL_CACHE.set(slug, result);
    return result;
  }
}

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

async function parseChaosJson(chaos) {
  const entries = Object.entries(chaos.data || {}).filter(([name]) => name !== "empty");
  const result = [];
  for (const [name, stats] of entries) {
    const { type, sprite } = await lookupSpeciesDetail(name);
    // Abilities/Items are 1-per-battle, so their weight sum is this
    // Pokémon's true total weighted appearances. Fall back to Moves/4
    // (roughly 4 moves per set) only if both are missing.
    const total = sumWeights(stats.Abilities) || sumWeights(stats.Items)
      || sumWeights(stats.Moves) / 4 || 0;

    result.push({
      name: speciesInfo(name).display,
      type,
      sprite,
      usage: Math.round((stats.usage ?? 0) * 1000) / 10,
      teammates: topEntries(stats.Teammates, DETAIL_LIMITS.teammates, total, (n) => speciesInfo(n).display),
      abilities: topEntries(stats.Abilities, DETAIL_LIMITS.abilities, total, prettifyAbility),
      items: topEntries(stats.Items, DETAIL_LIMITS.items, total, prettifyItem),
      moves: topEntries(stats.Moves, DETAIL_LIMITS.moves, total, prettifyMove),
      spreads: topEntries(stats.Spreads, DETAIL_LIMITS.spreads, total, null), // "Nature:HP/Atk/..." already readable
    });
  }
  return result.sort((a, b) => b.usage - a.usage);
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  await buildNameDictionaries();
  await buildSpeciesDictionary();

  const manifest = [];

  for (const [label, slug] of Object.entries(FORMATS)) {
    console.log(`Fetching ${label} (${slug}) — ${MONTH}, ratings ${RATINGS.join("/")}`);
    const byRating = {};

    for (const rating of RATINGS) {
      console.log(`  Rating ${rating}+…`);
      const chaos = await fetchChaosJson(slug, rating);
      byRating[rating] = await parseChaosJson(chaos);
      if (byRating[rating].length === 0) {
        console.warn(`    ⚠ 0 species parsed for ${slug}-${rating} — check the JSON shape, it may not match "chaos.data" anymore`);
      } else {
        console.log(`    ${byRating[rating].length} species parsed`);
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
