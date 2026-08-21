/**
 * species-naming.mjs
 *
 * Shared by fetch-pokedex.mjs and fetch-usage.mjs. Champions/Smogon/
 * PokeAPI each use a DIFFERENT naming convention for the same species,
 * and — critically — championsbattledata's OWN metadata (its bulk index's
 * summary.sprite field) is unreliable for Megas and other special forms,
 * pointing at the wrong asset path. So for anything matched here, BOTH
 * scripts override that unreliable metadata with the conventions
 * confirmed below, rather than trusting whatever championsbattledata's
 * own index says for these specific forms.
 *
 * Three naming conventions, kept deliberately separate:
 *   - pokeApiSlug:  what PokeAPI's /pokemon/{slug} endpoint wants (stats)
 *   - displayName:  Showdown's own convention, hyphen-separated
 *                   ("Charizard-Mega-X", "Ninetales-Alola") — used for
 *                   on-page display AND team-export text
 *   - assetName:    championsbattledata's own asset-filename convention,
 *                   space-separated ("Mega Charizard X.png") — used only
 *                   to build the sprite download URL
 */

export const toId = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export const titleCase = (s) => s.split(/[- ]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

// Species-specific exceptions that don't follow the generic Mega/
// regional-suffix pattern below. Checked FIRST.
export const SPECIAL_FORM_RULES = [
  // Floette's "Eternal Flower" form isn't really a Mega Evolution, but
  // this asset library files its art as "Mega Floette" anyway — the
  // real species identity (for stats + export) is Floette-Eternal.
  { test: /^floette-?(mega|eternal)$/,
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

  // Vivillon: cosmetic wing patterns, all sharing the "{Pattern} Pattern"
  // asset-name shape. The bare "vivillon" ID (no pattern — Showdown
  // treats all patterns as battle-identical, so there's usually just
  // one competitive entry) defaults its ART specifically to the Fancy
  // pattern, but keeps the plain "Vivillon" display/export name.
  { test: /^vivillon$/,
    asset: () => "Vivillon Fancy Pattern", display: () => "Vivillon", slug: () => "vivillon" },
  { test: /^vivillon-?(.+)$/,
    asset: (m) => `Vivillon ${titleCase(m[1])} Pattern`, display: (m) => `Vivillon-${titleCase(m[1])}`, slug: (m) => `vivillon-${m[1]}` },

  // Paldean Tauros: three "Breed" forms.
  { test: /^tauros-?paldea-?(combat|aqua|blaze)$/,
    asset: (m) => `Paldean Tauros ${titleCase(m[1])} Breed`, display: (m) => `Tauros-Paldea-${titleCase(m[1])}`, slug: (m) => `tauros-paldea-${m[1]}-breed` },

  // Palafin: base form's ASSET needs "Zero Form" even though its
  // display/export name is just "Palafin" (Zero is the default state).
  { test: /^palafin$/,
    asset: () => "Palafin Zero Form", display: () => "Palafin", slug: () => "palafin" },
  { test: /^palafin-?hero$/,
    asset: () => "Palafin Hero Form", display: () => "Palafin-Hero", slug: () => "palafin-hero" },

  // Furfrou: cosmetic trims are battle-identical in Showdown (one
  // competitive entry), but the asset name needs "Natural Form".
  { test: /^furfrou$/,
    asset: () => "Furfrou Natural Form", display: () => "Furfrou", slug: () => "furfrou" },

  // Florges: five flower colors, confirmed asset shape "{Color} Flower".
  // Red is Showdown's default/base ID (no suffix).
  { test: /^florges$/,
    asset: () => "Florges Red Flower", display: () => "Florges", slug: () => "florges" },
  { test: /^florges-?(blue|orange|white|yellow)$/,
    asset: (m) => `Florges ${titleCase(m[1])} Flower`, display: (m) => `Florges-${titleCase(m[1])}`, slug: (m) => `florges-${m[1]}` },

  // Gourgeist: four sizes; Average is Showdown's default/base ID.
  { test: /^gourgeist-?(small|large|super)$/,
    asset: (m) => `Gourgeist ${titleCase(m[1])}`, display: (m) => `Gourgeist-${titleCase(m[1])}`, slug: (m) => `gourgeist-${m[1]}` },

  // Meowstic: male (default, no suffix) and female are separate species
  // as far as sprites/stats go — must never share art. Mega forms are
  // this game's own addition (not in mainline), so the asset-name guess
  // is unconfirmed — if these sprites still 404, the real filenames are
  // needed to fix this precisely.
  { test: /^meowsticf$/,
    asset: () => "Meowstic F", display: () => "Meowstic-F", slug: () => "meowstic-f" },
  { test: /^meowstic-?f-?mega$/,
    asset: () => "Mega Meowstic F", display: () => "Meowstic-F-Mega", slug: () => "meowstic-f" }, // PokeAPI has no Mega Meowstic — falls back to base female stats
  { test: /^meowstic-?m?-?mega$/,
    asset: () => "Mega Meowstic M", display: () => "Meowstic-M-Mega", slug: () => "meowstic" }, // PokeAPI has no Mega Meowstic — falls back to base male stats
];

export function matchSpecialForm(chaosKey){
  const id = chaosKey.toLowerCase();
  for (const rule of SPECIAL_FORM_RULES){
    const m = id.match(rule.test);
    if (m) return { assetName: rule.asset(m), displayName: rule.display(m), pokeApiSlug: rule.slug(m) };
  }
  return null;
}

// PokeAPI slug — "-?" tolerates chaos-key IDs that keep a literal hyphen
// before the suffix ("garchomp-mega") as well as ones that don't
// ("garchompmega"); without it, a real hyphen leaks into the captured
// species name and (via titleCase's hyphen-splitting) leaves a trailing
// empty segment — that was the cause of a stray trailing space/%20 in
// built names and URLs.
export function guessPokeApiSlug(chaosKey){
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

export function guessDisplayName(chaosKey){
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

export function guessChampionsAssetName(chaosKey){
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

// ---------------------------------------------------------------------
// PREFERRED PATH: derive naming from a REAL championsbattledata metadata
// row (GET /api/metadata/{base_name} — one row per form, with its own
// saved_name/types/abilities/stats/image_path already correct). This is
// ground truth, not a guess — used to flatten every form into its own
// pokedex entry. The guess* functions above stay as a fallback ONLY for
// species championsbattledata doesn't track at all.
// ---------------------------------------------------------------------

// A handful of saved_names don't reduce to a clean Smogon ID by pattern
// alone (Floette's "Eternal Flower" isn't really a Mega, for instance).
const SAVED_NAME_OVERRIDES = {
  "Mega Floette": { smogonId: "floetteeternal", displayName: "Floette-Eternal", pokeApiSlug: "floette-eternal" },
};

// Species whose forms are cosmetic only — they don't change stats,
// abilities, or anything battle-relevant, so the display/export name
// should ALWAYS be just the base species, regardless of which specific
// trim/color/pattern it is. (They still get their own showdownId
// internally, for correct per-variant usage-stat tracking — only the
// user-facing name collapses.)
const COSMETIC_ONLY_BASE_SPECIES = new Set(["furfrou", "florges", "vivillon", "floette"]);

export function deriveShowdownId(row) {
  const override = SAVED_NAME_OVERRIDES[row.saved_name];
  if (override) return override.smogonId;

  const base = toId(row.base_name);
  let s = (row.saved_name || "").trim();
  s = s.replace(/\s+(Form|Forme|Pattern|Flower|Breed)$/i, "").trim();

  let m;
  if ((m = s.match(/^Mega\s+.+?\s+([XYZ])$/i))) return base + "mega" + m[1].toLowerCase();
  if (/^Mega\s+/i.test(s)) return base + "mega";
  if (/^Alolan\s+/i.test(s)) return base + "alola";
  if (/^Galarian\s+/i.test(s)) return base + "galar";
  if (/^Hisuian\s+/i.test(s)) return base + "hisui";
  if ((m = s.match(/^Paldean\s+.+?\s+(\w+)$/i))) return base + "paldea" + toId(m[1]);
  if (/^Paldean\s+/i.test(s)) return base + "paldea"; // no breed suffix — plain regional form

  const speciesTitle = titleCase(base);
  if (s.toLowerCase().startsWith(speciesTitle.toLowerCase())) {
    const suffix = s.slice(speciesTitle.length).trim();
    if (!suffix) return base; // exactly the species name = default form
    if (/^female$/i.test(suffix)) return base + "f";
    if (/^(male|shield)$/i.test(suffix)) return base; // unsuffixed defaults
    if (/^average$/i.test(suffix)) return base;
    return base + toId(suffix);
  }
  return toId(s);
}

export function deriveDisplayName(row) {
  const override = SAVED_NAME_OVERRIDES[row.saved_name];
  if (override) return override.displayName;

  const base = titleCase(toId(row.base_name));
  if (COSMETIC_ONLY_BASE_SPECIES.has(toId(row.base_name))) return base;

  let s = (row.saved_name || "").trim();
  s = s.replace(/\s+(Form|Forme|Pattern|Flower|Breed)$/i, "").trim();

  let m;
  if ((m = s.match(/^Mega\s+.+?\s+([XYZ])$/i))) return `${base}-Mega-${m[1].toUpperCase()}`;
  if (/^Mega\s+/i.test(s)) return `${base}-Mega`;
  if (/^Alolan\s+/i.test(s)) return `${base}-Alola`;
  if (/^Galarian\s+/i.test(s)) return `${base}-Galar`;
  if (/^Hisuian\s+/i.test(s)) return `${base}-Hisui`;
  if ((m = s.match(/^Paldean\s+.+?\s+(\w+)$/i))) return `${base}-Paldea-${titleCase(m[1])}`;
  if (/^Paldean\s+/i.test(s)) return `${base}-Paldea`; // no breed suffix — plain regional form

  if (s.toLowerCase().startsWith(base.toLowerCase())) {
    const suffix = s.slice(base.length).trim();
    if (!suffix) return base;
    if (/^female$/i.test(suffix)) return `${base}-F`;
    if (/^(male|shield)$/i.test(suffix)) return base;
    if (/^average$/i.test(suffix)) return base;
    return `${base}-${titleCase(suffix)}`;
  }
  return titleCase(s);
}

// PokeAPI slug from a REAL metadata row — mirrors deriveShowdownId's
// suffix detection but joins with "-" (PokeAPI's convention) instead of
// concatenating (Smogon's convention). Built from row.base_name directly
// rather than a derived chaos ID, so it doesn't lose information for
// generic suffixes the way the chaos-key-only guessPokeApiSlug can
// (that one only recognizes Mega/regional suffixes — this recognizes
// anything, since it has the real base_name to work from).
export function derivePokeApiSlug(row) {
  const override = SAVED_NAME_OVERRIDES[row.saved_name];
  if (override?.pokeApiSlug) return override.pokeApiSlug;
  if (COSMETIC_ONLY_BASE_SPECIES.has(toId(row.base_name))) return toId(row.base_name);

  const base = toId(row.base_name);
  let s = (row.saved_name || "").trim();
  s = s.replace(/\s+(Form|Forme|Pattern|Flower|Breed)$/i, "").trim();

  let m;
  if ((m = s.match(/^Mega\s+.+?\s+([XYZ])$/i))) return `${base}-mega-${m[1].toLowerCase()}`;
  if (/^Mega\s+/i.test(s)) return `${base}-mega`;
  if (/^Alolan\s+/i.test(s)) return `${base}-alola`;
  if (/^Galarian\s+/i.test(s)) return `${base}-galar`;
  if (/^Hisuian\s+/i.test(s)) return `${base}-hisui`;
  if ((m = s.match(/^Paldean\s+.+?\s+(\w+)$/i))) return `${base}-paldea-${toId(m[1])}-breed`;
  if (/^Paldean\s+/i.test(s)) return `${base}-paldea`;

  const speciesTitle = titleCase(base);
  if (s.toLowerCase().startsWith(speciesTitle.toLowerCase())) {
    const suffix = s.slice(speciesTitle.length).trim();
    if (!suffix) return base;
    if (/^female$/i.test(suffix)) return `${base}-female`;
    if (/^(male|shield|average)$/i.test(suffix)) return base;
    return `${base}-${toId(suffix)}`;
  }
  return base;
}

// True for anything this module has an opinion on — i.e. anywhere
// championsbattledata's own metadata should be treated as untrustworthy
// and overridden with the conventions above.
export function isSpecialForm(chaosKey){
  return matchSpecialForm(chaosKey) !== null
    || /^(.+?)-?(megax|megay|megaz|mega|alola|galar|hisui)$/i.test(chaosKey.toLowerCase());
}
