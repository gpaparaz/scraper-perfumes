/**
   * Perfume DB import.
   *
   * Order:
   *   1. Premiere Peau glossary  -> canonical, rich ingredients (GLOSSARY
  ANCHORS)
   *   2. Parfumo CSV             -> perfumes + notes (AUTHORITATIVE) + accords
   *   3. Fragrantica CSV         -> merge/fill perfumes, accords, notes
  fallback, image
   *   3b. brand dedup            -> merge duplicate brands by title overlap
   *   3c. ingredient reconcile   -> Policy A: fold note variants onto the most
   *                                 specific glossary anchor, or a created
  base;
   *                                 glossary entries themselves are never
  merged
   *   4. ingredient_images.json  -> fill ingredients.image_url from the scrape
   *   4b. photo propagation      -> share one photo across a visual group
   *                                 (origin/extraction variants) even when the
   *                                 ingredients stay distinct
   *
   * Run from the repo root:   node import_datasets.js
   */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { parse } = require("csv-parse/sync");

const dbConfig = {
  user: process.env.PGUSER || "postgres",
  host: process.env.PGHOST || "localhost",
  database: process.env.PGDATABASE || "postgres",
  password: process.env.PGPASSWORD || "giorgia",
  port: parseInt(process.env.PGPORT || "5432", 10),
};

const INGREDIENT_IMAGES_FILE =
  process.env.INGREDIENT_IMAGES_FILE || "ingredient_images.json";
const UNMATCHED_INGREDIENT_IMAGES_FILE = "unmatched_ingredient_images.csv";

// =====================================================================
//  Alias / dedup configuration
// =====================================================================

const INGREDIENT_ALIASES = {
  cedar: "Cedarwood",
  cedarwood: "Cedarwood",
  agarwood: "Oud",
  "agarwood oud": "Oud",
  oud: "Oud",
};

const ACCORD_ALIASES = {
  leathery: "leather",
  animal: "animalic",
};

const BRAND_ALIASES = {
  // "yves saint laurent": "YSL",
};

const BRAND_SUFFIXES = [
  "arts perfume",
  "perfumes",
  "perfume",
  "parfums",
  "parfum",
  "fragrances",
  "fragrance",
  "cosmetics",
];

const BRAND_MERGE_MIN_SHARED_TITLES = 4;

// Qualifier tokens for INGREDIENT reconciliation and photo grouping.
// These denote origin or extraction method, NOT a different material, so
// they are safe to strip. Words that change identity (water, milk, blossom,
// leaf, wood, pink, black, sea, smoked, green, salted, ...) are deliberately
// NOT here, so "Coconut Water" != "Coconut", "Pink Pepper" != "Pepper".
const GEO_QUALIFIERS = [
  "african",
  "sicilian",
  "calabrian",
  "amalfi",
  "egyptian",
  "indian",
  "turkish",
  "bulgarian",
  "moroccan",
  "italian",
  "french",
  "spanish",
  "australian",
  "virginia",
  "virginian",
  "haitian",
  "madagascan",
  "madagascar",
  "somali",
  "chinese",
  "russian",
  "brazilian",
  "guatemalan",
  "ceylon",
  "tahitian",
  "indonesian",
  "javanese",
  "arabian",
  "persian",
  "mexican",
  "japanese",
  "korean",
  "tunisian",
  "greek",
  "portuguese",
  "texas",
  "bourbon",
  "ugandan",
  "dominican",
  "polynesian",
  "comorian",
  "reunion",
  "cambodian",
  "laotian",
  "atlas",
  "peruvian",
  "colombian",
  "paraguayan",
  "american",
  "californian",
];
const EXTRACT_QUALIFIERS = [
  "absolute",
  "absolue",
  "concrete",
  "co2",
  "oil",
  "essence",
  "essential",
  "extract",
  "orpur",
  "tincture",
  "resinoid",
  "resin",
];
const QUAL = new Set([...GEO_QUALIFIERS, ...EXTRACT_QUALIFIERS]);

// =====================================================================
//  Normalization / small helpers
// =====================================================================

function normalize(str) {
  if (!str) return "";
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[®™©]/g, "")
    .toLowerCase()
    .replace(/[\-_/.,()\[\]&'’‘`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMissing(v) {
  if (v === undefined || v === null) return true;
  const t = String(v).trim();
  return t === "" || t.toUpperCase() === "NA";
}

function canonicalizeBrand(rawName) {
  let display = String(rawName).split("/")[0].trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of BRAND_SUFFIXES) {
      const re = new RegExp("\\s+" + s.replace(/ /g, "\\s+") + "\\s*$", "i");
      if (re.test(display)) {
        display = display.replace(re, "").trim();
        changed = true;
      }
    }
  }
  return display;
}

