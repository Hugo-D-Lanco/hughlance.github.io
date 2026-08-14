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
import { toId, deriveShowdownId, deriveDisplayName } from "./species-naming.mjs";

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err?.stack || err);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err?.stack || err);
  process.exit(1);
});

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

// PNG magic bytes — confirms we actually got an image, not a 404 error
// page or empty body that happened to arrive with a 200 status.
function isValidPng(buf) {
  return buf.length > 200 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
}

async function downloadSprite(imagePath, showdownId) {
  if (!imagePath) return null;
  const url = ASSET_BASE + imagePath;
  const localName = `${showdownId}.png`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`sprite ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!isValidPng(buf)) throw new Error(`not a valid PNG (${buf.length} bytes)`);
    await writeFile(path.join(SPRITE_DIR, localName), buf);
    return `assets/sprites/${localName}`; // relative path used by the site
  } catch (err) {
    console.warn(`  ⚠ sprite failed for ${showdownId}: ${err.message}`);
    // Return null (not the broken URL) — a falsy sprite is what lets
    // fetch-usage.mjs's fallback logic correctly retry this species
    // later instead of treating a broken link as "already handled".
    return null;
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

const warnedBlankName = new Set(); // module-level: warn once total, not once per Pokémon (hundreds of calls)
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
    if (!bucketName) continue;
    if (!name) {
      if (!warnedBlankName.has(bucketName)) {
        console.warn(`    ⚠ "${category}" rows have a blank "name" field for every Pokémon checked so far — that category's rich per-rank data isn't available from this endpoint; falling back to the condensed (rank-1-only) data for it instead. (This warning only prints once.)`);
        warnedBlankName.add(bucketName);
      }
      continue;
    }
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

// ---------------------------------------------------------------------
// PRIMARY source for form completeness: GET /api/metadata/{base_name}
// returns EVERY form of a species in one call — each row already has
// its own correct saved_name, types, abilities, real base stats, and a
// direct image_path. This replaces guessing entirely for anything
// championsbattledata actually tracks (Megas, regional forms, Aegislash
// both formes, Vivillon patterns, Gourgeist sizes, Meowstic genders,
// Palafin states, Florges colors, Tauros breeds, etc.) — the guessing
// functions in species-naming.mjs now only matter as a last resort for
// species this endpoint doesn't cover at all.
// ---------------------------------------------------------------------
const METADATA_URL = (baseName) => `https://championsbattledata.com/api/metadata/${encodeURIComponent(baseName)}`;

async function fetchMetadataRows(baseName) {
  try {
    const res = await fetch(METADATA_URL(baseName));
    if (!res.ok) return null;
    const data = await res.json();
    return data.rows || null;
  } catch {
    return null;
  }
}

function statsFromMetadataRow(row) {
  const baseStats = {
    hp: row.hp ?? 0, attack: row.atk ?? 0, defense: row.def ?? 0,
    sp_attack: row.spa ?? 0, sp_defense: row.spd ?? 0, speed: row.spe ?? 0,
  };
  const baseStatTotal = row.total ?? Object.values(baseStats).reduce((a, b) => a + b, 0);
  return { baseStats, baseStatTotal };
}

async function buildFlattenedRecord(row, showdownId) {
  const { baseStats, baseStatTotal } = statsFromMetadataRow(row);
  const types = (row.types || "").split("/").map(t => t.trim()).filter(Boolean);
  const abilities = (row.abilities || "").split("|").filter(Boolean);
  const sprite = DOWNLOAD_SPRITES
    ? await downloadSprite(row.image_path, showdownId) // real path from their data — no guessing needed
    : (row.image_path ? ASSET_BASE + row.image_path : null);

  return {
    name: deriveDisplayName(row),
    showdownId,
    showdownName: row.saved_name,
    slug: toId(row.saved_name),
    isForm: true,
    baseName: row.base_name,
    types,
    abilities,
    hiddenAbility: null,
    baseStats,
    baseStatTotal,
    doubles: null, // this endpoint doesn't carry battle-usage breakdowns — see buildFormatBlock for that, kept from an existing entry when present
    singles: null,
    sprite,
  };
}

async function flattenFormsFromMetadata(pokedex, baseNames) {
  console.log(`Fetching per-species metadata for ${baseNames.size} base species (full form list, real stats/sprites)…`);
  let done = 0, formsAdded = 0, formsUpgraded = 0;
  for (const baseName of baseNames) {
    const rows = await fetchMetadataRows(baseName);
    done++;
    if (done % 25 === 0) console.log(`  metadata ${done}/${baseNames.size}…`);
    if (!rows || !rows.length) continue;

    for (const row of rows) {
      const showdownId = deriveShowdownId(row);
      if (!showdownId) continue;
      const existing = pokedex[showdownId];

      // Already has real battle-usage data (from the bulk index) — keep
      // it, but still top up anything it's missing from this row.
      if (existing) {
        const flattenedStats = statsFromMetadataRow(row);
        const needsSprite = !existing.sprite;
        pokedex[showdownId] = {
          ...existing,
          types: existing.types?.length ? existing.types : (row.types || "").split("/").map(t => t.trim()).filter(Boolean),
          abilities: existing.abilities?.length ? existing.abilities : (row.abilities || "").split("|").filter(Boolean),
          baseStats: existing.baseStats || flattenedStats.baseStats,
          baseStatTotal: existing.baseStatTotal || flattenedStats.baseStatTotal,
          sprite: needsSprite
            ? (DOWNLOAD_SPRITES ? await downloadSprite(row.image_path, showdownId) : (row.image_path ? ASSET_BASE + row.image_path : null))
            : existing.sprite,
        };
        if (needsSprite) formsUpgraded++;
        continue;
      }

      pokedex[showdownId] = await buildFlattenedRecord(row, showdownId);
      formsAdded++;
    }
  }
  console.log(`  Flattened ${formsAdded} new forms, upgraded ${formsUpgraded} existing entries with missing data.`);
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

  // Flatten every form (Megas, regional variants, Aegislash formes,
  // Vivillon patterns, Gourgeist sizes, Meowstic genders, etc.) using
  // championsbattledata's own per-species metadata — ground truth, not
  // a guess. This is a build-time-only step (runs once here, not on
  // every page load), so it has zero impact on site load speed.
  const baseNames = new Set(entries.map(e => e.baseName || e.slug || e.showdownId).filter(Boolean));
  await flattenFormsFromMetadata(pokedex, baseNames);

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
