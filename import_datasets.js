/**
 * Perfume DB import.
 *
 * Rebuilds the whole database from the source files, in this order:
 *   1. Premiere Peau glossary  -> canonical, rich ingredients
 *   2. Parfumo CSV             -> perfumes + notes (AUTHORITATIVE) + accords
 *   3. Fragrantica CSV         -> merges into existing perfumes, fills gaps,
 *                                 adds accords, adds notes only as a
 *                                 fallback, and fills perfume image_url
 *                                 (derived from the numeric id in the URL,
 *                                 no scraping needed for this one)
 *   4. ingredient_images.json  -> optional, produced by
 *                                 scrape_fragrantica_notes.js separately.
 *                                 Fills ingredients.image_url by matching
 *                                 against ingredient_aliases.
 *
 * Same perfume across sources is merged into ONE row via (brand, title)
 * after normalization. Ingredients/accords/brands are deduplicated by a
 * normalized key, and every surface form is recorded in ingredient_aliases
 * so search-by-note resolves any spelling to a single ingredient id.
 *
 * IMPORTANT: each stage now isolates errors PER ROW. A single malformed
 * row (bad CSV quoting, unexpected null, etc.) is logged and skipped
 * instead of throwing and rolling back the entire stage - this was the
 * most likely cause of "only 12k rows imported out of 60-70k": one
 * uncaught exception deep in a CSV used to wipe out that whole stage's
 * transaction, silently.
 *
 * Run from the repo root:   node import_datasets.js
 * DB credentials come from PG* env vars (see dbConfig).
 */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { parse } = require("csv-parse/sync");

// --- DB config: prefer env vars; the fallback is a LOCAL dev default only.
//     Do not commit real secrets. Set PGPASSWORD in your shell instead.
const dbConfig = {
  user: process.env.PGUSER || "postgres",
  host: process.env.PGHOST || "localhost",
  database: process.env.PGDATABASE || "postgres",
  password: process.env.PGPASSWORD || "giorgia",
  port: parseInt(process.env.PGPORT || "5432", 10),
};

// Optional: path to the JSON produced by scrape_fragrantica_notes.js.
// If the file doesn't exist, stage 4 is skipped with a warning (it's not
// required for stages 1-3 to work).
const INGREDIENT_IMAGES_FILE =
  process.env.INGREDIENT_IMAGES_FILE || "ingredient_images.json";
const UNMATCHED_INGREDIENT_IMAGES_FILE = "unmatched_ingredient_images.csv";

// =====================================================================
//  Alias configuration - EXTEND THESE FREELY.
//  Keys are the *normalized* surface form; values are the canonical
//  display name. Only add entries you are sure mean the same thing:
//  over-merging is worse than a couple of duplicates. For candidates you
//  are not sure about, use the pg_trgm query described alongside this
//  script to review before adding them here.
// =====================================================================

// variant (normalized) -> canonical ingredient display name
const INGREDIENT_ALIASES = {
  cedar: "Cedarwood",
  cedarwood: "Cedarwood",
  agarwood: "Oud",
  "agarwood oud": "Oud", // "Agarwood (Oud)" normalizes to "agarwood oud"
  oud: "Oud",
  // --- examples of geographic-qualifier merges: uncomment/extend if wanted ---
  // 'sicilian bergamot':  'Bergamot',
  // 'calabrian bergamot': 'Bergamot',
  // 'amalfi bergamot':    'Bergamot',
  // 'virginia cedar':     'Cedarwood',
  // 'french lavender':    'Lavender',
  // 'wild lavender':      'Lavender',
  // 'orris':              'Iris',
};

// variant (normalized) -> canonical accord display name
const ACCORD_ALIASES = {
  leathery: "leather",
  animal: "animalic",
};

// variant (normalized) -> canonical brand display name.
// Typographic duplicates (&, apostrophes, ® ™ ©) are already merged by
// normalize() above and don't need an entry here. This map is only for
// genuine "different string, same brand" cases - short house name vs a
// longer variant with "Perfumes"/"Parfums"/"Arts Perfume"/etc. appended.
// Find candidates with the containment query in the project notes rather
// than guessing; only add entries you've actually confirmed.
const BRAND_ALIASES = {
  "afnan perfumes": "Afnan",
  "aether arts perfume": "Aether",
};

