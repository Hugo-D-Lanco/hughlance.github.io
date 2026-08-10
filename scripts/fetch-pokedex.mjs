#!/usr/bin/env node
/**
 * fetch-pokedex.mjs
 *
 * Pulls Pokémon Champions battle data from championsbattledata.com's public
 * API and stores it locally as site/data/pokedex.json, so the site can show
 * sprites, types, base stats, full learnable movepools, and current
 * Doubles/Singles battle breakdowns (top moves, items, abilities,
 * teammates, EV spreads, and each Pokémon's in-game usage RANK) without
 * hitting championsbattledata.com on every page load.
 *
 * One request gets everything: GET https://championsbattledata.com/api
 * returns every indexed Pokémon in a single JSON payload (confirmed live —
 * see the "summary" object per entry). We trim it down before writing,
 * dropping the daily dated CSV path lists (dozens of entries per Pokémon
 * we don't use yet) to keep the local file a manageable size.
 *
 * Champions has no ELO/rating system. Instead, each Pokémon's battle
 * summary carries a "position" value (the same number repeats across all
 * of that Pokémon's category rows for a format) — this is its usage RANK
 * for that format. Lower position = more used. We surface this as
 * `rank` so the site can sort/display Champions Pokémon the same way it
 * sorts Smogon usage %, just without a percentage.
 *
 * This is a fan-made public API, unaffiliated with Nintendo/Game Freak/
 * The Pokémon Company, per its own site footer.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ---- Configure ----
const API_URL = "https://championsbattledata.com/api";
const ASSET_BASE = "https://championsbattledata.com/"; // image_path values are relative to this
const DOWNLOAD_SPRITES = true; // false = store remote sprite URLs instead of local files
const SPRITE_DIR = path.join(process.cwd(), "site", "assets", "sprites");
const OUT_FILE = path.join(process.cwd(), "site", "data", "pokedex.json");
const TOP_LIST_LIMIT = 10; // championsbattledata's "values" arrays are already top-10
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

// A category's "top" entry + "values" list together become a ranked
// {name, note?} list, capped at TOP_LIST_LIMIT. Percentages are only
// present for some categories (move/item/ability/stat_alignment) — not
// teammate, which championsbattledata only ranks, not scores.
function buildCategoryList(topEntry, valuesArr = []) {
  return (valuesArr || []).slice(0, TOP_LIST_LIMIT).map((name, i) => {
    const entry = { name };
    if (i === 0 && topEntry && typeof topEntry.percentage_value === "number") {
      entry.topPercentage = topEntry.percentage_value;
    }
    return entry;
  });
}

function buildFormatBlock(formatSummary) {
  if (!formatSummary) return null;
  const { top = {}, values = {}, position = null } = formatSummary;
  return {
    rank: position, // lower = more used; Champions has no ELO, this is the sort key
    topMove: top.move?.name ?? null,
    topItem: top.held_item?.name ?? null,
    topAbility: top.ability?.name ?? null,
    topTeammate: top.teammate?.name ?? null,
    topNature: top.stat_alignment?.name ?? null,
    moves: buildCategoryList(top.move, values.move),
    items: buildCategoryList(top.held_item, values.held_item),
    abilities: buildCategoryList(top.ability, values.ability),
    teammates: buildCategoryList(top.teammate, values.teammate),
    natures: buildCategoryList(top.stat_alignment, values.stat_alignment),
    evSpreads: (values.stat_points || []).slice(0, TOP_LIST_LIMIT),
  };
}

async function buildRecord(entry) {
  const summary = entry.summary || {};
  const primary = summary.primary || {};
  const battleCurrent = summary.battleSummary?.Current || {};

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
    baseStats: summary.baseStats || null,
    baseStatTotal: summary.baseStatTotal || null,
    learnableMoves: entry.learnableMoveNames || [],
    forms: (summary.forms || []).map(f => ({
      name: f.form_name,
      savedName: f.saved_name,
      types: f.types,
      abilities: (f.abilities || "").split("|").filter(Boolean),
      baseStats: {
        hp: f.hp, attack: f.attack, defense: f.defense,
        sp_attack: f.sp_attack, sp_defense: f.sp_defense, speed: f.speed,
      },
      baseStatTotal: f.base_stat_total,
      imagePath: f.image_path,
    })),
    doubles: buildFormatBlock(battleCurrent.Doubles),
    singles: buildFormatBlock(battleCurrent.Singles),
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

  const pokedex = {};
  let done = 0;
  for (const entry of entries) {
    pokedex[entry.showdownId] = await buildRecord(entry);
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${entries.length}…`);
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
