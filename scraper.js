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
    
    // Phase 1: Index Scanning
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

    // Phase 2: Structured Extraction
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

            // 1. Technical Card Extraction
            const techCard = {};
            $('.pp-wiki-ib table tr').each((idx, el) => {
                const key = $(el).find('td').eq(0).text().replace(/:/g, '').trim();
                const value = $(el).find('td').eq(1).text().trim();
                if (key && value) techCard[key] = value;
            });

            // 2. Short Description (The block highlighted with a left border)
            const shortDesc = $('.pp-wiki-ff').text().replace(/Pyramid|Cuore/g, '').replace(/\s+/g, ' ').trim() || 'N/D';

            // 3. Evolution Timeline
            const evolution = {};
            $('.pp-evo-card').each((idx, el) => {
                const label = $(el).find('.pp-evo-card__label').text().trim();
                const desc = $(el).find('.pp-evo-card__desc').text().trim();
                if (label && desc) evolution[label] = desc;
            });

            // 4. Content Sections Parsing (State-machine approach based on H2 text)
            let scentProfile = '';
            let fullStory = '';
            let funFact = '';
            let inInPerfumes = '';

            // Remove scripts and styles to avoid code leaking into text
            $('script, style, details, summary, noscript').remove();

            // We iterate through all direct children of the content body
            let currentSection = '';
            $('.pp-wiki-body').children().each((idx, el) => {
                const node = $(el);

                // When we hit an H2, we change the current section target
                if (node.is('h2')) {
                    const h2Text = node.text().toLowerCase().trim();
                    if (h2Text.includes('scent') || h2Text.includes('profumo')) {
                        currentSection = 'scent';
                    } else if (h2Text.includes('story') || h2Text.includes('storia')) {
                        currentSection = 'story';
                    } else if (h2Text.includes('did you know') || h2Text.includes('sapevi') || h2Text.includes('fact') || h2Text.includes('curiosità')) {
                        currentSection = 'fact';
                    } else if (h2Text.includes('perfumery') || h2Text.includes('profumeria')) {
                        currentSection = 'perfumes';
                    } else {
                        currentSection = ''; // Reset for untracked sections like extraction/chemistry
                    }
                } 
                // If it's a paragraph, we append the text to the active section
                else if (node.is('p') || node.hasClass('metafield-rich_text_field')) {
                    const paragraphText = node.text().replace(/\s+/g, ' ').trim();
                    if (paragraphText && !paragraphText.startsWith('{')) {
                        if (currentSection === 'scent') scentProfile += paragraphText + ' ';
                        if (currentSection === 'story') fullStory += paragraphText + ' ';
                        if (currentSection === 'fact') funFact += paragraphText + ' ';
                        if (currentSection === 'perfumes') inInPerfumes += paragraphText + ' ';
                    }
                }
            });

            if (title) {
                glossaryData.push({
                    term: title,
                    category: category,
                    short_description: shortDesc,
                    technical_card: techCard,
                    scent_profile: scentProfile.trim(),
                    evolution: evolution,
                    full_story: fullStory.trim(),
                    in_perfumery: inInPerfumes.trim(),
                    fun_fact: funFact.trim(),
                    url: termUrl
                });

                fs.writeFileSync(
                    `structured_glossary_${letter}.json`, 
                    JSON.stringify(glossaryData, null, 2), 
                    'utf-8'
                );
            }

            await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error) {
            console.error(`Failed to download ${termUrl}:`, error.message);
        }
    }

    console.log(`Process complete. Output saved to structured_glossary_${letter}.json`);
}