// =====================================================================
//  Normalization
// =====================================================================

// Lowercase, strip diacritics, strip trademark/registered/copyright
// symbols, fold "&" and apostrophes into a plain separator, collapse
// separators/punctuation to single spaces.
// "Lily-of-the-Valley" and "Lily of the valley" both become
// "lily of the valley"; "Akigalawood®" -> "akigalawood";
// "Abercrombie & Fitch" -> "abercrombie fitch" = "Abercrombie Fitch";
// "Acqua dell'Elba" -> "acqua dell elba" = "Acqua dell Elba".
// Semantic merges (Acetylfuran = Acetyl Furan, Afnan = Afnan Perfumes)
// still need an explicit alias - normalize() only handles typography.
function normalize(str) {
  if (!str) return "";
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove diacritics
    .replace(/[®™©]/g, "") // strip trademark symbols
    .toLowerCase()
    .replace(/[\-_/.,()\[\]&'’‘`]/g, " ") // fold punctuation incl. & and apostrophes
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

// =====================================================================
//  In-memory caches (normalized key -> id) to avoid repeat lookups
// =====================================================================
const brandCache = new Map();
const ingredientCache = new Map();
const accordCache = new Map();
const perfumesWithNotes = new Set(); // perfume ids that already have notes

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
};

// =====================================================================
//  Dimension resolvers (create-or-get, cached)
// =====================================================================

async function getBrandId(client, rawName) {
  const name = isMissing(rawName) ? "Unknown" : rawName.trim();
  const rawNorm = normalize(name);
  const aliasTarget = BRAND_ALIASES[rawNorm];
  const display = aliasTarget || name;
  const norm = aliasTarget ? normalize(aliasTarget) : rawNorm;
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

// Resolve a raw note/ingredient name to a canonical ingredient id,
// applying the alias map and recording surface forms as aliases.
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

  // Record both the canonical form and the raw surface form as aliases.
  await client.query(
    `INSERT INTO ingredient_aliases (alias_normalized, ingredient_id) VALUES ($1, $2)
       ON CONFLICT (alias_normalized) DO NOTHING`,
    [norm, id]
  );
  if (rawNorm !== norm) {
    await client.query(
      `INSERT INTO ingredient_aliases (alias_normalized, ingredient_id) VALUES ($1, $2)
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
    `INSERT INTO perfumes (brand_id, title, title_normalized, description, release_year, perfumer, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (brand_id, title_normalized) DO UPDATE SET
          description  = COALESCE(perfumes.description,  EXCLUDED.description),
          release_year = COALESCE(perfumes.release_year, EXCLUDED.release_year),
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
    `INSERT INTO perfume_notes (perfume_id, ingredient_id, layer) VALUES ($1, $2, $3)
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
    `INSERT INTO perfume_accords (perfume_id, accord_id, rank) VALUES ($1, $2, $3)
       ON CONFLICT (perfume_id, accord_id) DO UPDATE
          SET rank = LEAST(perfume_accords.rank, EXCLUDED.rank)`,
    [perfumeId, accordId, rank]
  );
}

// =====================================================================
//  Parsers
// =====================================================================

// Fragrantica "Name" glues title + brand + gender, e.g. "9am Afnanfor women".
// Rebuild the clean title by stripping the trailing brand+gender.
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

// Fragrantica perfume pages end in "...-<numericId>.html". The site's own
// CDN serves thumbnails at a predictable path keyed by that same id, so we
// can derive the image URL without scraping each perfume page individually:
//   https://www.fragrantica.com/perfume/Afnan/Afzal-Abeer-27378.html
//   -> https://fimgs.net/mdimg/perfume-thumbs/375x500.27378.jpg
function extractFragranticaImage(url) {
  if (!url) return null;
  const m = url.match(/-(\d+)\.html\s*$/);
  if (!m) return null;
  return `https://fimgs.net/mdimg/perfume-thumbs/375x500.${m[1]}.jpg`;
}

// Fragrantica notes live inside the free-text Description:
// "... Top notes are X; middle notes are Y; base notes are Z."
function parseFragranticaNotes(description) {
  const out = { top: [], heart: [], base: [] };
  if (!description) return out;
  const grab = (re) => {
    const m = description.match(re);
    if (!m) return [];
    return m[1]
      .split(".")[0] // stop at the sentence end
      .split(/,\s*|\s+and\s+/i)
      .map((n) => n.trim())
      .filter(Boolean);
  };
  out.top = grab(/Top notes are ([^;]+)/i);
  out.heart = grab(/middle notes are ([^;]+)/i);
  out.base = grab(/base notes are ([^;]+)/i);
  return out;
}

// Fragrantica "Main Accords" is a python-list string: "['citrus', 'woody']"
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
//  Stages
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
              name, name_normalized, category, subcategory, short_description, botanical_name,
              appearance, odor_strength, producing_countries, typical_volatility,
              evolution_immediate, evolution_after_hours, evolution_after_days,
              full_extracted_text, source_url, from_glossary
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE)
           ON CONFLICT (name_normalized) DO UPDATE SET
              category              = COALESCE(EXCLUDED.category, ingredients.category),
              subcategory           = COALESCE(EXCLUDED.subcategory, ingredients.subcategory),
              short_description     = COALESCE(EXCLUDED.short_description, ingredients.short_description),
              botanical_name        = COALESCE(EXCLUDED.botanical_name, ingredients.botanical_name),
              appearance            = COALESCE(EXCLUDED.appearance, ingredients.appearance),
              odor_strength         = COALESCE(EXCLUDED.odor_strength, ingredients.odor_strength),
              producing_countries   = COALESCE(EXCLUDED.producing_countries, ingredients.producing_countries),
              typical_volatility    = COALESCE(EXCLUDED.typical_volatility, ingredients.typical_volatility),
              evolution_immediate   = COALESCE(EXCLUDED.evolution_immediate, ingredients.evolution_immediate),
              evolution_after_hours = COALESCE(EXCLUDED.evolution_after_hours, ingredients.evolution_after_hours),
              evolution_after_days  = COALESCE(EXCLUDED.evolution_after_days, ingredients.evolution_after_days),
              full_extracted_text   = COALESCE(EXCLUDED.full_extracted_text, ingredients.full_extracted_text),
              source_url            = COALESCE(EXCLUDED.source_url, ingredients.source_url),
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
        `INSERT INTO ingredient_aliases (alias_normalized, ingredient_id) VALUES ($1, $2)
           ON CONFLICT (alias_normalized) DO NOTHING`,
        [norm, id]
      );
      stats.ingredientsGlossary++;
    } catch (e) {
      console.error(
        `Voce glossario scartata (${item && item.term}): ${e.message}`
      );
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
  console.log(
    `     ${stats.perfumesParfumo} profumi importati, ${stats.parfumoErrors} righe scartate.`
  );
}

async function importFragrantica(client) {
  console.log(
    "\n3/4  Fragrantica (merge + fallback note + accordi + foto) ..."
  );
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

      // Notes only if this perfume still has none (Parfumo is authoritative).
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
      console.error(
        `Riga Fragrantica #${i} (${r.Name}) scartata: ${e.message}`
      );
    }
  }
  console.log(
    `     ${stats.perfumesFragrantica} righe importate ` +
      `(${stats.fragranticaNoNotes} senza note estraibili, ${stats.fragranticaErrors} scartate per errore).`
  );
}