// Fully-stripped form (all qualifiers removed) - used for the VISUAL photo group.
function aggressiveCanonical(norm) {
  const core = norm.split(" ").filter((t) => t && !QUAL.has(t));
  return core.length ? core.join(" ") : norm;
}

// Choose where a note-only ingredient should go (Policy A):
//  - most specific glossary anchor reachable by removing only qualifiers;
//  - else a canonical base (core tokens);
//  - else keep as-is.
// anchorSets: Map sortedTokenKey -> { id }.
function chooseIngredientTarget(noteNorm, anchorSets) {
  const tokens = noteNorm.split(" ").filter(Boolean);
  const core = tokens.filter((t) => !QUAL.has(t));
  const quals = tokens.filter((t) => QUAL.has(t));
  if (core.length === 0) return { type: "keep" };

  let best = null;
  const n = quals.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const setTokens = core.slice();
    for (let i = 0; i < n; i++) if (mask & (1 << i)) setTokens.push(quals[i]);
    const key = [...new Set(setTokens)].sort().join(" ");
    const anchor = anchorSets.get(key);
    if (anchor && (!best || setTokens.length > best.size)) {
      best = { id: anchor.id, size: setTokens.length };
    }
  }
  if (best) return { type: "anchor", id: best.id };

  const baseNorm = core.join(" ");
  if (baseNorm === noteNorm) return { type: "keep" };
  return { type: "base", norm: baseNorm };
}

// =====================================================================
//  In-memory caches
// =====================================================================
const brandCache = new Map();
const ingredientCache = new Map();
const accordCache = new Map();
const perfumesWithNotes = new Set();

const stats = {
  ingredientsGlossary: 0,
  ingredientsTotal: 0,
  accords: 0,
  brands: 0,
  perfumesParfumo: 0,
  perfumesFragrantica: 0,
  perfumesMerged: 0,
  notes: 0,
  fragranticaNoNotes: 0,
  parfumoErrors: 0,
  fragranticaErrors: 0,
  perfumeImagesFilled: 0,
  ingredientImagesMatched: 0,
  ingredientImagesUnmatched: 0,
  brandsMerged: 0,
  ingredientsMergedAnchor: 0,
  ingredientsMergedBase: 0,
  ingredientPhotosPropagated: 0,
};

// =====================================================================
//  Dimension resolvers
// =====================================================================

async function getBrandId(client, rawName) {
  let cleaned = isMissing(rawName) ? "Unknown" : canonicalizeBrand(rawName);
  if (!cleaned) cleaned = String(rawName).trim() || "Unknown";
  let norm = normalize(cleaned);
  const aliasTarget = BRAND_ALIASES[normalize(rawName)] || BRAND_ALIASES[norm];
  const display = aliasTarget || cleaned;
  if (aliasTarget) norm = normalize(aliasTarget);
  if (!norm) norm = "unknown";
  if (brandCache.has(norm)) return brandCache.get(norm);
  const res = await client.query(
    `INSERT INTO brands (name, name_normalized) VALUES ($1, $2)
         ON CONFLICT (name_normalized) DO UPDATE SET name = brands.name
         RETURNING id`,
    [display, norm]
  );
  const id = res.rows[0].id;
  brandCache.set(norm, id);
  stats.brands = brandCache.size;
  return id;
}

async function resolveIngredientId(client, rawName) {
  if (isMissing(rawName)) return null;
  const rawNorm = normalize(rawName);
  if (!rawNorm) return null;

  const aliasTarget = INGREDIENT_ALIASES[rawNorm];
  const display = aliasTarget || rawName.trim();
  const norm = aliasTarget ? normalize(aliasTarget) : rawNorm;

  let id;
  if (ingredientCache.has(norm)) {
    id = ingredientCache.get(norm);
  } else {
    const res = await client.query(
      `INSERT INTO ingredients (name, name_normalized) VALUES ($1, $2)
           ON CONFLICT (name_normalized) DO UPDATE SET name = ingredients.name
           RETURNING id`,
      [display, norm]
    );
    id = res.rows[0].id;
    ingredientCache.set(norm, id);
    stats.ingredientsTotal = ingredientCache.size;
  }

  await client.query(
    `INSERT INTO ingredient_aliases (alias_normalized, ingredient_id) VALUES
  ($1, $2)
         ON CONFLICT (alias_normalized) DO NOTHING`,
    [norm, id]
  );
  if (rawNorm !== norm) {
    await client.query(
      `INSERT INTO ingredient_aliases (alias_normalized, ingredient_id) VALUES
  ($1, $2)
           ON CONFLICT (alias_normalized) DO NOTHING`,
      [rawNorm, id]
    );
  }
  return id;
}

