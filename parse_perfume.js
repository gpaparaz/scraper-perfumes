const fs = require('fs');
const cheerio = require('cheerio');

function parseSavedHtml() {
    console.log('Reading local HTML file...');
    
    const html = fs.readFileSync('guerlain_shalimar.html', 'utf-8');
    const $ = cheerio.load(html);

    // 1. Title and Brand Extraction
    const fullTitle = $('title').text().replace('- Fragrantica', '').trim();
    const brand = "Guerlain"; 

    // 2. Main Description Extraction
    const description = $('div[itemprop="description"]').text().trim() || $('.cell.small-12 p').first().text().trim();

    // 3. Main Accords Extraction (UI Bars)
    const mainAccords = [];
    $('.accord-bar').each((idx, el) => {
        const accordName = $(el).text().trim();
        const styleAttr = $(el).attr('style') || '';
        
        let intensity = null;
        if (styleAttr.includes('width')) {
            const widthValue = styleAttr.split('width:')[1]?.split('%')[0]?.trim();
            if (widthValue) intensity = parseFloat(widthValue);
        }

        if (accordName) {
            mainAccords.push({
                accord: accordName,
                intensity: intensity
            });
        }
    });

    if (mainAccords.length === 0) {
        $('div[style*="width:"]').each((idx, el) => {
            const style = $(el).attr('style') || '';
            const text = $(el).text().trim();
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

    // 4. Olfactory Pyramid Extraction (Robust Ancestor Search)
    const pyramid = {
        top_notes: [],
        heart_notes: [],
        base_notes: []
    };
    
    // Iteriamo direttamente su ogni link delle note presente nella piramide grafica
    $('.pyramid-note-link').each((i, linkEl) => {
        const noteName = $(linkEl).find('.pyramid-note-label').text().trim();
        
        if (noteName) {
            // Cerchiamo l'intestazione h4 precedente più vicina a questo specifico link
            // .prevAll('h4') o cercando l'h4 all'interno del container della sezione
            const sectionContainer = $(linkEl).closest('.mx-auto');
            const layerText = sectionContainer.find('h4').text().toLowerCase().trim();
            
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
    });

    // 5. Build Final Structural Database Object
    const structuredData = {
        title: fullTitle,
        brand: brand,
        description: description,
        main_accords: mainAccords,
        pyramid: pyramid,
        extracted_at: new Date().toISOString()
    };

    // Save output to clean JSON file
    fs.writeFileSync('extracted_perfume_data.json', JSON.stringify(structuredData, null, 2), 'utf-8');
    console.log('Structural parsing completed. Results saved to extracted_perfume_data.json');
}

parseSavedHtml();