// Stage 4: enrich ingredients.image_url from the JSON produced by
// scrape_fragrantica_notes.js. Matching goes through ingredient_aliases,
// so it works regardless of which exact spelling the scraper found.
// Anything that doesn't match an existing alias is written to a CSV for
// manual review instead of silently creating a new ingredient row - a
// scraped note name could be a typo, a new alias, or genuinely a note
// your dataset never saw, and those need different treatment.
async function importIngredientImages(client) {
  console.log("\n4/4  Foto ingredienti (da ingredient_images.json) ...");
  if (!fs.existsSync(INGREDIENT_IMAGES_FILE)) {
    console.log(
      `     File ${INGREDIENT_IMAGES_FILE} non trovato, stage saltato.`
    );
    console.log(
      "     Genera questo file con scrape_fragrantica_notes.js quando vuoi popolare le foto."
    );
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
        `SELECT ingredient_id FROM ingredient_aliases WHERE alias_normalized = $1`,
        [norm]
      );
      if (res.rows.length === 0) {
        unmatched.push(item);
        stats.ingredientImagesUnmatched++;
        continue;
      }
      await client.query(
        `UPDATE ingredients SET image_url = COALESCE(image_url, $1) WHERE id = $2`,
        [item.image_url, res.rows[0].ingredient_id]
      );
      stats.ingredientImagesMatched++;
    } catch (e) {
      console.error(
        `Voce foto ingrediente scartata (${item && item.name}): ${e.message}`
      );
    }
  }

  if (unmatched.length > 0) {
    const csv = [
      "name,image_url",
      ...unmatched.map((u) => `"${u.name.replace(/"/g, '""')}",${u.image_url}`),
    ].join("\n");
    fs.writeFileSync(UNMATCHED_INGREDIENT_IMAGES_FILE, csv, "utf8");
    console.log(
      `     ${unmatched.length} voci senza corrispondenza scritte in ${UNMATCHED_INGREDIENT_IMAGES_FILE} per revisione manuale.`
    );
  }
  console.log(
    `     ${stats.ingredientImagesMatched} ingredienti aggiornati con una foto.`
  );
}