async function resolveAccordId(client, rawName) {
  if (isMissing(rawName)) return null;
  const rawNorm = normalize(rawName);
  if (!rawNorm) return null;
  const aliasTarget = ACCORD_ALIASES[rawNorm];
  const norm = aliasTarget ? normalize(aliasTarget) : rawNorm;
  const display = aliasTarget || rawName.trim();
  if (accordCache.has(norm)) return accordCache.get(norm);
  const res = await client.query(
    `INSERT INTO accords (name, name_normalized) VALUES ($1, $2)
         ON CONFLICT (name_normalized) DO UPDATE SET name = accords.name
         RETURNING id`,
    [display, norm]
  );
  const id = res.rows[0].id;
  accordCache.set(norm, id);
  stats.accords = accordCache.size;
  return id;
}

// =====================================================================
//  Fact writers
// =====================================================================

async function upsertPerfume(
  client,
  brandId,
  title,
  { description, releaseYear, perfumer, imageUrl }
) {
  const cleanTitle = title.trim();
  const titleNorm = normalize(cleanTitle);
  const res = await client.query(
    `INSERT INTO perfumes (brand_id, title, title_normalized, description,
  release_year, perfumer, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (brand_id, title_normalized) DO UPDATE SET
            description  = COALESCE(perfumes.description,
  EXCLUDED.description),
            release_year = COALESCE(perfumes.release_year,
  EXCLUDED.release_year),
            perfumer     = COALESCE(perfumes.perfumer,     EXCLUDED.perfumer),
            image_url    = COALESCE(perfumes.image_url,    EXCLUDED.image_url)
         RETURNING id, (xmax <> 0) AS existed`,
    [
      brandId,
      cleanTitle,
      titleNorm,
      description ?? null,
      releaseYear ?? null,
      perfumer ?? null,
      imageUrl ?? null,
    ]
  );
  const row = res.rows[0];
  if (row.existed) stats.perfumesMerged++;
  if (imageUrl) stats.perfumeImagesFilled++;
  return row.id;
}

async function addNote(client, perfumeId, rawNote, layer) {
  const ingredientId = await resolveIngredientId(client, rawNote);
  if (!ingredientId) return false;
  await client.query(
    `INSERT INTO perfume_notes (perfume_id, ingredient_id, layer) VALUES ($1,
  $2, $3)
         ON CONFLICT (perfume_id, ingredient_id, layer) DO NOTHING`,
    [perfumeId, ingredientId, layer]
  );
  stats.notes++;
  perfumesWithNotes.add(perfumeId);
  return true;
}

async function addAccord(client, perfumeId, rawAccord, rank) {
  const accordId = await resolveAccordId(client, rawAccord);
  if (!accordId) return;
  await client.query(
    `INSERT INTO perfume_accords (perfume_id, accord_id, rank) VALUES ($1, $2,
  $3)
         ON CONFLICT (perfume_id, accord_id) DO UPDATE
            SET rank = LEAST(perfume_accords.rank, EXCLUDED.rank)`,
    [perfumeId, accordId, rank]
  );
}

// =====================================================================
//  Parsers
// =====================================================================

function cleanFragranticaTitle(rawName, brandName, gender) {
  let t = rawName.trim();
  const b = (brandName || "").trim();
  const g = (gender || "").trim();
  if (b && g) {
    const re = new RegExp(escapeRe(b) + "\\s*" + escapeRe(g) + "\\s*$", "i");
    const stripped = t.replace(re, "").trim();
    if (stripped) t = stripped;
  }
  if (g)
    t = t.replace(new RegExp("\\s*" + escapeRe(g) + "\\s*$", "i"), "").trim();
  if (b)
    t = t.replace(new RegExp("\\s*" + escapeRe(b) + "\\s*$", "i"), "").trim();
  return t || rawName.trim();
}

