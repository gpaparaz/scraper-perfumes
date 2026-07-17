const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Enable stealth plugin to bypass Cloudflare detection
puppeteer.use(StealthPlugin());

async function fragranticaScraper(url) {
  console.log(`Navigating to English version: ${url}`);
  
  // Launch the browser in non-headless mode to monitor the process
  const browser = await puppeteer.launch({ 
    headless: false,
    args: ['--start-maximized'] 
  });

  const page = await browser.newPage();

  // Set a standard desktop viewport
  await page.setViewport({ width: 1366, height: 768 });
  
  try {
    // Navigate to the target international perfume page
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000 
    });

    // Wait for 5 seconds to ensure all asynchronous elements are fully rendered
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 5000)));

    console.log('Extracting structural data directly from browser memory in English...');

    // Extract data directly inside the browser context
    const structuredData = await page.evaluate(() => {
      // 1. Title, Brand, and Perfumer Extraction
      const fullTitle = document.title.replace('- Fragrantica', '').trim();
      
      // Dynamic extraction of the brand from the breadcrumb or header elements
      let brand = "";
      const brandEl = document.querySelector('span[itemprop="brand"] a, h1 span[itemprop="name"]');
      if (brandEl) {
        brand = brandEl.textContent.trim();
      } else {
        // Fallback from title (usually "Brand Name Perfume Name")
        brand = fullTitle.split(' ')[0];
      }

      // 2. Description and Perfumer Extraction
      let description = "";
      let perfumer = null;
      const descEl = document.querySelector('div[itemprop="description"]');
      if (descEl) {
        description = descEl.textContent.trim();
        
        // Regex check to isolate the Nose/Perfumer in English text (e.g., "The nose behind this fragrance is...")
        const perfumerMatch = description.match(/(?:The nose behind this fragrance is|The nose is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i);
        if (perfumerMatch && perfumerMatch[1]) {
          perfumer = perfumerMatch[1].trim();
        }
      } else {
        const fallbackDesc = document.querySelector('.cell.small-12 p');
        description = fallbackDesc ? fallbackDesc.textContent.trim() : "";
      }

      // 3. Main Accords Extraction (Aggiornato e rinforzato per .com)
      const mainAccords = [];
            
      // Selettore mirato per pescare sia le barre standard che le varianti dell'interfaccia .com
      const accordElements = document.querySelectorAll('.accord-bar, [class*="accord-box"], .accord-item');

      accordElements.forEach(el => {
        // Recupera il testo pulito provando sull'elemento stesso o sui suoi figli diretti
        let accordName = el.textContent.trim();
        
        // Se il testo è vuoto, prova a cercare un sotto-elemento testuale comune
        if (!accordName) {
          const innerTextEl = el.querySelector('.accord-label, span, a');
          if (innerTextEl) accordName = innerTextEl.textContent.trim();
        }

        const styleAttr = el.getAttribute('style') || '';
        let intensity = null;

        // Estrazione della percentuale della barra di riempimento
        if (styleAttr.includes('width')) {
          const widthValue = styleAttr.split('width:')[1]?.split('%')[0]?.trim();
          if (widthValue) intensity = parseFloat(widthValue);
        }

        // Evita di inserire duplicati o stringhe di testo troppo lunghe (rumore di layout)
        if (accordName && accordName.length < 30 && intensity !== null) {
          // Rimuove eventuali numeri residui dal testo se presenti
          accordName = accordName.replace(/[0-9.%]/g, '').trim();
          
          if (accordName) {
            mainAccords.push({ accord: accordName.toLowerCase(), intensity: intensity });
          }
        }
      });

      // Fallback estremo se il primo tentativo fallisce: scansione analitica di tutti i nodi con width dinamico
      if (mainAccords.length === 0) {
        const allWidthDivs = document.querySelectorAll('div[style*="width:"]');
        allWidthDivs.forEach(el => {
          const style = el.getAttribute('style') || '';
          const text = el.textContent.trim();
          
          // Gli accordi veri hanno testo breve, non contengono ritorni a capo e hanno larghezze significative
          if (text && text.length < 20 && !text.includes('\n')) {
            const widthValue = style.split('width:')[1]?.split('%')[0]?.trim();
            const parsedWidth = parseFloat(widthValue);
            
            if (widthValue && !isNaN(parsedWidth) && parsedWidth > 0) {
              const cleanedText = text.replace(/[0-9.%]/g, '').trim().toLowerCase();
              if (cleanedText && !mainAccords.some(a => a.accord === cleanedText)) {
                mainAccords.push({
                  accord: cleanedText,
                  intensity: parsedWidth
                });
              }
            }
          }
        });
      }

      // 4. Olfactory Pyramid Extraction (English Alignment)
      const pyramid = {
        top_notes: [],
        heart_notes: [],
        base_notes: []
      };

      const noteLinks = document.querySelectorAll('.pyramid-note-link');
      noteLinks.forEach(linkEl => {
        const labelEl = linkEl.querySelector('.pyramid-note-label');
        const noteName = labelEl ? labelEl.textContent.trim() : null; // "Bergamot", "Vanilla"

        if (noteName) {
          // Find the closest ancestor section container to determine the layer heading
          const sectionContainer = linkEl.closest('.mx-auto');
          if (sectionContainer) {
            const h4El = sectionContainer.querySelector('h4');
            const layerText = h4El ? h4El.textContent.toLowerCase().trim() : '';

            let targetLayer = null;
            // Aligned strictly with English terminology of Fragrantica.com
            if (layerText.includes('top') || layerText.includes('opening')) {
              targetLayer = 'top_notes';
            } else if (layerText.includes('middle') || layerText.includes('heart')) {
              targetLayer = 'heart_notes';
            } else if (layerText.includes('base')) {
              targetLayer = 'base_notes';
            }

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

    // 5. Save the clean English JSON database object directly to disk
    const safeFileName = 'perfume_output_en.json';
    fs.writeFileSync(safeFileName, JSON.stringify(structuredData, null, 2), 'utf-8');
    console.log(`Success! Clean database schema in English saved directly to: ${safeFileName}`);

  } catch (error) {
    console.error('An error occurred during runtime execution:', error);
  } finally {
    // Ensure the browser closes at the end of the script
    await browser.close();
  }
}

// Target URL pointed to the global .com English site
const TARGET_URL = 'https://www.fragrantica.com/perfume/Guerlain/Guerlain-Shalimar-Parfum-Initial-L-Eau-14178.html';
fragranticaScraper(TARGET_URL);