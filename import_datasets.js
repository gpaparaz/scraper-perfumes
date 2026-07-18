const fs = require('fs');
const { Client } = require('pg');
const { parse } = require('csv-parse/sync');

// Configurazione Database
const dbConfig = {
  user: 'postgres',
  host: 'localhost',
  database: 'postgres', 
  password: 'giorgia', 
  port: 5432,
};

const normalizeName = (name) => name ? name.trim().toLowerCase() : '';

function extractBrandFromFragranticaUrl(url) {
  if (!url) return 'Unknown';
  const match = url.match(/\/perfume\/([^/]+)\//);
  if (match && match[1]) {
    return match[1].replace(/-/g, ' ');
  }
  return 'Unknown';
}

async function startImport() {
  const client = new Client(dbConfig);
  await client.connect();
  console.log('🔌 Connesso a Postgres con successo.');

  try {
    await client.query(`ALTER TABLE ingredients ADD CONSTRAINT unique_ingredient_name UNIQUE (name);`).catch(() => {});
    await client.query(`ALTER TABLE brands ADD CONSTRAINT unique_brand_name UNIQUE (name);`).catch(() => {});
    await client.query(`ALTER TABLE perfumes ADD CONSTRAINT unique_perfume_title_brand UNIQUE (title, brand_id);`).catch(() => {});

    // -------------------------------------------------------------
    // STADIO 1: Importazione Première Peau (Glossario Ingredienti)
    // -------------------------------------------------------------
    console.log('\n 1/3: Elaborazione Glossario Première Peau (JSON)...');
    const rawPp = fs.readFileSync('premiere-peau-en-merged.json', 'utf8'); 
    const ppData = JSON.parse(rawPp);

    const ingredientMap = new Map();

    for (const item of ppData) {
      if (!item.term) continue;

      const tc = item.technical_card || {};
      const evo = item.evolution || {};

      // UPSERT robusto: se esiste già, aggiorna TUTTI i campi strutturati e garantisce il ritorno dell'ID
      const res = await client.query(`
        INSERT INTO ingredients (
          name, category, subcategory, short_description, botanical_name, 
          appearance, odor_strength, producing_countries, typical_volatility,
          evolution_immediate, evolution_after_hours, evolution_after_days,
          full_extracted_text, source_url
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (name) DO UPDATE SET 
          category = COALESCE(EXCLUDED.category, ingredients.category),
          subcategory = COALESCE(EXCLUDED.subcategory, ingredients.subcategory),
          short_description = COALESCE(EXCLUDED.short_description, ingredients.short_description),
          botanical_name = COALESCE(EXCLUDED.botanical_name, ingredients.botanical_name),
          appearance = COALESCE(EXCLUDED.appearance, ingredients.appearance),
          odor_strength = COALESCE(EXCLUDED.odor_strength, ingredients.odor_strength),
          producing_countries = COALESCE(EXCLUDED.producing_countries, ingredients.producing_countries),
          typical_volatility = COALESCE(EXCLUDED.typical_volatility, ingredients.typical_volatility),
          evolution_immediate = COALESCE(EXCLUDED.evolution_immediate, ingredients.evolution_immediate),
          evolution_after_hours = COALESCE(EXCLUDED.evolution_after_hours, ingredients.evolution_after_hours),
          evolution_after_days = COALESCE(EXCLUDED.evolution_after_days, ingredients.evolution_after_days),
          full_extracted_text = COALESCE(EXCLUDED.full_extracted_text, ingredients.full_extracted_text),
          source_url = COALESCE(EXCLUDED.source_url, ingredients.source_url)
        RETURNING id, name;
      `, [
        item.term.trim(),
        tc.Category || item.category?.split('/')[0]?.trim() || null,
        tc.Subcategory || item.category?.split('/')[1]?.trim() || null,
        item.short_description || null,
        tc.Botanical !== 'N/A' && tc.Botanical ? tc.Botanical : null,
        tc.Appearance || null,
        tc['Odor Strength'] || null,
        tc['Producing Countries'] || null,
        tc.Volatility || null,
        evo.Immediately || null,
        evo['After a few hours'] || null,
        evo['After a few days'] || null,
        item.extracted_text_body || null,
        item.url || null
      ]);

      if (res.rows.length > 0) {
        const inserted = res.rows[0];
        ingredientMap.set(normalizeName(inserted.name), inserted.id);
      }
    }
    console.log(`Glossario completato. ${ingredientMap.size} ingredienti pronti in memoria.`);

    // Helper per garantire l'esistenza di una nota senza spianare i dati del glossario esistente
    async function ensureIngredientAndGetId(rawNoteName) {
      if (!rawNoteName) return null;
      const cleanName = rawNoteName.trim();
      const lower = normalizeName(cleanName);
      
      if (ingredientMap.has(lower)) {
        return ingredientMap.get(lower);
      }

      try {
        const res = await client.query(
          `INSERT INTO ingredients (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = ingredients.name RETURNING id`,
          [cleanName]
        );
        const id = res.rows[0].id;
        ingredientMap.set(lower, id);
        return id;
      } catch (e) {
        return null;
      }
    }

    async function ensureBrandGetId(brandName) {
      if (!brandName || brandName === 'NA') brandName = 'Unknown';
      const cleanBrand = brandName.trim();
      const res = await client.query(
        `INSERT INTO brands (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = brands.name RETURNING id`,
        [cleanBrand]
      );
      return res.rows[0].id;
    }

    async function insertNoteRelation(perfumeId, noteName, layer) {
      if (!noteName || noteName.toLowerCase() === 'na') return;
      const ingredientId = await ensureIngredientAndGetId(noteName);
      if (perfumeId && ingredientId) {
        await client.query(
          `INSERT INTO perfume_notes (perfume_id, ingredient_id, layer) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [perfumeId, ingredientId, layer]
        );
      }
    }

    // -------------------------------------------------------------
    // STADIO 2: Importazione Dataset Fragrantica (CSV)
    // -------------------------------------------------------------
    console.log('\n 2/3: Elaborazione Dataset Fragrantica (CSV)...');
    const rawFrag = fs.readFileSync('fra_perfumes.csv', 'utf8');
    const fragRecords = parse(rawFrag, { columns: true, skip_empty_lines: true });

    for (const record of fragRecords) {
      if (!record.Name) continue;
      
      const brandName = extractBrandFromFragranticaUrl(record.url);
      const brandId = await ensureBrandGetId(brandName);

      // Inserimento con gestione conflitto per evitare duplicati
      const perfRes = await client.query(
        `INSERT INTO perfumes (brand_id, title, description) VALUES ($1, $2, $3) 
         ON CONFLICT (title, brand_id) DO UPDATE SET description = COALESCE(EXCLUDED.description, perfumes.description)
         RETURNING id`,
        [brandId, record.Name.trim(), record.Description || null]
      );
      const perfumeId = perfRes.rows[0].id;

      // Accordi principali
      if (record['Main Accords']) {
        try {
          const cleanAccordsStr = record['Main Accords'].replace(/'/g, '"');
          const accordsArray = JSON.parse(cleanAccordsStr);
          for (let i = 0; i < accordsArray.length; i++) {
            const intensity = Math.max(10, 100 - (i * 10)); 
            await client.query(`
              INSERT INTO perfume_accords (perfume_id, accord_name, intensity_percentage) 
              VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
            `, [perfumeId, accordsArray[i].trim(), intensity]);
          }
        } catch (err) {}
      }

      // Regex corretta per estrarre le note ignorando i punti intermedi
      if (record.Description) {
        const desc = record.Description;
        const topMatch = desc.match(/Top notes are ([^;]+)/i);
        const middleMatch = desc.match(/middle notes are ([^;]+)/i);
        const baseMatch = desc.match(/base notes are ([^;]+)/i);

        const parseNotesList = (str) => {
          if (!str) return [];
          // Rimuove l'eventuale pezzo finale della frase che si chiude con un punto
          let cleanStr = str.split('.')[0]; 
          return cleanStr.split(/, | and /g).map(n => n.trim()).filter(n => n.length > 0);
        };

        if (topMatch) {
          for (const note of parseNotesList(topMatch[1])) await insertNoteRelation(perfumeId, note, 'top');
        }
        if (middleMatch) {
          for (const note of parseNotesList(middleMatch[1])) await insertNoteRelation(perfumeId, note, 'heart');
        }
        if (baseMatch) {
          for (const note of parseNotesList(baseMatch[1])) await insertNoteRelation(perfumeId, note, 'base');
        }
      }
    }
    console.log(`Dataset Fragrantica importato con successo.`);

    // -------------------------------------------------------------
    // STADIO 3: Importazione Dataset TidyTuesday / Parfumo (CSV)
    // -------------------------------------------------------------
    console.log('\n 3/3: Elaborazione Dataset TidyTuesday/Parfumo (CSV)...');
    const rawTidy = fs.readFileSync('parfumo_data_clean.csv', 'utf8'); 
    const tidyRecords = parse(rawTidy, { columns: true, skip_empty_lines: true });

    for (const record of tidyRecords) {
      if (!record.Name) continue;

      const brandId = await ensureBrandGetId(record.Brand);
      
      let releaseYear = parseInt(record.Release_Year, 10);
      if (isNaN(releaseYear)) releaseYear = null;

      const perfRes = await client.query(
        `INSERT INTO perfumes (brand_id, title, release_year) VALUES ($1, $2, $3) 
         ON CONFLICT (title, brand_id) DO UPDATE SET release_year = COALESCE(EXCLUDED.release_year, perfumes.release_year)
         RETURNING id`,
        [brandId, record.Name.trim(), releaseYear]
      );
      const perfumeId = perfRes.rows[0].id;

      const processNotes = async (notesStr, layer) => {
        if (notesStr && notesStr !== 'NA') {
          const notes = notesStr.split(',').map(n => n.trim());
          for (const note of notes) {
            await insertNoteRelation(perfumeId, note, layer);
          }
        }
      };

      await processNotes(record.Top_Notes, 'top');
      await processNotes(record.Middle_Notes, 'heart');
      await processNotes(record.Base_Notes, 'base');

      if (record.Main_Accords && record.Main_Accords !== 'NA') {
        const accords = record.Main_Accords.split(',').map(a => a.trim());
        for (let i = 0; i < accords.length; i++) {
          const intensity = Math.max(10, 100 - (i * 12));
          await client.query(`
            INSERT INTO perfume_accords (perfume_id, accord_name, intensity_percentage) 
            VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
          `, [perfumeId, accords[i], intensity]);
        }
      }
    }
    console.log(`Dataset TidyTuesday importato con successo.`);
    console.log('\n Esecuzione completata con successo! Pulisci il DB e lancia questo.');

  } catch (error) {
    console.error(' Errore critico durante l\'importazione:', error);
  } finally {
    await client.end();
    console.log(' Connessione database chiusa.');
  }
}

startImport();