function extractBrandFromFragranticaUrl(url) {
  if (!url) return "Unknown";
  const m = url.match(/\/perfume\/([^/]+)\//);
  return m && m[1] ? m[1].replace(/-/g, " ").trim() : "Unknown";
}

function extractFragranticaImage(url) {
  if (!url) return null;
  const m = url.match(/-(\d+)\.html\s*$/);
  if (!m) return null;
  return `https://fimgs.net/mdimg/perfume-thumbs/375x500.${m[1]}.jpg`;
}

function parseFragranticaNotes(description) {
  const out = { top: [], heart: [], base: [] };
  if (!description) return out;
  const grab = (re) => {
    const m = description.match(re);
    if (!m) return [];
    return m[1]
      .split(".")[0]
      .split(/,\s*|\s+and\s+/i)
      .map((n) => n.trim())
      .filter(Boolean);
  };
  out.top = grab(/Top notes are ([^;]+)/i);
  out.heart = grab(/middle notes are ([^;]+)/i);
  out.base = grab(/base notes are ([^;]+)/i);
  return out;
}

function parseFragranticaAccords(str) {
  if (!str) return [];
  try {
    return JSON.parse(str.replace(/'/g, '"'))
      .map((x) => String(x).trim())
      .filter(Boolean);
  } catch {
    return str
      .replace(/[\[\]']/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

// =====================================================================
//  Stages 1-3
// =====================================================================

async function importGlossary(client) {
  console.log("\n1/4  Glossario Premiere Peau ...");
  const ppData = JSON.parse(
    fs.readFileSync("premiere-peau-en-merged.json", "utf8")
  );

  for (const item of ppData) {
    try {
      if (!item.term) continue;
      const tc = item.technical_card || {};
      const evo = item.evolution || {};
      const display = item.term.trim();
      const norm = normalize(display);
      if (!norm) continue;

      const botanical =
        tc.Botanical && !/^\s*n\/?a\b/i.test(tc.Botanical)
          ? tc.Botanical
          : null;

      const res = await client.query(
        `INSERT INTO ingredients (
                name, name_normalized, category, subcategory, short_description,
  botanical_name,
                appearance, odor_strength, producing_countries,
  typical_volatility,
                evolution_immediate, evolution_after_hours,
  evolution_after_days,
                full_extracted_text, source_url, from_glossary
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE)
             ON CONFLICT (name_normalized) DO UPDATE SET
                category              = COALESCE(EXCLUDED.category,
  ingredients.category),
                subcategory           = COALESCE(EXCLUDED.subcategory,
  ingredients.subcategory),
                short_description     = COALESCE(EXCLUDED.short_description,
  ingredients.short_description),
                botanical_name        = COALESCE(EXCLUDED.botanical_name,
  ingredients.botanical_name),
                appearance            = COALESCE(EXCLUDED.appearance,
  ingredients.appearance),
                odor_strength         = COALESCE(EXCLUDED.odor_strength,
  ingredients.odor_strength),
                producing_countries   = COALESCE(EXCLUDED.producing_countries,
  ingredients.producing_countries),
                typical_volatility    = COALESCE(EXCLUDED.typical_volatility,
  ingredients.typical_volatility),
                evolution_immediate   = COALESCE(EXCLUDED.evolution_immediate,
  ingredients.evolution_immediate),
                evolution_after_hours = COALESCE(EXCLUDED.evolution_after_hours,
  ingredients.evolution_after_hours),
                evolution_after_days  = COALESCE(EXCLUDED.evolution_after_days,
  ingredients.evolution_after_days),
                full_extracted_text   = COALESCE(EXCLUDED.full_extracted_text,
  ingredients.full_extracted_text),
                source_url            = COALESCE(EXCLUDED.source_url,
  ingredients.source_url),
                from_glossary         = TRUE
             RETURNING id`,
        [
          display,
          norm,
          tc.Category ||
            (item.category ? item.category.split("/")[0].trim() : null) ||
            null,
          tc.Subcategory ||
            (item.category
              ? (item.category.split("/")[1] || "").trim()
              : null) ||
            null,
          item.short_description || null,
          botanical,
          tc.Appearance || null,
          tc["Odor Strength"] || null,
          tc["Producing Countries"] || null,
          tc.Volatility || null,
          evo.Immediately || null,
          evo["After a few hours"] || null,
          evo["After a few days"] || null,
          item.extracted_text_body || null,
          item.url || null,
        ]
      );
      const id = res.rows[0].id;
      ingredientCache.set(norm, id);
      await client.query(
        `INSERT INTO ingredient_aliases (alias_normalized, ingredient_id)
  VALUES ($1, $2)
             ON CONFLICT (alias_normalized) DO NOTHING`,
        [norm, id]
      );
      stats.ingredientsGlossary++;
    } catch (e) {
      console.error(`Voce glossario scartata (${item && item.term}):
  ${e.message}`);
    }
  }
  stats.ingredientsTotal = ingredientCache.size;
  console.log(`     ${stats.ingredientsGlossary} ingredienti dal glossario.`);
}

async function importParfumo(client) {
  console.log("\n2/4  Parfumo (fonte primaria delle note) ...");
  const records = parse(fs.readFileSync("parfumo_data_clean.csv", "utf8"), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });
  console.log(`     ${records.length} righe lette dal CSV.`);

  for (const [i, r] of records.entries()) {
    try {
      if (isMissing(r.Name)) continue;
      const brandId = await getBrandId(client, r.Brand);
      let year = parseInt(r.Release_Year, 10);
      if (Number.isNaN(year)) year = null;

      const perfumeId = await upsertPerfume(client, brandId, r.Name, {
        releaseYear: year,
        perfumer: isMissing(r.Perfumers) ? null : r.Perfumers.trim(),
      });

      for (const [col, layer] of [
        ["Top_Notes", "top"],
        ["Middle_Notes", "heart"],
        ["Base_Notes", "base"],
      ]) {
        if (isMissing(r[col])) continue;
        for (const note of r[col]
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)) {
          await addNote(client, perfumeId, note, layer);
        }
      }

      if (!isMissing(r.Main_Accords)) {
        const accords = r.Main_Accords.split(",")
          .map((a) => a.trim())
          .filter(Boolean);
        for (let j = 0; j < accords.length; j++)
          await addAccord(client, perfumeId, accords[j], j + 1);
      }
      stats.perfumesParfumo++;
    } catch (e) {
      stats.parfumoErrors++;
      console.error(`Riga Parfumo #${i} (${r.Name}) scartata: ${e.message}`);
    }
  }
  console.log(`     ${stats.perfumesParfumo} profumi importati,
  ${stats.parfumoErrors} righe scartate.`);
}

async function importFragrantica(client) {
  console.log("\n3/4  Fragrantica (merge + fallback note + accordi + foto)...");
  const records = parse(fs.readFileSync("fra_perfumes.csv", "utf8"), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });
  console.log(`     ${records.length} righe lette dal CSV.`);

  for (const [i, r] of records.entries()) {
    try {
      if (isMissing(r.Name)) continue;
      const brandName = extractBrandFromFragranticaUrl(r.url);
      const brandId = await getBrandId(client, brandName);
      const title = cleanFragranticaTitle(r.Name, brandName, r.Gender);
      const imageUrl = extractFragranticaImage(r.url);

      const perfumeId = await upsertPerfume(client, brandId, title, {
        description: isMissing(r.Description) ? null : r.Description.trim(),
        imageUrl,
      });

      if (!perfumesWithNotes.has(perfumeId)) {
        const notes = parseFragranticaNotes(r.Description);
        const total = notes.top.length + notes.heart.length + notes.base.length;
        if (total === 0) {
          stats.fragranticaNoNotes++;
        } else {
          for (const n of notes.top) await addNote(client, perfumeId, n, "top");
          for (const n of notes.heart)
            await addNote(client, perfumeId, n, "heart");
          for (const n of notes.base)
            await addNote(client, perfumeId, n, "base");
        }
      }

      const accords = parseFragranticaAccords(r["Main Accords"]);
      for (let j = 0; j < accords.length; j++)
        await addAccord(client, perfumeId, accords[j], j + 1);

      stats.perfumesFragrantica++;
    } catch (e) {
      stats.fragranticaErrors++;
      console.error(`Riga Fragrantica #${i} (${r.Name}) scartata:
  ${e.message}`);
    }
  }
  console.log(
    `     ${stats.perfumesFragrantica} righe importate ` +
      `(${stats.fragranticaNoNotes} senza note estraibili,
  ${stats.fragranticaErrors} scartate per errore).`
  );
}

// =====================================================================
//  Brand dedup by title overlap
// =====================================================================

async function mergeBrandInto(client, keepId, dropId) {
  await client.query(
    `INSERT INTO perfume_notes (perfume_id, ingredient_id, layer)
       SELECT pa.id, pn.ingredient_id, pn.layer
         FROM perfumes pb
         JOIN perfumes pa ON pa.brand_id = $1 AND pa.title_normalized =
  pb.title_normalized
         JOIN perfume_notes pn ON pn.perfume_id = pb.id
        WHERE pb.brand_id = $2
       ON CONFLICT (perfume_id, ingredient_id, layer) DO NOTHING`,
    [keepId, dropId]
  );
  await client.query(
    `INSERT INTO perfume_accords (perfume_id, accord_id, rank)
       SELECT pa.id, pac.accord_id, pac.rank
         FROM perfumes pb
         JOIN perfumes pa ON pa.brand_id = $1 AND pa.title_normalized =
  pb.title_normalized
         JOIN perfume_accords pac ON pac.perfume_id = pb.id
        WHERE pb.brand_id = $2
       ON CONFLICT (perfume_id, accord_id) DO UPDATE
          SET rank = LEAST(perfume_accords.rank, EXCLUDED.rank)`,
    [keepId, dropId]
  );
  await client.query(
    `UPDATE perfumes pa SET
          description  = COALESCE(pa.description,  pb.description),
          release_year = COALESCE(pa.release_year, pb.release_year),
          perfumer     = COALESCE(pa.perfumer,     pb.perfumer),
          image_url    = COALESCE(pa.image_url,    pb.image_url)
         FROM perfumes pb
        WHERE pa.brand_id = $1 AND pb.brand_id = $2
          AND pa.title_normalized = pb.title_normalized`,
    [keepId, dropId]
  );
  await client.query(
    `DELETE FROM perfumes pb
        WHERE pb.brand_id = $2
          AND EXISTS (SELECT 1 FROM perfumes pa
                       WHERE pa.brand_id = $1 AND pa.title_normalized =
  pb.title_normalized)`,
    [keepId, dropId]
  );
  await client.query(`UPDATE perfumes SET brand_id = $1 WHERE brand_id = $2`, [
    keepId,
    dropId,
  ]);
  await client.query(`DELETE FROM brands WHERE id = $2`, [dropId]);
}

async function mergeDuplicateBrands(client) {
  console.log("\n3b/4  Dedup brand per overlap di titoli ...");
  await client.query(`CREATE INDEX IF NOT EXISTS idx_perfumes_title_norm ON
  perfumes(title_normalized)`);

  const { rows: pairs } = await client.query(
    `SELECT ba.id AS a_id, ba.name AS a_name, ba.name_normalized AS a_norm,
              bb.id AS b_id, bb.name AS b_name, bb.name_normalized AS b_norm,
              count(*)::int AS shared,
              similarity(ba.name_normalized, bb.name_normalized) AS sim
         FROM perfumes p1
         JOIN perfumes p2 ON p1.title_normalized = p2.title_normalized AND
  p1.brand_id < p2.brand_id
         JOIN brands ba ON ba.id = p1.brand_id
         JOIN brands bb ON bb.id = p2.brand_id
        GROUP BY ba.id, ba.name, ba.name_normalized, bb.id, bb.name,
  bb.name_normalized
       HAVING count(*) >= $1`,
    [BRAND_MERGE_MIN_SHARED_TITLES]
  );

  const related = (a, b) => {
    const ta = a.split(" ").filter(Boolean),
      tb = b.split("").filter(Boolean);
    const sa = new Set(ta),
      sb = new Set(tb);
    const subset = ta.every((t) => sb.has(t)) || tb.every((t) => sa.has(t));
    return subset || a.includes(b) || b.includes(a);
  };
  const confirmed = pairs.filter(
    (p) => Number(p.sim) >= 0.45 || related(p.a_norm, p.b_norm)
  );

  const nameById = new Map();
  for (const p of pairs) {
    nameById.set(String(p.a_id), p.a_name);
    nameById.set(String(p.b_id), p.b_name);
  }

  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const p of confirmed) {
    if (!parent.has(p.a_id)) parent.set(p.a_id, p.a_id);
    if (!parent.has(p.b_id)) parent.set(p.b_id, p.b_id);
    parent.set(find(p.a_id), find(p.b_id));
  }
  const groups = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }

  let mergedCount = 0,
    groupCount = 0;
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    groupCount++;
    const { rows: counts } = await client.query(
      `SELECT brand_id, count(*)::int AS n FROM perfumes WHERE brand_id =
  ANY($1::bigint[]) GROUP BY brand_id`,
      [ids]
    );
    const cnt = new Map(counts.map((r) => [String(r.brand_id), r.n]));
    ids.sort((x, y) => (cnt.get(String(y)) || 0) - (cnt.get(String(x)) || 0));
    const keep = ids[0];
    for (const drop of ids.slice(1)) {
      await mergeBrandInto(client, keep, drop);
      console.log(`     fuso "${nameById.get(String(drop))}"  ->
  "${nameById.get(String(keep))}"`);
      mergedCount++;
    }
  }
  stats.brandsMerged = mergedCount;
  console.log(`     ${confirmed.length} coppie confermate, ${mergedCount}
  brand fusi in ${groupCount} gruppi.`);
}

// =====================================================================
//  Ingredient reconciliation (Policy A) + photo propagation
// =====================================================================

async function mergeIngredientInto(client, keepId, dropId) {
  if (String(keepId) === String(dropId)) return;
  await client.query(
    `INSERT INTO perfume_notes (perfume_id, ingredient_id, layer)
       SELECT perfume_id, $1, layer FROM perfume_notes WHERE ingredient_id = $2
       ON CONFLICT (perfume_id, ingredient_id, layer) DO NOTHING`,
    [keepId, dropId]
  );
  await client.query(
    `UPDATE ingredient_aliases SET ingredient_id = $1 WHERE ingredient_id =
  $2`,
    [keepId, dropId]
  );
  await client.query(
    `UPDATE ingredients k SET
          category              = COALESCE(k.category, d.category),
          subcategory           = COALESCE(k.subcategory, d.subcategory),
          short_description     = COALESCE(k.short_description,
  d.short_description),
          botanical_name        = COALESCE(k.botanical_name, d.botanical_name),
          appearance            = COALESCE(k.appearance, d.appearance),
          odor_strength         = COALESCE(k.odor_strength, d.odor_strength),
          producing_countries   = COALESCE(k.producing_countries,
  d.producing_countries),
          typical_volatility    = COALESCE(k.typical_volatility,
  d.typical_volatility),
          evolution_immediate   = COALESCE(k.evolution_immediate,
  d.evolution_immediate),
          evolution_after_hours = COALESCE(k.evolution_after_hours,
  d.evolution_after_hours),
          evolution_after_days  = COALESCE(k.evolution_after_days,
  d.evolution_after_days),
          full_extracted_text   = COALESCE(k.full_extracted_text,
  d.full_extracted_text),
          source_url            = COALESCE(k.source_url, d.source_url),
          image_url             = COALESCE(k.image_url, d.image_url),
          from_glossary         = k.from_glossary OR d.from_glossary
         FROM ingredients d
        WHERE k.id = $1 AND d.id = $2`,
    [keepId, dropId]
  );
  await client.query(`DELETE FROM ingredients WHERE id = $2`, [dropId]);
}

async function reconcileIngredients(client) {
  console.log("\n3c/4  Riconciliazione ingredienti (Policy A) ...");
  const { rows } = await client.query(
    `SELECT id, name_normalized, from_glossary FROM ingredients`
  );

  // Glossary anchors indexed by their sorted token set; never merged.
  const anchorSets = new Map(); // sortedKey -> { id }
  const idByNorm = new Map(); // norm -> id
  for (const r of rows) {
    idByNorm.set(r.name_normalized, r.id);
    if (r.from_glossary) {
      const key = [...new Set(r.name_normalized.split("").filter(Boolean))]
        .sort()
        .join(" ");
      if (!anchorSets.has(key)) anchorSets.set(key, { id: r.id });
    }
  }

  for (const r of rows) {
    if (r.from_glossary) continue; // anchors stay put
    const t = chooseIngredientTarget(r.name_normalized, anchorSets);
    if (t.type === "keep") continue;

    if (t.type === "anchor") {
      if (String(t.id) !== String(r.id)) {
        await mergeIngredientInto(client, t.id, r.id);
        stats.ingredientsMergedAnchor++;
      }
    } else if (t.type === "base") {
      let baseId = idByNorm.get(t.norm);
      if (!baseId) {
        const disp = t.norm.replace(/\b\w/g, (c) => c.toUpperCase());
        const res = await client.query(
          `INSERT INTO ingredients (name, name_normalized) VALUES ($1, $2)
             ON CONFLICT (name_normalized) DO UPDATE SET name = ingredients.name
  RETURNING id`,
          [disp, t.norm]
        );
        baseId = res.rows[0].id;
        idByNorm.set(t.norm, baseId);
        await client.query(
          `INSERT INTO ingredient_aliases (alias_normalized, ingredient_id)
  VALUES ($1, $2)
             ON CONFLICT (alias_normalized) DO NOTHING`,
          [t.norm, baseId]
        );
      }
      if (String(baseId) !== String(r.id)) {
        await mergeIngredientInto(client, baseId, r.id);
        stats.ingredientsMergedBase++;
      }
    }
  }
  console.log(
    `     ${stats.ingredientsMergedAnchor} note agganciate a voci di
  glossario, ` + `${stats.ingredientsMergedBase} fuse in basi canoniche.`
  );
}

async function propagateIngredientImages(client) {
  console.log("\n4b/4  Propagazione foto nel gruppo visivo ...");
  const { rows } = await client.query(`SELECT id, name_normalized, image_url
  FROM ingredients`);
  const groups = new Map();
  for (const r of rows) {
    const canon = aggressiveCanonical(r.name_normalized);
    if (!groups.has(canon)) groups.set(canon, []);
    groups.get(canon).push(r);
  }
  let filled = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const withImg = members.find((m) => m.image_url);
    if (!withImg) continue;
    for (const m of members) {
      if (!m.image_url) {
        await client.query(
          `UPDATE ingredients SET image_url = $1 WHERE id = $2 AND image_url
  IS NULL`,
          [withImg.image_url, m.id]
        );
        filled++;
      }
    }
  }
  stats.ingredientPhotosPropagated = filled;
  console.log(`     ${filled} foto propagate a ingredienti dello stesso gruppo
  visivo.`);
}

