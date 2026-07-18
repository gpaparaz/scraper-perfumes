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

// Funzione di utilità per pulire e normalizzare le stringhe dei nomi per il confronto
const normalizeName = (name) => name ? name.trim().toLowerCase() : '';

// Helper per estrarre il Brand dall'URL di Fragrantica (visto che manca la colonna esplicita)
// Es: https://www.fragrantica.com/perfume/Afnan/9am-70706.html -> Afnan
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
    // -------------------------------------------------------------
    // STADIO 1: Importazione Première Peau (Glossario Ingredienti)
    // -------------------------------------------------------------
    console.log('\n 1/3: Elaborazione Glossario Première Peau (JSON)...');
    const rawPp = fs.readFileSync('premiere-peau-en-merged.json', 'utf8'); 
    const ppData = JSON.parse(rawPp);

    // Mappa per tenere in memoria gli ingredienti inseriti e velocizzare i lookups successivi
    // Chiave: nome_in_minuscolo, Valore: ID del database
    const ingredientMap = new Map();

    for (const item of ppData) {
      const tc = item.technical_card || {};
      const evo = item.evolution || {};

      const res = await client.query(`
        INSERT INTO ingredients (
          name, category, subcategory, short_description, botanical_name, 
          appearance, odor_strength, producing_countries, typical_volatility,
          evolution_immediate, evolution_after_hours, evolution_after_days,
          full_extracted_text, source_url
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (name) DO UPDATE SET 
          category = EXCLUDED.category,
          subcategory = EXCLUDED.subcategory,
          short_description = EXCLUDED.short_description
        RETURNING id, name;
      `, [
        item.term,
        tc.Category || item.category?.split('/')[0]?.trim(),
        tc.Subcategory || item.category?.split('/')[1]?.trim(),
        item.short_description,
        tc.Botanical,
        tc.Appearance,
        tc['Odor Strength'],
        tc['Producing Countries'],
        tc.Volatility,
        evo.Immediately,
        evo['After a few hours'],
        evo['After a few days'],
        item.extracted_text_body,
        item.url
      ]);

      const inserted = res.rows[0];
      ingredientMap.set(normalizeName(inserted.name), inserted.id);
    }
    console.log(`Glossario completato. ${ingredientMap.size} ingredienti indicizzati.`);

    // Funzione helper interna per garantire l'esistenza di un ingrediente durante i passaggi successivi
    async function ensureIngredientAndGetId(rawNoteName) {
      if (!rawNoteName) return null;
      const cleanName = rawNoteName.trim();
      const lower = normalizeName(cleanName);
      
      if (ingredientMap.has(lower)) {
        return ingredientMap.get(lower);
      }

      // Se non c'è nel glossario, lo creiamo "snello" per non perdere l'associazione al profumo
      try {
        const res = await client.query(
          `INSERT INTO ingredients (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          [cleanName]
        );
        const id = res.rows[0].id;
        ingredientMap.set(lower, id);
        return id;
      } catch (e) {
        return null;
      }
    }

    // Helper per inserire il brand e restituire l'ID
    async function ensureBrandGetId(brandName) {
      if (!brandName) brandName = 'Unknown';
      const cleanBrand = brandName.trim();
      const res = await client.query(
        `INSERT INTO brands (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [cleanBrand]
      );
      return res.rows[0].id;
    }

    // Helper generico per inserire la piramide olfattiva (Molti-a-Molti)
    async function insertNoteRelation(perfumeId, noteName, layer) {
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
      // 1. Risoluzione del Brand
      const brandName = extractBrandFromFragranticaUrl(record.url);
      const brandId = await ensureBrandGetId(brandName);

      // 2. Inserimento Profumo
      const perfRes = await client.query(
        `INSERT INTO perfumes (brand_id, title, description) VALUES ($1, $2, $3) RETURNING id`,
        [brandId, record.Name, record.Description]
      );
      const perfumeId = perfRes.rows[0].id;

      // 3. Elaborazione Accordi Principali
      // Il formato nel CSV è stringato come array: "['citrus', 'musky']"
      if (record['Main Accords']) {
        try {
          // Puliamo la stringa per renderla un JSON array valido e ciclabile
          const cleanAccordsStr = record['Main Accords'].replace(/'/g, '"');
          const accordsArray = JSON.parse(cleanAccordsStr);
          
          // Fragrantica in questo specifico dump non dà la percentuale numerica puntuale per riga, 
          // ma li elenca in ordine decrescente di intensità. Assegniamo un peso fittizio decrescente (es. 100, 90, 80...)
          for (let i = 0; i < accordsArray.length; i++) {
            const intensity = Math.max(10, 100 - (i * 10)); 
            await client.query(`
              INSERT INTO perfume_accords (perfume_id, accord_name, intensity_percentage) 
              VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
            `, [perfumeId, accordsArray[i], intensity]);
          }
        } catch (err) {
          // Fallback se la stringa dell'accordo ha formati strani
        }
      }

      // 4. Piramide Olfattiva (Estratta dal testo della descrizione)
      // Fragrantica in questo dataset unisce le note dentro il testo della descrizione: 
      // "Top notes are X, Y; middle notes are Z; base notes are W."
      if (record.Description) {
        const desc = record.Description;
        const topMatch = desc.match(/Top notes are ([^;.]+)/i);
        const middleMatch = desc.match(/middle notes are ([^;.]+)/i);
        const baseMatch = desc.match(/base notes are ([^;.]+)/i);

        const parseNotesList = (str) => str ? str.split(/, | and /g).map(n => n.trim()) : [];

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
    console.log(`Dataset Fragrantica importato con successo (${fragRecords.length} record).`);

    // -------------------------------------------------------------
    // STADIO 3: Importazione Dataset TidyTuesday / Parfumo (CSV)
    // -------------------------------------------------------------
    console.log('\n 3/3: Elaborazione Dataset TidyTuesday/Parfumo (CSV)...');
    const rawTidy = fs.readFileSync('parfumo_data_clean.csv', 'utf8'); 
    const tidyRecords = parse(rawTidy, { columns: true, skip_empty_lines: true });

    for (const record of tidyRecords) {
      const brandId = await ensureBrandGetId(record.Brand);
      
      // Controllo anno di rilascio numerico valido
      let releaseYear = parseInt(record.Release_Year, 10);
      if (isNaN(releaseYear)) releaseYear = null;

      // Inserimento Profumo
      const perfRes = await client.query(
        `INSERT INTO perfumes (brand_id, title, release_year) VALUES ($1, $2, $3) RETURNING id`,
        [brandId, record.Name, releaseYear]
      );
      const perfumeId = perfRes.rows[0].id;

      // Note di Testa (Top Notes)
      if (record.Top_Notes && record.Top_Notes !== 'NA') {
        const notes = record.Top_Notes.split(',').map(n => n.trim());
        for (const note of notes) await insertNoteRelation(perfumeId, note, 'top');
      }

      // Note di Cuore (Middle Notes)
      if (record.Middle_Notes && record.Middle_Notes !== 'NA') {
        const notes = record.Middle_Notes.split(',').map(n => n.trim());
        for (const note of notes) await insertNoteRelation(perfumeId, note, 'heart');
      }

      // Note di Fondo (Base Notes)
      if (record.Base_Notes && record.Base_Notes !== 'NA') {
        const notes = record.Base_Notes.split(',').map(n => n.trim());
        for (const note of notes) await insertNoteRelation(perfumeId, note, 'base');
      }

      // Gestione degli accordi se presenti (nello split delle virgole)
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
    console.log(` Dataset TidyTuesday importato con successo (${tidyRecords.length} record).`);
    console.log('\n Esecuzione completata! Il database è ora popolato e unificato.');

  } catch (error) {
    console.error(' Errore critico durante l\'importazione:', error);
  } finally {
    await client.end();
    console.log(' Connessione database chiusa.');
  }
}

startImport();