const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Enable stealth plugin to bypass Cloudflare detection
puppeteer.use(StealthPlugin());

async function fetchPage() {
  // Launch the browser in non-headless mode to monitor the process
  const browser = await puppeteer.launch({ 
    headless: false,
    args: ['--start-maximized'] 
  });

  const page = await browser.newPage();

  // Set a standard desktop viewport
  await page.setViewport({ width: 1366, height: 768 });

  console.log('Navigating to Fragrantica...');
  
  try {
    // Navigate to the target perfume page
    await page.goto('https://www.fragrantica.it/perfume/Guerlain/Guerlain-Shalimar-Parfum-Initial-L-Eau-14178.html', {
      waitUntil: 'networkidle2',
      timeout: 60000 
    });

    // Wait for 5 seconds to ensure all scripts execute completely
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 5000)));

    // Extract the full HTML content of the page
    const html = await page.content();

    // Save the raw HTML to a local file
    fs.writeFileSync('guerlain_shalimar.html', html, 'utf-8');
    console.log('Success! Raw HTML saved to guerlain_shalimar.html');

  } catch (error) {
    console.error('An error occurred during execution:', error);
  } finally {
    // Ensure the browser closes at the end of the script
    await browser.close();
  }
}

fetchPage();