// =====================================================================
//  Stage 4: ingredient photos from the scrape
// =====================================================================

async function importIngredientImages(client) {
  console.log("\n4/4  Foto ingredienti (da ingredient_images.json) ...");
  if (!fs.existsSync(INGREDIENT_IMAGES_FILE)) {
    console.log(`     File ${INGREDIENT_IMAGES_FILE} non trovato, stage
  saltato.`);
    return;
  }

  const items = JSON.parse(fs.readFileSync(INGREDIENT_IMAGES_FILE, "utf8"));
  console.log(`     ${items.length} voci lette dal file scraping.`);

  const unmatched = [];
  for (const item of items) {
    try {
      if (!item || !item.name || !item.image_url) continue;
      const norm = normalize(item.name);
      if (!norm) continue;
      const res = await client.query(
        `SELECT ingredient_id FROM ingredient_aliases WHERE alias_normalized =
  $1`,
        [norm]
      );
      if (res.rows.length === 0) {
        unmatched.push(item);
        stats.ingredientImagesUnmatched++;
        continue;
      }
      await client.query(
        `UPDATE ingredients SET image_url = COALESCE(image_url, $1) WHERE id =
  $2`,
        [item.image_url, res.rows[0].ingredient_id]
      );
      stats.ingredientImagesMatched++;
    } catch (e) {
      console.error(`Voce foto ingrediente scartata (${item && item.name}):
  ${e.message}`);
    }
  }

  if (unmatched.length > 0) {
    const csv = [
      "name,image_url",
      ...unmatched.map((u) => `"${u.name.replace(/"/g, '""')}",${u.image_url}`),
    ].join("\n");
    fs.writeFileSync(UNMATCHED_INGREDIENT_IMAGES_FILE, csv, "utf8");
    console.log(`     ${unmatched.length} voci senza corrispondenza scritte in
  ${UNMATCHED_INGREDIENT_IMAGES_FILE}.`);
  }
  console.log(`     ${stats.ingredientImagesMatched} ingredienti aggiornati
  con una foto.`);
}

