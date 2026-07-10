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

// Helper function to extract structured data from a specific page HTML
function extractDataFromHtml(html, termUrl) {
    const $ = cheerio.load(html);

    const title = $('h1').text().trim();
    const category = $('.pp-wiki-sub').text().trim() || 'N/D';

    // 1. Technical Card
    const techCard = {};
    $('.pp-wiki-ib table tr').each((idx, el) => {
        const key = $(el).find('td').eq(0).text().replace(/:/g, '').trim();
        const value = $(el).find('td').eq(1).text().trim();
        if (key && value) techCard[key] = value;
    });

    // 2. Evolution Timeline
    const evolution = {};
    $('.pp-evo-card').each((idx, el) => {
        const label = $(el).find('.pp-evo-card__label').text().trim();
        const desc = $(el).find('.pp-evo-card__desc').text().trim();
        if (label && desc) evolution[label] = desc;
    });

    // 3. Raw Text Body Cleanup
    $('script, style, details, summary, noscript, .pp-wiki-bc, h1, .pp-wiki-sub, .pp-wiki-ib').remove();
    
    const realShortDesc = $('.pp-wiki-body p').first().text().replace(/\s+/g, ' ').trim() || 'N/D';

    let fullContentText = '';
    $('.pp-wiki-body p, .metafield-rich_text_field p').each((idx, el) => {
        const txt = $(el).text().replace(/\s+/g, ' ').trim();
        // Filter out shop specific dynamics or junk buttons
        if (txt && !txt.startsWith('{') && !txt.includes('function()') && !txt.includes('Discovery Set') && !txt.includes('Set di scoperta')) {
            if (!fullContentText.includes(txt)) {
                fullContentText += txt + '\n\n';
            }
        }
    });

    if (!title) return null;

    return {
        term: title,
        category: category,
        short_description: realShortDesc,
        technical_card: techCard,
        evolution: evolution,
        extracted_text_body: fullContentText.trim(),
        url: termUrl
    };
}

async function startScraping(letter) {
    console.log(`Starting dual-language scraper for letter: [${letter}]`);
    const urlsToScanEnglish = [];
    
    // Phase 1: Index Scanning (We use the English index as master)
    for (let page = 1; page <= 7; page++) {
        console.log(`Scanning main index page ${page}/7...`);
        const indexUrl = `${BASE_URL}/pages/glossary-terms?page_b4e05a4c=${page}`;
        
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
                        // Ensure we store the standard English path
                        const cleanHref = href.startsWith('/it/') ? href.substring(3) : href;
                        const fullUrlEn = BASE_URL + cleanHref;
                        if (!urlsToScanEnglish.includes(fullUrlEn)) {
                            urlsToScanEnglish.push(fullUrlEn);
                        }
                    }
                });
            }
        } catch (error) {
            console.error(`Error scanning index page ${page}:`, error.message);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`Found ${urlsToScanEnglish.length} terms for letter ${letter}.`);
    if (urlsToScanEnglish.length === 0) return;

    // Arrays to hold the respective languages
    const glossaryDataEN = [];
    const glossaryDataIT = [];

    // Phase 2: Dual Extraction
    for (let i = 0; i < urlsToScanEnglish.length; i++) {
        const urlEn = urlsToScanEnglish[i];
        // To get the Italian URL, we inject '/it' right after the domain
        const urlIt = urlEn.replace('premierepeau.com/', 'premierepeau.com/it/');
        
        console.log(`[${i + 1}/${urlsToScanEnglish.length}] Processing term...`);

        // --- 1. ENGLISH EXTRACTION ---
        try {
            console.log(`   -> Downloading EN: ${urlEn}`);
            const resEn = await fetch(urlEn, { headers: HEADERS });
            if (resEn.ok) {
                const htmlEn = await resEn.text();
                const dataEn = extractDataFromHtml(htmlEn, urlEn);
                if (dataEn) glossaryDataEN.push(dataEn);
            }
        } catch (err) {
            console.error(`   [Error EN] Failed ${urlEn}:`, err.message);
        }
        await new Promise(resolve => setTimeout(resolve, 300));

        // --- 2. ITALIAN EXTRACTION ---
        try {
            console.log(`   -> Downloading IT: ${urlIt}`);
            const resIt = await fetch(urlIt, { headers: HEADERS });
            if (resIt.ok) {
                const htmlIt = await resIt.text();
                const dataIt = extractDataFromHtml(htmlIt, urlIt);
                if (dataIt) glossaryDataIT.push(dataIt);
            }
        } catch (err) {
            console.error(`   [Error IT] Failed ${urlIt}:`, err.message);
        }

        // Save current progress on every iteration to avoid losing data
        if (glossaryDataEN.length > 0) {
            fs.writeFileSync(`final_glossary_${letter}_en.json`, JSON.stringify(glossaryDataEN, null, 2), 'utf-8');
        }
        if (glossaryDataIT.length > 0) {
            fs.writeFileSync(`final_glossary_${letter}_it.json`, JSON.stringify(glossaryDataIT, null, 2), 'utf-8');
        }

        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`\nProcess complete!`);
    console.log(`Saved: final_glossary_${letter}_en.json (${glossaryDataEN.length} items)`);
    console.log(`Saved: final_glossary_${letter}_it.json (${glossaryDataIT.length} items)`);
}