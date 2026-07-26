/**
 * scrape_fragrantica_notes.js
 *
 * Scrapes https://www.fragrantica.com/notes/ for the ingredient/note
 * index (name + thumbnail image), and writes ingredient_images.json:
 *
 *   [ { "name": "Bergamot", "image_url": "https://fimgs.net/mdimg/..." }, ... ]
 *
 * That file is then merged into the DB by import_datasets.js (stage 4),
 * matched against ingredient_aliases - so any spelling variant your DB
 * already knows about (via the normal alias mechanism) picks up the photo,
 * even if the scraper's spelling differs slightly from your canonical name.
 *
 * Install deps first:
 *   npm install axios cheerio
 *
 * Run:
 *   node scrape_fragrantica_notes.js
 *
 * Confirmed markup for one note tile (as seen on the page):
 *   <a href="https://www.fragrantica.com/notes/Black-Lemon-1958.html" class="group p-4 ...">
 *     <img src="https://fimgs.net/mdimg/sastojci/m.1958.jpg?1781021706" ... alt="Black Lemon">
 *     <p class="mt-3 text-sm font-medium ..."> Black Lemon </p>
 *   </a>
 * Name comes from the <p>, image from the <img src> (note: plain src here,
 * not srcset/source like the perfume pages - no dark/2x variants to strip).
 * The numeric id in the href (1958) matches the id in the image filename
 * (m.1958.jpg), same pattern as perfumes - kept as a fallback in case a
 * future tile is missing the <img> but still has the href.
 *
 * IMPORTANT / read before running:
 * - This still assumes /notes/ lists every note directly on one page (or a
 *   few), as the tile above suggests. If in the browser you find the page
 *   is organized into categories (Fresh Notes / Floral Notes / ... each a
 *   separate sub-page) rather than one long grid, collect those category
 *   links and feed them into findExtraPages() below - the tile markup
 *   itself should be the same on each category page.
 * - If the page's content only appears after JS runs (view page source vs
 *   the rendered DOM to check), axios+cheerio won't see it - you'd need
 *   Puppeteer/Playwright instead.
 * - This is a real site you don't control: keep the delay between
 *   requests, use a real-looking but honest User-Agent, and check
 *   fragrantica.com/robots.txt before scraping beyond the index page.
 */

const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");

const BASE = "https://www.fragrantica.com";
const INDEX_URL = `${BASE}/notes/`;
const OUT_FILE = "ingredient_images.json";
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

// Parser matching the confirmed note-tile markup: an <a href=".../notes/
// <Name>-<id>.html"> wrapping a plain <img src="...m.<id>.jpg?..."> and a
// <p> with the display name.
function parseIndexPage(html) {
  const $ = cheerio.load(html);
  const out = [];

  $('a[href*="/notes/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href") || "";

    // Name: prefer the visible <p> text (has real spacing/casing), fall
    // back to the img alt, fall back to the slug in the href.
    let name = $el.find("p").first().text().replace(/\s+/g, " ").trim();
    if (!name) name = ($el.find("img").attr("alt") || "").trim();
    if (!name) {
      const m = href.match(/\/notes\/([^/]+?)-\d+\.html/i);
      if (m) name = m[1].replace(/-/g, " ").trim();
    }
    if (!name) return;

    // Image: prefer the real <img src> from the tile. If a tile is ever
    // missing the <img> but the href still has the numeric id, rebuild the
    // thumbnail URL the same way perfume images are derived.
    let imageUrl = $el.find("img").attr("src") || null;
    if (!imageUrl) {
      const m = href.match(/-(\d+)\.html/);
      if (m) imageUrl = `https://fimgs.net/mdimg/sastojci/m.${m[1]}.jpg`;
    }
    if (!imageUrl) return;
    if (!imageUrl.startsWith("http")) imageUrl = `https:${imageUrl}`;

    out.push({ name, image_url: imageUrl });
  });

  // De-dup by lowercase name, keep first occurrence.
  const seen = new Set();
  return out.filter((n) => {
    const k = n.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// If the index paginates, collect extra page URLs here (e.g. by reading
// pagination links from the first page's HTML with cheerio) and crawl
// them with the same delay/parse logic as the main page.
async function findExtraPages(html) {
  // Example skeleton - adjust the selector once you've inspected the page:
  // const $ = cheerio.load(html);
  // return $('.pagination a').map((_, el) => $(el).attr('href')).get();
  return [];
}

async function main() {
  console.log(`Scarico ${INDEX_URL} ...`);
  const html = await fetchHtml(INDEX_URL);
  let notes = parseIndexPage(html);
  console.log(`Trovate ${notes.length} note nella pagina indice.`);

  if (notes.length === 0) {
    console.error("Nessuna nota trovata. Possibili cause:");
    console.error(
      '  - il markup e" cambiato rispetto al tile confermato (vedi commento'
    );
    console.error(
      "    in cima al file): riverifica con devtools e aggiorna parseIndexPage()"
    );
    console.error(
      '  - il contenuto e" reso via JS lato client: servirebbe Puppeteer'
    );
    console.error(
      "  - la pagina richiede un header/cookie che manca (blocco anti-bot)"
    );
    process.exitCode = 1;
    return;
  }

  const extraPages = await findExtraPages(html);
  for (const url of extraPages) {
    await sleep(DELAY_MS);
    console.log(`Scarico ${url} ...`);
    try {
      const pageHtml = await fetchHtml(
        url.startsWith("http") ? url : `${BASE}${url}`
      );
      const more = parseIndexPage(pageHtml);
      notes = notes.concat(more);
      console.log(`  +${more.length} note.`);
    } catch (e) {
      console.error(`  Errore su ${url}: ${e.message}`);
    }
  }

  // Final de-dup across all pages combined.
  const seen = new Set();
  notes = notes.filter((n) => {
    const k = n.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  fs.writeFileSync(OUT_FILE, JSON.stringify(notes, null, 2), "utf8");
  console.log(`Scritto ${OUT_FILE} con ${notes.length} ingredienti totali.`);
}

main().catch((e) => {
  console.error("Errore critico:", e.message);
  process.exitCode = 1;
});
