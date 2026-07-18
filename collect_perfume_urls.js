const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// Funzione di utilità per creare attese casuali ed evitare il rilevamento
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function collectPerfumeUrls(brandUrl) {
  console.log(`Avvio raccolta URL dalla pagina del brand: ${brandUrl}`);
  
  const browser = await puppeteer.launch({ 
    headless: false, // Lasciamo visibile per monitorare se compaiono i captcha di Cloudflare
    args: ['--start-maximized'] 
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  try {
    await page.goto(brandUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Attendiamo che la pagina si stabilizzi
    await delay(5000);

    // Scorriamo lentamente la pagina verso il basso (Lazy Loading) 
    // Molti brand su Fragrantica caricano i profumi man mano che si scende
    console.log('Scorrimento della pagina per caricare tutti i profumi...');
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 100;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;

          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    });

    await delay(3000);

    // Estraiamo tutti i link che portano alla scheda di un profumo
    const urls = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/perfume/"]');
      const urlList = [];
      links.forEach(link => {
        const href = link.href;
        // Puliamo i link da duplicati o da rimandi interni (es. recensioni, foto)
        if (href && !href.includes('#') && !urlList.includes(href)) {
          urlList.push(href);
        }
      });
      return urlList;
    });

    console.log(`Trovati ${urls.length} link di profumi!`);

    // Salviamo la coda di lavoro su un file JSON locale
    fs.writeFileSync('perfume_queue.json', JSON.stringify(urls, null, 2), 'utf-8');
    console.log('Coda salvata con successo in perfume_queue.json');

  } catch (error) {
    console.error('Errore durante la raccolta degli URL:', error);
  } finally {
    await browser.close();
  }
}

// Esempio partendo dalla pagina del brand Guerlain (versione .com)
const BRAND_URL = 'https://www.fragrantica.com/designers/Guerlain.html';
collectPerfumeUrls(BRAND_URL);