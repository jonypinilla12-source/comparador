const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const pool = require('./db');

function dividirEnLotes(arreglo, tamañoLote) {
    const lotes = [];
    for (let i = 0; i < arreglo.length; i += tamañoLote) {
        lotes.push(arreglo.slice(i, i + tamañoLote));
    }
    return lotes;
}

async function rasparDetallesUnimarc() {
    try {
        console.log('1. Buscando productos de Unimarc sin información nutricional...');
        
        const [productos] = await pool.query(`
            SELECT p.id, p.nombre, pp.url_producto 
            FROM productos p
            JOIN precios_productos pp ON p.id = pp.producto_id
            WHERE p.info_nutricional IS NULL
            AND pp.url_producto LIKE '%unimarc.cl%'
            GROUP BY p.id
            LIMIT 5000
        `);

        if (productos.length === 0) {
            console.log('✅ Todos los productos de Unimarc ya tienen su información nutricional revisada.');
            process.exit(0);
        }

        console.log(`¡Vamos a raspar los nutrientes de ${productos.length} productos de Unimarc de forma sigilosa!`);

        const browser = await puppeteer.launch({ 
            headless: process.env.CI ? 'new' : false, 
            defaultViewport: { width: 1366, height: 768 },
            args: [
                '--start-maximized',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ]
        });

        // BAJAMOS LA CONCURRENCIA A 2 PARA NO DESPERTAR AL FIREWALL DE AKAMAI
        const lotes = dividirEnLotes(productos, 10);
        let procesados = 0;
        let conNutrientes = 0;
        let sinNutrientes = 0;

        for (const lote of lotes) {
            console.log(`\n=============================================`);
            console.log(`🐙 Procesando lote de ${lote.length} productos de Unimarc...`);
            
            await Promise.all(lote.map(async (prod) => {
                const page = await browser.newPage();
                
                // Inyectamos un User-Agent de un navegador real de Windows
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

                // ELIMINAMOS el bloqueo de imágenes. Dejamos que cargue todo como un humano real.

                try {
                    console.log(`➡️ Abriendo: ${prod.nombre}`);
                    await page.goto(prod.url_producto, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    
                    // Tiempo de espera un poco mayor para simular lectura humana
                    await new Promise(resolve => setTimeout(resolve, 3500));

                    await page.evaluate(() => {
                        window.scrollBy(0, 700);
                        const clickables = document.querySelectorAll('button, summary, div[role="button"], h2, h3, span');
                        clickables.forEach(el => {
                            const txt = (el.innerText || '').toLowerCase();
                            if (txt.includes('nutricional') || txt.includes('nutrición')) {
                                try { el.click(); } catch (e) {}
                            }
                        });
                    });

                    await new Promise(resolve => setTimeout(resolve, 2000));

                    const infoLimpia = await page.evaluate(() => {
                        const info = {};

                        const filas = document.querySelectorAll('table tr, div[role="row"], li[class*="nutrition"], div[class*="nutrition"], div[class*="Nutritional"]');
                        filas.forEach(fila => {
                            const columnas = fila.querySelectorAll('td, th, div[role="cell"], span, p');
                            if (columnas.length >= 2) {
                                const llave = columnas[0].innerText.replace(/•|:/g, '').trim();
                                const valor = columnas[1].innerText.replace(/•/g, '').trim();

                                if (
                                    llave !== "" && 
                                    valor !== "" && 
                                    llave.length < 45 &&
                                    valor.length < 30 &&
                                    llave.toLowerCase() !== valor.toLowerCase() &&
                                    !llave.toLowerCase().includes('100g') && 
                                    !llave.toLowerCase().includes('100 g') &&
                                    !llave.toLowerCase().includes('porción') &&
                                    !llave.toLowerCase().includes('valores medios')
                                ) {
                                    info[llave] = valor;
                                }
                            }
                        });

                        if (Object.keys(info).length > 0) return info;

                        const scriptNext = document.getElementById('__NEXT_DATA__');
                        if (scriptNext) {
                            try {
                                const nextObj = JSON.parse(scriptNext.textContent);
                                const strJson = JSON.stringify(nextObj);
                                
                                const nutrientesClave = [
                                    { key: 'Energía (kcal)', regex: /"Energ[íi]a[^"]*"\s*:\s*"([^"]+)"/i },
                                    { key: 'Proteínas (g)', regex: /"Prote[íi]nas[^"]*"\s*:\s*"([^"]+)"/i },
                                    { key: 'Grasas Totales (g)', regex: /"Grasas\s*Totales[^"]*"\s*:\s*"([^"]+)"/i },
                                    { key: 'Hidratos de Carbono (g)', regex: /"Hidratos\s*de\s*Carbono[^"]*"\s*:\s*"([^"]+)"/i },
                                    { key: 'Azúcares Totales (g)', regex: /"Az[úu]cares\s*Totales[^"]*"\s*:\s*"([^"]+)"/i },
                                    { key: 'Sodio (mg)', regex: /"Sodio[^"]*"\s*:\s*"([^"]+)"/i }
                                ];

                                nutrientesClave.forEach(n => {
                                    const m = strJson.match(n.regex);
                                    if (m && m[1]) info[n.key] = m[1].trim();
                                });
                            } catch (e) {}
                        }

                        return Object.keys(info).length > 0 ? info : null;
                    });

                    if (infoLimpia) {
                        await pool.query(
                            "UPDATE productos SET info_nutricional = ? WHERE id = ?", 
                            [JSON.stringify(infoLimpia), prod.id]
                        );
                        conNutrientes++;
                        console.log(`✅ Nutrientes guardados para: ${prod.nombre}`);
                    } else {
                        await pool.query(
                            "UPDATE productos SET info_nutricional = ? WHERE id = ?", 
                            [JSON.stringify({ "estado": "No disponible" }), prod.id]
                        );
                        sinNutrientes++;
                        console.log(`⚪ Sin tabla nutricional (${prod.nombre}). Marcado 'No disponible'.`);
                    }

                } catch (err) {
                    console.error(`❌ Error en ${prod.nombre}:`, err.message);
                } finally {
                    await page.close();
                }
            }));
            
            procesados += lote.length;
            console.log(`📊 Avance: ${procesados} de ${productos.length} revisados (Con tabla: ${conNutrientes} | Sin tabla: ${sinNutrientes}).`);
            
            // Pausa obligatoria entre lotes para evitar baneos
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        console.log('\n======================================================');
        console.log('🚀 ¡Proceso de detalles nutricionales de Unimarc completado!');
        console.log(`📊 RESUMEN: Con nutrientes: ${conNutrientes} | No disponible: ${sinNutrientes}`);
        console.log('======================================================\n');

        await browser.close();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error general en rasparDetallesUnimarc:', error);
        process.exit(1);
    }
}

rasparDetallesUnimarc();