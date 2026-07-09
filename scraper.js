const fs = require('fs');
const cheerio = require('cheerio');
const readline = require('readline');

const BASE_URL = 'https://premierepeau.com';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9'
};

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question('Target letter (e.g. A, B, C): ', async (inputLetter) => {
    const letter = inputLetter.trim().toUpperCase();
    if (!letter.match(/^[A-Z0-9]$/)) {
        console.error('Invalid input. Please enter a single letter or number.');
        rl.close();
        return;
    }

    rl.close();
    await startScraping(letter);
});

async function startScraping(letter) {
    console.log(`Starting scraper for letter: [${letter}]`);
    const urlsToScan = [];
    
    for (let page = 1; page <= 7; page++) {
        console.log(`Scanning index page ${page}/7...`);
        const indexUrl = `${BASE_URL}/it/pages/glossary-terms?page_b4e05a4c=${page}`;
        
        try {
            const response = await fetch(indexUrl, { headers: HEADERS });
            if (!response.ok) continue;

            const html = await response.text();
            const $ = cheerio.load(html);
            const targetHeading = $(`h3:contains("${letter}")`);
            
            if (targetHeading.length > 0) {
                const linksContainer = targetHeading.next('div');
                linksContainer.find('a').each((i, el) => {
                    const href = $(el).attr('href');
                    if (href && href.startsWith('/')) {
                        const fullUrl = BASE_URL + href;
                        if (!urlsToScan.includes(fullUrl)) {
                            urlsToScan.push(fullUrl);
                        }
                    }
                });
            }
        } catch (error) {
            console.error(`Error scanning index page ${page}:`, error.message);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`Found ${urlsToScan.length} terms for letter ${letter}.`);
    if (urlsToScan.length === 0) return;

    const glossaryData = [];

    for (let i = 0; i < urlsToScan.length; i++) {
        const termUrl = urlsToScan[i];
        console.log(`[${i + 1}/${urlsToScan.length}] Extracting: ${termUrl}`);

        try {
            const response = await fetch(termUrl, { headers: HEADERS });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const html = await response.text();
            const $ = cheerio.load(html);

            const title = $('h1').text().trim();
            const category = $('.pp-wiki-sub').text().trim() || 'N/D';

            // 1. Technical Card (Perfect mapping)
            const techCard = {};
            $('.pp-wiki-ib table tr').each((idx, el) => {
                const key = $(el).find('td').eq(0).text().replace(/:/g, '').trim();
                const value = $(el).find('td').eq(1).text().trim();
                if (key && value) techCard[key] = value;
            });

            // 2. Evolution Timeline (Perfect mapping)
            const evolution = {};
            $('.pp-evo-card').each((idx, el) => {
                const label = $(el).find('.pp-evo-card__label').text().trim();
                const desc = $(el).find('.pp-evo-card__desc').text().trim();
                if (label && desc) evolution[label] = desc;
            });

            // 3. Raw Text Body Cleanup (Gather all clean paragraphs to avoid site structural bugs)
            $('script, style, details, summary, noscript, .pp-wiki-bc, h1, .pp-wiki-sub, .pp-wiki-ib').remove();
            
            // Extract the first clean paragraph as the real short description
            const realShortDesc = $('.pp-wiki-body p').first().text().replace(/\s+/g, ' ').trim() || 'N/D';

            let fullContentText = '';
            $('.pp-wiki-body p, .metafield-rich_text_field p').each((idx, el) => {
                const txt = $(el).text().replace(/\s+/g, ' ').trim();
                // Filter out junk lines or shop button code
                if (txt && !txt.startsWith('{') && !txt.includes('function()') && !txt.includes('Discovery Set')) {
                    if (!fullContentText.includes(txt)) { // Avoid duplicate paragraphs printed by Shopify
                        fullContentText += txt + '\n\n';
                    }
                }
            });

            if (title) {
                glossaryData.push({
                    term: title,
                    category: category,
                    short_description: realShortDesc,
                    technical_card: techCard,
                    evolution: evolution,
                    extracted_text_body: fullContentText.trim(),
                    url: termUrl
                });

                fs.writeFileSync(
                    `final_glossary_${letter}.json`, 
                    JSON.stringify(glossaryData, null, 2), 
                    'utf-8'
                );
            }

            await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error) {
            console.error(`Failed to download ${termUrl}:`, error.message);
        }
    }

    console.log(`Process complete. Output saved to final_glossary_${letter}.json`);
}