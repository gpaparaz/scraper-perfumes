/**
 * scrape_fragrantica_designers.js
 *
 * Unlike scrape_fragrantica_notes.js, this does NOT crawl the paginated/
 * filtered https://www.fragrantica.com/designers/ index. Instead it reuses
 * the brand slugs already present in fra_perfumes.csv (the same ones
 * import_datasets.js turns into brand names via extractBrandFromFragranticaUrl),
 * and hits each brand's own designer page directly:
 *
 *   .../perfume/Al-Haramain-Perfumes/... (from the CSV)
 *   -> https://www.fragrantica.com/designers/Al-Haramain-Perfumes.html
 *
 * That page embeds the brand name + logo like this (confirmed markup):
 *   <p itemprop="brand" itemtype="http://schema.org/Brand" itemscope
 *      class="mb-4 ml-6">
 *     <a itemprop="url" href="https://www.fragrantica.com/designers/Al-Haramain-Perfumes.html">
 *       <span itemprop="name"> Al Haramain Perfumes </span>
 *       <span class="inline-block bg-white p-1 rounded-lg">
 *         <img itemprop="logo" src="https://fimgs.net/mdimg/dizajneri/m.429.jpg" alt="...">
 *       </span>
 *     </a>
 *   </p>
 *
 * Output: brand_logos.json -> [ { "name": "Al Haramain Perfumes", "logo_url": "..." }, ... ]
 * Merged into the DB by import_datasets.js (stage 5), matched against
 * brands.name_normalized (through the same BRAND_ALIASES resolution used
 * for the main import).
 *
 * Note: this only reaches brands that have at least one Fragrantica row -
 * a brand that exists only in Parfumo has no slug to build a URL from and
 * will simply stay without a logo.
 *
 * Install deps first:
 *   npm install axios cheerio csv-parse
 *
 * Run:
 *   node scrape_fragrantica_designers.js
 *
 * With ~2500 unique brands and the default 1.5s delay this takes roughly
 * an hour. Safe to Ctrl+C and resume - see RESUME below.
 */

const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const { parse } = require("csv-parse/sync");

const BASE = "https://www.fragrantica.com";
const CSV_FILE = process.env.FRAGRANTICA_CSV || "fra_perfumes.csv";
const OUT_FILE = "brand_logos.json";
const DELAY_MS = 1500; // be polite - do not remove or shrink this

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const client = axios.create({
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; personal-perfume-db-project/1.0)",
    "Accept-Language": "en-US,en;q=0.9",
  },
  timeout: 15000,
});

async function fetchHtml(url) {
  const res = await client.get(url);
  return res.data;
}

// Same slug extraction as extractBrandFromFragranticaUrl() in
// import_datasets.js, but keeps the raw hyphenated slug (needed to build
// the designer page URL) instead of turning it into a display name.
function extractSlugFromPerfumeUrl(url) {
  if (!url) return null;
  const m = url.match(/\/perfume\/([^/]+)\//);
  return m && m[1] ? m[1] : null;
}

function collectUniqueSlugs() {
  const records = parse(fs.readFileSync(CSV_FILE, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });
  const slugs = new Set();
  for (const r of records) {
    const slug = extractSlugFromPerfumeUrl(r.url);
    if (slug) slugs.add(slug);
  }
  return Array.from(slugs);
}

function parseDesignerPage(html) {
  const $ = cheerio.load(html);
  const block = $('p[itemprop="brand"]').first();
  if (block.length === 0) return null;

  const name = block
    .find('span[itemprop="name"]')
    .first()
    .text()
    .replace(/\s+/g, " ")
    .trim();
  let logoUrl = block.find('img[itemprop="logo"]').attr("src") || null;
  if (!name || !logoUrl) return null;
  if (!logoUrl.startsWith("http")) logoUrl = `https:${logoUrl}`;
  return { name, logo_url: logoUrl };
}

async function main() {
  const slugs = collectUniqueSlugs();
  console.log(`${slugs.length} brand unici trovati in ${CSV_FILE}.`);

  // RESUME: if a partial brand_logos.json already exists from a previous
  // interrupted run, keep what's there and skip brands already collected
  // (matched by slug->name isn't tracked, so this dedups by name instead).
  let results = [];
  if (fs.existsSync(OUT_FILE)) {
    try {
      results = JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
      console.log(
        `Ripreso da ${OUT_FILE} esistente: ${results.length} loghi già raccolti.`
      );
    } catch {
      results = [];
    }
  }
  const alreadyHave = new Set(results.map((r) => r.name.toLowerCase()));

  let ok = 0;
  let failed = 0;
  for (const [i, slug] of slugs.entries()) {
    const url = `${BASE}/designers/${slug}.html`;
    try {
      const html = await fetchHtml(url);
      const parsed = parseDesignerPage(html);
      if (parsed && !alreadyHave.has(parsed.name.toLowerCase())) {
        results.push(parsed);
        alreadyHave.add(parsed.name.toLowerCase());
        ok++;
      } else if (!parsed) {
        console.error(
          `[${i + 1}/${
            slugs.length
          }] ${slug}: nessun blocco brand trovato nella pagina.`
        );
        failed++;
      }
    } catch (e) {
      console.error(
        `[${i + 1}/${slugs.length}] ${slug}: errore (${e.message})`
      );
      failed++;
    }

    // Save progress periodically so a Ctrl+C doesn't lose everything.
    if ((i + 1) % 50 === 0) {
      fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), "utf8");
      console.log(
        `  ... ${i + 1}/${
          slugs.length
        } processati, ${ok} loghi ok, ${failed} falliti.`
      );
    }

    await sleep(DELAY_MS);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), "utf8");
  console.log(
    `Scritto ${OUT_FILE} con ${results.length} loghi totali (${failed} slug falliti).`
  );
}

main().catch((e) => {
  console.error("Errore critico:", e.message);
  process.exitCode = 1;
});