// =====================================================================
//  Main
// =====================================================================
async function main() {
  const client = new Client(dbConfig);
  await client.connect();
  console.log("Connesso a Postgres.");

  try {
    const schemaSql = fs.readFileSync(
      path.join(__dirname, "schema.sql"),
      "utf8"
    );
    await client.query(schemaSql);
    console.log("Schema ricreato da schema.sql.");

    // Stages 1-3, each in its own transaction.
    for (const [label, fn] of [
      ["glossario", importGlossary],
      ["parfumo", importParfumo],
      ["fragrantica", importFragrantica],
    ]) {
      await client.query("BEGIN");
      try {
        await fn(client);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(
          `Errore nello stadio "${label}", rollback dello
  stadio:`,
          e.message
        );
        throw e;
      }
    }

    // 3b) brand dedup
    await client.query("BEGIN");
    try {
      await mergeDuplicateBrands(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error('Errore nello stadio "dedup brand", rollback:', e.message);
    }

    // 3c) ingredient identity reconciliation (Policy A)
    await client.query("BEGIN");
    try {
      await reconcileIngredients(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(
        'Errore nello stadio "reconcile ingredienti", rollback:',
        e.message
      );
    }

    // 4) scraped ingredient photos
    await client.query("BEGIN");
    try {
      await importIngredientImages(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(
        'Errore nello stadio "foto ingredienti", rollback:',
        e.message
      );
    }

    // 4b) propagate one photo per visual group
    await client.query("BEGIN");
    try {
      await propagateIngredientImages(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(
        'Errore nello stadio "propagazione foto", rollback:',
        e.message
      );
    }

    // real counts after all merges
    const {
      rows: [bc],
    } = await client.query("SELECT count(*)::int AS n FROM brands");
    const {
      rows: [ic],
    } = await client.query("SELECT count(*)::int AS n FROM ingredients");
    stats.brands = bc.n;
    stats.ingredientsTotal = ic.n;

    console.log("\n===== RIEPILOGO =====");
    console.log(`Brand:                        ${stats.brands}`);
    console.log(`Ingredienti totali:           ${stats.ingredientsTotal} (di
  cui glossario: ${stats.ingredientsGlossary})`);
    console.log(`  fusi su voce glossario:
  ${stats.ingredientsMergedAnchor}`);
    console.log(`  fusi su base canonica:
  ${stats.ingredientsMergedBase}`);
    console.log(`Accordi (dimensione):         ${stats.accords}`);
    console.log(`Profumi Parfumo:              ${stats.perfumesParfumo} (righe
  scartate: ${stats.parfumoErrors})`);
    console.log(`Righe Fragrantica:            ${stats.perfumesFragrantica}
  (righe scartate: ${stats.fragranticaErrors})`);
    console.log(`Profumi fusi (già esistenti): ${stats.perfumesMerged}`);
    console.log(`Relazioni nota-profumo:       ${stats.notes}`);
    console.log(`Profumi con foto:             ${stats.perfumeImagesFilled}`);
    console.log(`Ingredienti con foto:
  ${stats.ingredientImagesMatched} (senza match:
  ${stats.ingredientImagesUnmatched})`);
    console.log(`Foto propagate nel gruppo:
  ${stats.ingredientPhotosPropagated}`);
    console.log(`Brand fusi (dedup overlap):   ${stats.brandsMerged}`);
    console.log("Import completato.");
  } catch (error) {
    console.error("Errore critico:", error);
    process.exitCode = 1;
  } finally {
    await client.end();
    console.log("Connessione chiusa.");
  }
}

main();
