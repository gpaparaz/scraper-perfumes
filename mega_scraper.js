const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// Utility per attendere un numero di millisecondi
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Genera un'attesa casuale per non farsi beccare (es. tra min e max secondi)
const randomDelay = (min = 5000, max = 12000) => {
  const ms = Math.floor(Math.random() * (max - min + 1) + min);
  console.log(`⏱️ Attesa di sicurezza: ${(ms / 1000).toFixed(1)} secondi...`);
  return delay(ms);
};

/**
 * FASE 1: RACCOLTA URL
 */
async function collectUrlsFromBrand(brandUrl) {
  console.log(`🔎 Avvio raccolta URL dal brand: ${brandUrl}`);
  const browser = await puppeteer.launch({ headless: false, args: ['--start-maximized'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  try {
    await page.goto(brandUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(5000);

    // Scorrimento lento per caricare tutti i profumi (Lazy Loading)
    console.log('📜 Scorrimento della pagina in corso...');
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 150;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 80);
      });
    });

    await delay(3000);

    // Estrazione link
    const urls = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/perfume/"]');
      const list = [];
      links.forEach(l => {
        if (l.href && !l.href.includes('#') && !list.includes(l.href)) list.push(l.href);
      });
      return list;
    });

    console.log(`✅ Trovati ${urls.length} profumi per questo brand.`);
    return urls;
  } catch (e) {
    console.error('❌ Errore durante la raccolta URL:', e);
    return [];
  } finally {
    await browser.close();
  }
}

/**
 * FASE 2: IL TUO MOTORE DI SCRAPING (OTTIMIZZATO)
 */
async function scrapeSinglePerfume(page, url) {
  console.log(`🚀 Scopo la pagina: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  
  // Attesa robusta per il caricamento degli accordi asincroni
  await delay(7000); 

  return await page.evaluate(() => {
    // 1. Titolo e Brand
    const fullTitle = document.title.replace('- Fragrantica', '').trim();
    let brand = "";
    const brandEl = document.querySelector('span[itemprop="brand"] a, h1 span[itemprop="name"]');
    brand = brandEl ? brandEl.textContent.trim() : fullTitle.split(' ')[0];

    // 2. Descrizione e Profumiere
    let description = "";
    let perfumer = null;
    const descEl = document.querySelector('div[itemprop="description"]');
    if (descEl) {
      description = descEl.textContent.trim();
      const perfumerMatch = description.match(/(?:The nose behind this fragrance is|The nose is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i);
      if (perfumerMatch && perfumerMatch[1]) perfumer = perfumerMatch[1].trim();
    } else {
      const fallbackDesc = document.querySelector('.cell.small-12 p');
      description = fallbackDesc ? fallbackDesc.textContent.trim() : "";
    }

    // 3. Accordi (Il codice che abbiamo perfezionato insieme)
    const mainAccords = [];
    const accordElements = document.querySelectorAll('.accord-bar, [class*="accord-box"], .accord-item');
    accordElements.forEach(el => {
      let accordName = el.textContent.trim();
      if (!accordName) {
        const innerTextEl = el.querySelector('.accord-label, span, a');
        if (innerTextEl) accordName = innerTextEl.textContent.trim();
      }
      const styleAttr = el.getAttribute('style') || '';
      let intensity = null;
      if (styleAttr.includes('width')) {
        const widthValue = styleAttr.split('width:')[1]?.split('%')[0]?.trim();
        if (widthValue) intensity = parseFloat(widthValue);
      }
      if (accordName && accordName.length < 30 && intensity !== null) {
        accordName = accordName.replace(/[0-9.%]/g, '').trim().toLowerCase();
        if (accordName) mainAccords.push({ accord: accordName, intensity });
      }
    });

    // 4. Piramide Olfattiva
    const pyramid = { top_notes: [], heart_notes: [], base_notes: [] };
    const noteLinks = document.querySelectorAll('.pyramid-note-link');
    noteLinks.forEach(linkEl => {
      const labelEl = linkEl.querySelector('.pyramid-note-label');
      const noteName = labelEl ? labelEl.textContent.trim() : null;
      if (noteName) {
        const sectionContainer = linkEl.closest('.mx-auto');
        if (sectionContainer) {
          const h4El = sectionContainer.querySelector('h4');
          const layerText = h4El ? h4El.textContent.toLowerCase().trim() : '';
          let targetLayer = null;
          if (layerText.includes('top') || layerText.includes('opening')) targetLayer = 'top_notes';
          else if (layerText.includes('middle') || layerText.includes('heart')) targetLayer = 'heart_notes';
          else if (layerText.includes('base')) targetLayer = 'base_notes';
          
          if (targetLayer && !pyramid[targetLayer].includes(noteName)) {
            pyramid[targetLayer].push(noteName);
          }
        }
      }
    });

    return {
      title: fullTitle,
      brand: brand,
      perfumer: perfumer,
      description: description,
      main_accords: mainAccords,
      pyramid: pyramid,
      extracted_at: new Date().toISOString()
    };
  });
}

/**
 * COORDINATORE PRINCIPALE
 */
async function main() {
  const QUEUE_FILE = 'perfume_queue.json';
  const OUTPUT_FILE = 'scraped_perfumes_archive.json';
  
  let queue = [];

  // Se esiste già una coda salvata, riprendiamo da lì, altrimenti la creiamo
  if (fs.existsSync(QUEUE_FILE)) {
    console.log('🔄 Trovata una coda esistente sul disco. Riprendo il lavoro...');
    queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  } else {
    // Inserisci qui l'URL del brand da cui vuoi partire
    const BRAND_URL = 'https://www.fragrantica.com/designers/Guerlain.html';
    queue = await collectUrlsFromBrand(BRAND_URL);
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
  }

  if (queue.length === 0) {
    console.log('🛑 Nessun URL in coda. Fine.');
    return;
  }

  // Carichiamo l'archivio dei risultati esistenti o ne creiamo uno nuovo
  let scrapedData = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    scrapedData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
  }

  // Avviamo il browser per il loop di scraping pesante
  const browser = await puppeteer.launch({ headless: false, args: ['--start-maximized'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  console.log(`🤖 Inizio estrazione di ${queue.length} profumi rimasti in coda...`);

  // Ciclo finché ci sono elementi in coda
  while (queue.length > 0) {
    const currentUrl = queue[0]; // Prende il primo della lista
    
    try {
      const data = await scrapeSinglePerfume(page, currentUrl);
      scrapedData.push({ url: currentUrl, ...data });
      
      // Salva l'archivio aggiornato con il nuovo profumo
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(scrapedData, null, 2), 'utf-8');
      console.log(`✨ Salvato con successo: ${data.title}`);

      // RIMOZIONE DALLA CODA: Rimuove l'URL appena fatto e aggiorna il file di coda
      queue.shift();
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');

    } catch (error) {
      console.error(`❌ Errore sull'URL: ${currentUrl}. Salto al prossimo per sicurezza.`, error);
      // Spostiamo in fondo alla coda o lasciamolo lì? 
      // Consiglio di fare shift() comunque per non piantare il loop su un URL rotto
      queue.shift();
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
    }

    // Fondamentale: pausa randomica prima del prossimo profumo per non farsi bannare
    if (queue.length > 0) {
      await randomDelay(6000, 14000); // Pausa variabile tra i 6 e i 14 secondi
    }
  }

  console.log('🎉 CODA COMPLETATA! Tutti i profumi sono stati archiviati.');
  await browser.close();
}

main();