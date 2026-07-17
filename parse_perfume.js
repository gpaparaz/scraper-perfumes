const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Enable stealth plugin to bypass Cloudflare detection
puppeteer.use(StealthPlugin());

async function scrapePerfume(url) {
  console.log(`Navigating to: ${url}`);
  
  // Launch the browser in non-headless mode to monitor the process
  const browser = await puppeteer.launch({ 
    headless: false,
    args: ['--start-maximized'] 
  });

  const page = await browser.newPage();

  // Set a standard desktop viewport
  await page.setViewport({ width: 1366, height: 768 });
  
  try {
    // Navigate to the target perfume page
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000 
    });

    // Wait for 5 seconds to ensure all asynchronous elements are fully rendered
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 5000)));

    console.log('Extracting structural data directly from browser memory...');

    // Extract data directly inside the browser context
    const structuredData = await page.evaluate(() => {
      // 1. Title and Brand Extraction
      const fullTitle = document.title.replace('- Fragrantica', '').trim();
      const brand = "Guerlain"; // Can be dynamic or hardcoded based on project needs

      // 2. Description Extraction
      let description = "";
      const descEl = document.querySelector('div[itemprop="description"]');
      if (descEl) {
        description = descEl.textContent.trim();
      } else {
        const fallbackDesc = document.querySelector('.cell.small-12 p');
        description = fallbackDesc ? fallbackDesc.textContent.trim() : "";
      }

      // 3. Main Accords Extraction
      const mainAccords = [];
      const accordBars = document.querySelectorAll('.accord-bar');
      
      accordBars.forEach(el => {
        const accordName = el.textContent.trim();
        const styleAttr = el.getAttribute('style') || '';
        let intensity = null;

        if (styleAttr.includes('width')) {
          const widthValue = styleAttr.split('width:')[1]?.split('%')[0]?.trim();
          if (widthValue) intensity = parseFloat(widthValue);
        }

        if (accordName) {
          mainAccords.push({ accord: accordName, intensity: intensity });
        }
      });

      // Fallback for accords if primary selector returns empty
      if (mainAccords.length === 0) {
        const widthDivs = document.querySelectorAll('div[style*="width:"]');
        widthDivs.forEach(el => {
          const style = el.getAttribute('style') || '';
          const text = el.textContent.trim();
          if (text && text.length < 25 && !text.includes('\n')) {
            const widthValue = style.split('width:')[1]?.split('%')[0]?.trim();
            if (widthValue && !isNaN(widthValue)) {
              mainAccords.push({
                accord: text,
                intensity: parseFloat(widthValue)
              });
            }
          }
        });
      }

      // 4. Olfactory Pyramid Extraction
      const pyramid = {
        top_notes: [],
        heart_notes: [],
        base_notes: []
      };

      const noteLinks = document.querySelectorAll('.pyramid-note-link');
      noteLinks.forEach(linkEl => {
        const labelEl = linkEl.querySelector('.pyramid-note-label');
        const noteName = labelEl ? labelEl.textContent.trim() : null;

        if (noteName) {
          // Find the closest ancestor section container to determine the layer heading
          const sectionContainer = linkEl.closest('.mx-auto');
          if (sectionContainer) {
            const h4El = sectionContainer.querySelector('h4');
            const layerText = h4El ? h4El.textContent.toLowerCase().trim() : '';

            let targetLayer = null;
            if (layerText.includes('apertura') || layerText.includes('testa') || layerText.includes('top')) {
              targetLayer = 'top_notes';
            } else if (layerText.includes('centrali') || layerText.includes('cuore') || layerText.includes('middle')) {
              targetLayer = 'heart_notes';
            } else if (layerText.includes('base') || layerText.includes('fondo')) {
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
        description: description,
        main_accords: mainAccords,
        pyramid: pyramid,
        extracted_at: new Date().toISOString()
      };
    });

    // 5. Save the final clean JSON object directly to disk
    const safeFileName = 'perfume_output.json';
    fs.writeFileSync(safeFileName, JSON.stringify(structuredData, null, 2), 'utf-8');
    console.log(`Success! Clean database schema saved directly to: ${safeFileName}`);

  } catch (error) {
    console.error('An error occurred during runtime execution:', error);
  } finally {
    // Ensure the browser closes at the end of the script
    await browser.close();
  }
}

// Target URL to scrape
const TARGET_URL = 'https://www.fragrantica.it/perfume/Guerlain/Guerlain-Shalimar-Parfum-Initial-L-Eau-14178.html';
scrapePerfume(TARGET_URL);