// =====================================================================
//  Main
// =====================================================================
async function main() {
  const client = new Client(dbConfig);
  await client.connect();
  console.log("Connesso a Postgres.");

  try {
    // 1) Rebuild schema from the authoritative DDL (drop + create).
    const schemaSql = fs.readFileSync(
      path.join(__dirname, "schema.sql"),
      "utf8"
    );
    await client.query(schemaSql);
    console.log("Schema ricreato da schema.sql.");

    // 2) Import stages 1-3 each in its own transaction (per-row error
    //    handling inside each stage means a bad row no longer costs you
    //    the whole stage - see importParfumo / importFragrantica above).
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
          `Errore nello stadio "${label}", rollback dello stadio:`,
          e.message
        );
        throw e;
      }
    }

    // 3) Ingredient photo enrichment - separate, optional, own transaction.
    //    Kept outside the loop above on purpose: it's not required for the
    //    core dataset and shouldn't block/rollback if scrape output is
    //    missing or partially malformed.
    await client.query("BEGIN");
    try {
      await importIngredientImages(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(
        'Errore nello stadio "foto ingredienti", rollback dello stadio:',
        e.message
      );
    }

    console.log("\n===== RIEPILOGO =====");
    console.log(`Brand:                        ${stats.brands}`);
    console.log(
      `Ingredienti totali:           ${stats.ingredientsTotal} (di cui glossario: ${stats.ingredientsGlossary})`
    );
    console.log(`Accordi (dimensione):         ${stats.accords}`);
    console.log(
      `Profumi Parfumo:              ${stats.perfumesParfumo} (righe scartate: ${stats.parfumoErrors})`
    );
    console.log(
      `Righe Fragrantica:            ${stats.perfumesFragrantica} (righe scartate: ${stats.fragranticaErrors})`
    );
    console.log(`Profumi fusi (già esistenti): ${stats.perfumesMerged}`);
    console.log(`Relazioni nota-profumo:       ${stats.notes}`);
    console.log(`Profumi con foto:             ${stats.perfumeImagesFilled}`);
    console.log(
      `Ingredienti con foto:         ${stats.ingredientImagesMatched} (senza match: ${stats.ingredientImagesUnmatched})`
    );
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
