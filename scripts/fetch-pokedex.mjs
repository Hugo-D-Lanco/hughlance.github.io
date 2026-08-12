#!/usr/bin/env node
/**
 * fetch-pokedex.mjs
 *
 * Pulls Pokémon Champions battle data from championsbattledata.com's public
 * API and stores it locally as data/pokedex.json, so the site can show
 * sprites, types, base stats, and current Doubles/Singles battle
 * breakdowns (moves, items, abilities, natures, EV spreads, teammates,
 * and each Pokémon's in-game usage RANK) without hitting
 * championsbattledata.com on every page load.
 *
 * BASE STATS come from PokeAPI, not championsbattledata. The bulk index's
 * per-Pokémon "summary.primary" stat numbers turned out NOT to be plain
 * base stats (Garchomp showed Attack 150, not its real base 130 — 150 is
 * what Attack 130 becomes at Lv.50 with a neutral nature/31 IV/0 EV,
 * i.e. a calculated in-battle stat, not the base stat itself). PokeAPI's
 * numbers are the standard, unambiguous base stats players expect here.
 *
 * MOVE/ITEM/ABILITY/NATURE/SPREAD PERCENTAGES: the bulk index's condensed
 * "summary.battleSummary" only carries a percentage for the #1 ranked
 * entry per category — ranks 2–10 are name-only. The per-Pokémon battle
 * endpoint (GET /api/battle/{format}/{showdownId}) returns parsed CSV
 * rows shaped like { pokemon, category, rank, name, percentage } — one
 * row per ranked entry, with a real percentage on every rank, not just
 * #1 (confirmed against a real exported CSV). Categories seen: move,
 * held_item, ability, teammate, stat_align (nature), stat_point (EV
 * spread). This script groups those rows by category and uses them in
 * place of the condensed rank-only data whenever they're available,
 * falling back to the condensed version only if this endpoint's shape
 * doesn't match for a given Pokémon (so nothing shows up broken/blank).
 *
 * This is a fan-made public API, unaffiliated with Nintendo/Game Freak/
 * The Pokémon Company, per its own site footer.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ---- Configure ----
const API_URL = "https://championsbattledata.com/api";
const BATTLE_URL = (format, id) => `https://championsbattledata.com/api/battle/${format}/${id}`;
const ASSET_BASE = "https://championsbattledata.com/"; // image_path values are relative to this
const DOWNLOAD_SPRITES = true; // false = store remote sprite URLs instead of local files
const SPRITE_DIR = path.join(process.cwd(), "assets", "sprites");
const OUT_FILE = path.join(process.cwd(), "data", "pokedex.json");
const TOP_LIST_LIMIT = 10;
const FORMATS = ["Doubles", "Singles"];
let loggedSampleRow = false; // print one raw row once, for sanity-checking column detection
// --------------------

async function fetchIndex() {
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`Index fetch failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function downloadSprite(imagePath, showdownId) {
  if (!imagePath) return null;
  const url = ASSET_BASE + imagePath;
  const localName = `${showdownId}.png`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`sprite ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(path.join(SPRITE_DIR, localName), buf);
    return `assets/sprites/${localName}`; // relative path used by the site
  } catch (err) {
    console.warn(`  ⚠ sprite failed for ${showdownId}: ${err.message}`);
    return url; // fall back to the remote URL rather than losing the reference
  }
}

// ---------------------------------------------------------------------
// Base stats — from PokeAPI, cached by species slug.
// ---------------------------------------------------------------------
const BASE_STAT_CACHE = new Map();
async function fetchBaseStats(slug) {
  if (BASE_STAT_CACHE.has(slug)) return BASE_STAT_CACHE.get(slug);
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${slug}`);
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    const find = (n) => data.stats?.find(s => s.stat.name === n)?.base_stat ?? 0;
    const baseStats = {
      hp: find("hp"), attack: find("attack"), defense: find("defense"),
      sp_attack: find("special-attack"), sp_defense: find("special-defense"), speed: find("speed"),
    };
    const baseStatTotal = Object.values(baseStats).reduce((a, b) => a + b, 0);
    const result = { baseStats, baseStatTotal };
    BASE_STAT_CACHE.set(slug, result);
    return result;
  } catch {
    const result = { baseStats: null, baseStatTotal: null };
    BASE_STAT_CACHE.set(slug, result);
    return result;
  }
}

// ---------------------------------------------------------------------
// Condensed category lists from the bulk index (rank-only beyond #1) —
// used as-is for Teammates (no richer source for that), and as a
// fallback for Moves/Items/Abilities/Natures/EV spreads if the richer
// per-Pokémon row aggregation below doesn't pan out for an entry.
// ---------------------------------------------------------------------
function buildCategoryList(topEntry, valuesArr = []) {
  return (valuesArr || []).slice(0, TOP_LIST_LIMIT).map((name, i) => {
    const entry = { name };
    if (i === 0 && topEntry && typeof topEntry.percentage_value === "number") {
      entry.topPercentage = topEntry.percentage_value;
    }
    return entry;
  });
}

function buildCondensedBlock(formatSummary) {
  if (!formatSummary) return null;
  const { top = {}, values = {}, position = null } = formatSummary;
  return {
    rank: position,
    moves: buildCategoryList(top.move, values.move),
    items: buildCategoryList(top.held_item, values.held_item),
    abilities: buildCategoryList(top.ability, values.ability),
    teammates: buildCategoryList(top.teammate, values.teammate),
    natures: buildCategoryList(top.stat_alignment, values.stat_alignment),
    evSpreads: (values.stat_points || []).slice(0, TOP_LIST_LIMIT).map(name => ({ name })),
  };
}

// ---------------------------------------------------------------------
// Rich per-Pokémon rows — GET /api/battle/{format}/{showdownId}.
// Confirmed shape (from a real exported CSV): one row per
// (category, rank, name, percentage) — e.g.
//   { pokemon, category: "move", rank: 1, name: "Dragon Claw", percentage: "85.00%" }
// categories seen: move, held_item, ability, teammate, stat_align
// (nature), stat_point (EV spread). Percentage may arrive as a string
// with a "%" sign, a 0–100 number, or a 0–1 fraction — handled below.
// ---------------------------------------------------------------------
const CATEGORY_MAP = {
  move: "moves",
  held_item: "items",
  item: "items",
  ability: "abilities",
  teammate: "teammates",
  stat_align: "natures",
  stat_alignment: "natures",
  nature: "natures",
  stat_point: "evSpreads",
  stat_points: "evSpreads",
};

function parsePercentage(raw){
  if (raw === null || raw === undefined || raw === "") return 0;
  if (typeof raw === "string"){
    const n = parseFloat(raw.replace("%", "").trim());
    return isNaN(n) ? 0 : n;
  }
  const n = Number(raw);
  if (isNaN(n)) return 0;
  return n <= 1 ? n * 100 : n; // 0–1 fraction vs already-a-percentage
}

function groupRows(rows){
  const buckets = { moves: [], items: [], abilities: [], teammates: [], natures: [], evSpreads: [] };
  for (const row of rows){
    const keys = Object.keys(row);
    const get = (candidates) => {
      const k = keys.find(k => candidates.includes(k.toLowerCase()));
      return k ? row[k] : undefined;
    };
    const category = get(["category"]);
    const name = get(["name"]);
    const percentage = get(["percentage", "percent", "pct"]);
    const bucketName = CATEGORY_MAP[String(category).toLowerCase()];
    if (!bucketName || !name) continue;
    buckets[bucketName].push({ name, pct: parsePercentage(percentage) });
  }
  Object.keys(buckets).forEach(k => {
    buckets[k].sort((a, b) => b.pct - a.pct);
    buckets[k] = buckets[k].slice(0, TOP_LIST_LIMIT);
  });
  return buckets;
}

async function fetchRichBlock(format, showdownId) {
  try {
    const res = await fetch(BATTLE_URL(format, showdownId));
    if (!res.ok) return null;
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data.rows || data.data || null);
    if (!rows || !rows.length) return null;

    if (!loggedSampleRow) {
      console.log("  Sample battle-row keys:", Object.keys(rows[0]).join(", "));
      loggedSampleRow = true;
    }

    return groupRows(rows);
  } catch {
    return null;
  }
}

async function buildFormatBlock(entrySummaryBlock, format, showdownId) {
  const condensed = buildCondensedBlock(entrySummaryBlock);
  if (!condensed) return null;

  const rich = await fetchRichBlock(format, showdownId);
  if (rich) {
    return {
      rank: condensed.rank,
      moves: rich.moves.length ? rich.moves : condensed.moves,
      items: rich.items.length ? rich.items : condensed.items,
      abilities: rich.abilities.length ? rich.abilities : condensed.abilities,
      natures: rich.natures.length ? rich.natures : condensed.natures,
      evSpreads: rich.evSpreads.length ? rich.evSpreads : condensed.evSpreads,
      teammates: rich.teammates.length ? rich.teammates : condensed.teammates,
    };
  }
  return condensed; // fallback: rank-only beyond #1, but never broken/blank
}

async function buildRecord(entry) {
  const summary = entry.summary || {};
  const primary = summary.primary || {};
  const battleCurrent = summary.battleSummary?.Current || {};

  const { baseStats, baseStatTotal } = await fetchBaseStats(entry.slug || entry.showdownId);

  const record = {
    name: entry.name,
    showdownId: entry.showdownId,
    showdownName: entry.showdownName,
    slug: entry.slug,
    isForm: entry.isForm,
    baseName: entry.baseName,
    types: summary.types || [],
    abilities: (primary.abilities || "").split("|").filter(Boolean),
    hiddenAbility: primary.hidden_ability || null,
    baseStats,
    baseStatTotal,
    doubles: await buildFormatBlock(battleCurrent.Doubles, "Doubles", entry.showdownId),
    singles: await buildFormatBlock(battleCurrent.Singles, "Singles", entry.showdownId),
    sprite: null, // filled in below
  };

  record.sprite = DOWNLOAD_SPRITES
    ? await downloadSprite(summary.sprite, entry.showdownId)
    : (summary.sprite ? ASSET_BASE + summary.sprite : null);

  return record;
}

async function run() {
  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  if (DOWNLOAD_SPRITES) await mkdir(SPRITE_DIR, { recursive: true });

  console.log("Fetching Champions Battle Data index…");
  const index = await fetchIndex();
  const entries = index.pokemon || [];
  console.log(`Index has ${entries.length} Pokémon/forms. Building pokedex…`);
  console.log("(This run also hits the per-Pokémon battle endpoint for richer move/item/ability%, so it'll take longer than before.)");

  const pokedex = {};
  let done = 0;
  for (const entry of entries) {
    pokedex[entry.showdownId] = await buildRecord(entry);
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${entries.length}…`);
  }

  await writeFile(
    OUT_FILE,
    JSON.stringify({ generatedAt: index.generatedAt, count: entries.length, pokemon: pokedex }, null, 2)
  );
  console.log(`Wrote ${OUT_FILE} with ${entries.length} entries.`);
  if (DOWNLOAD_SPRITES) console.log(`Sprites saved to ${SPRITE_DIR}`);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
