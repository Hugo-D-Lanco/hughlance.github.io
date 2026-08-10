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
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ---- Configure: only the Champions VGC formats this app supports ----
const MONTH_OVERRIDE = null;        // set to "YYYY-MM" to pin a month, or leave null to auto-use last month
const RATINGS = [0, 1500, 1630, 1760]; // all four cutoffs, low ladder to top cut
const TEAMMATE_LIMIT = 5;           // top N synergy partners kept per Pokémon

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

const OUT_DIR = path.join(process.cwd(), "site", "data");
const TYPE_CACHE = new Map();

async function fetchChaosJson(slug, rating) {
  const url = `https://www.smogon.com/stats/${MONTH}/chaos/${slug}-${rating}.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Fetch failed for ${slug} @ ${rating}: ${res.status} ${res.statusText} (${url})`);
  }
  return res.json();
}

// Chaos JSON only gives species usage/teammates, not typing — enrich from
// PokeAPI (free, no key). Cached across formats and ratings.
async function lookupType(name) {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
  if (TYPE_CACHE.has(key)) return TYPE_CACHE.get(key);
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${key}`);
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    const type = data.types[0]?.type?.name ?? "unknown";
    const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
    TYPE_CACHE.set(key, capitalized);
    return capitalized;
  } catch {
    TYPE_CACHE.set(key, "Unknown");
    return "Unknown";
  }
}

function topTeammates(rawTeammates = {}) {
  return Object.entries(rawTeammates)
    .filter(([name]) => name !== "empty")
    .map(([name, weight]) => ({ name, pct: Math.round(weight * 1000) / 10 }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, TEAMMATE_LIMIT);
}

async function parseChaosJson(chaos) {
  const entries = Object.entries(chaos.data || {}).filter(([name]) => name !== "empty");
  const result = [];
  for (const [name, stats] of entries) {
    result.push({
      name,
      type: await lookupType(name),
      usage: Math.round((stats.usage ?? 0) * 1000) / 10,
      teammates: topTeammates(stats.Teammates),
    });
  }
  return result.sort((a, b) => b.usage - a.usage);
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
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
