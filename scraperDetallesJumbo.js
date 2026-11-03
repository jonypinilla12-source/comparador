const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const pool = require('./db');

// Función auxiliar para dividir el arreglo en "lotes"
function dividirEnLotes(arreglo, tamañoLote) {
    const lotes = [];
    for (let i = 0; i < arreglo.length; i += tamañoLote) {
        lotes.push(arreglo.slice(i, i + tamañoLote));
    }
    return lotes;
}

// NUEVA BARRERA: Analiza nombres y gramajes para detectar EANs genéricos/falsos
function esFalsoPositivo(nombre1, nombre2) {
    const n1 = (nombre1 || '').toLowerCase();
    const n2 = (nombre2 || '').toLowerCase();

    // 1. Comparar números (pesos, cc, gramos, packs)
    const nums1 = n1.match(/\d+(?:[.,]\d+)?/g) || [];
    const nums2 = n2.match(/\d+(?:[.,]\d+)?/g) || [];
    
    // Si tienen números (ej: 80 vs 140) y no coinciden exactamente, es falso positivo
    if (nums1.join('-') !== nums2.join('-')) return true;

    // 2. Comparar palabras clave (sabores, variedades) eliminando palabras cortas
    const palabras1 = n1.replace(/[^a-záéíóúñ]/g, ' ').split(' ').filter(p => p.length > 2);
    const palabras2 = n2.replace(/[^a-záéíóúñ]/g, ' ').split(' ').filter(p => p.length > 2);

    let comunes = 0;
    palabras1.forEach(p => { if (palabras2.includes(p)) comunes++; });

    const maxPalabras = Math.max(palabras1.length, palabras2.length);
    if (maxPalabras > 0) {
        const similitud = comunes / maxPalabras;
        // Si comparten menos del 75% de las palabras (ej: Manzana vs Pera), bloquea la fusión
        if (similitud < 0.75) return true; 
    }

    return false;
}

async function rasparDetallesJumbo() {
    try {
        console.log('1. Buscando productos de Jumbo incompletos...');
        
        const [productos] = await pool.query(`
            SELECT p.id, p.nombre, p.marca, p.codigo_barras, p.info_nutricional, pp.url_producto 
            FROM productos p
            JOIN precios_productos pp ON p.id = pp.producto_id
            WHERE (p.codigo_barras IS NULL OR p.info_nutricional IS NULL)
            AND pp.url_producto LIKE '%jumbo.cl%'
            GROUP BY p.id
            LIMIT 5000
        `);

        if (productos.length === 0) {
            console.log('✅ Todos los productos de Jumbo están completos o ya fueron revisados.');
            process.exit(0);
        }

        console.log(`¡Vamos a raspar ${productos.length} productos usando concurrencia (Modo Pulpo)!`);

        const browser = await puppeteer.launch({ 
            headless: false, 
            defaultViewport: null,
            args: ['--start-maximized']
        }); 

        // Lote reducido a 10 para mayor estabilidad SQL
        const lotes = dividirEnLotes(productos, 10);
        let procesados = 0;

        for (const lote of lotes) {
            console.log(`\n=============================================`);
            console.log(`🐙 Procesando lote de ${lote.length} productos de Jumbo a la vez...`);
            
            await Promise.all(lote.map(async (prod) => {
                const page = await browser.newPage();
                
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    if (req.resourceType() === 'image' || req.resourceType() === 'media' || req.resourceType() === 'font') {
                        req.abort();
                    } else {
                        req.continue();
                    }
                });

                try {
                    console.log(`➡️ Abriendo: ${prod.nombre}`);
                    await page.goto(prod.url_producto, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    await new Promise(resolve => setTimeout(resolve, 3000));

                    let codigoExtraido = await page.evaluate(() => {
                        const scripts = document.querySelectorAll('script');
                        for (const script of scripts) {
                            const contenido = script.textContent || '';
                            const match = contenido.match(/"(?:gtin13|gtin|ean|barcode)"\s*:\s*"(\d{13})"|"(?:gtin13|gtin|ean|barcode)"\s*:\s*"(78\d{11})"/i);
                            if (match && (match[1] || match[2])) {
                                return match[1] || match[2];
                            }
                        }
                        const html = document.documentElement.innerHTML;
                        const matchHtml = html.match(/"(?:gtin13|gtin|ean)"\s*:\s*"(\d{13})"/i);
                        if (matchHtml && matchHtml[1]) return matchHtml[1];
                        return null;
                    });

                    if (codigoExtraido) {
                        codigoExtraido = codigoExtraido.replace(/^0+/, '');
                    }

                    await page.evaluate(() => {
                        window.scrollBy(0, 800);
                        const acordeones = document.querySelectorAll('details summary');
                        acordeones.forEach(btn => {
                            if (btn.textContent.toLowerCase().includes('nutricional') || btn.textContent.toLowerCase().includes('nutrición')) {
                                const detailsPadre = btn.closest('details');
                                if (detailsPadre && !detailsPadre.hasAttribute('open')) {
                                    btn.click();
                                }
                            }
                        });
                    });
                    
                    await new Promise(resolve => setTimeout(resolve, 2000)); 

                    const infoLimpia = await page.evaluate(() => {
                        const info = {};
                        const filas = document.querySelectorAll('table tr, div[role="row"]');
                        if (filas.length === 0) return null;
                        
                        filas.forEach(fila => {
                            const columnas = fila.querySelectorAll('td, div[role="cell"]');
                            if (columnas.length >= 2) {
                                const llave = columnas[0].innerText.replace(/•/g, '').trim();
                                const valor = columnas[1].innerText.replace(/•/g, '').trim();
                                
                                if (llave !== "" && !llave.toLowerCase().includes('100g') && !llave.toLowerCase().includes('valores medios')) {
                                    info[llave] = valor;
                                }
                            }
                        });

                        if (Object.keys(info).length === 0) return null;
                        return info;
                    });
                    
                    if (codigoExtraido && prod.codigo_barras === null) {
                        
                        const [duplicados] = await pool.query(
                            "SELECT id, nombre, marca FROM productos WHERE codigo_barras = ? AND id != ? LIMIT 1", 
                            [codigoExtraido, prod.id]
                        );
                        
                        if (duplicados.length > 0) {
                            const original = duplicados[0];
                            const marcaOrig = (original.marca || '').trim().toLowerCase();
                            const marcaActual = (prod.marca || '').trim().toLowerCase();

                            const marcasCoinciden = (
                                marcaOrig === marcaActual || 
                                marcaOrig === 'sin marca' || 
                                marcaActual === 'sin marca'
                            );
                            
                            // Evaluación estricta de nombres y pesos
                            const posibleFalsoPositivo = esFalsoPositivo(original.nombre, prod.nombre);

                            if (marcasCoinciden && !posibleFalsoPositivo) {
                                const idOriginal = original.id;
                                console.log(`⚠️ ¡Cruce exitoso en Jumbo! Uniendo "${prod.nombre}" con "${original.nombre}" (ID: ${idOriginal})...`);
                                
                                // UPDATE IGNORE soluciona el error SQL de duplicado el mismo día
                                await pool.query("UPDATE IGNORE precios_productos SET producto_id = ? WHERE producto_id = ?", [idOriginal, prod.id]);
                                
                                // Borramos cualquier precio huérfano sobrante antes de eliminar el producto
                                await pool.query("DELETE FROM precios_productos WHERE producto_id = ?", [prod.id]);
                                
                                if (infoLimpia) {
                                    await pool.query(
                                        "UPDATE productos SET info_nutricional = COALESCE(info_nutricional, ?) WHERE id = ?", 
                                        [JSON.stringify(infoLimpia), idOriginal]
                                    );
                                }

                                await pool.query("DELETE FROM productos WHERE id = ?", [prod.id]);
                                console.log(`✅ Fusión completada.`);
                                return; 
                            } else {
                                const motivo = posibleFalsoPositivo ? 'Sabores/Gramajes distintos' : 'Marcas distintas';
                                console.log(`🛑 Alerta de Falso Positivo evitado (${motivo}): EAN ${codigoExtraido}. No se fusiona "${prod.nombre}" con "${original.nombre}".`);
                                await pool.query("UPDATE productos SET codigo_barras = ? WHERE id = ?", [`${codigoExtraido}_JUMBO_${prod.id}`, prod.id]);
                            }
                        } else {
                            await pool.query("UPDATE productos SET codigo_barras = ? WHERE id = ?", [codigoExtraido, prod.id]);
                            console.log(`✅ Código EAN (${codigoExtraido}) guardado para Jumbo: ${prod.nombre}`);
                        }
                        
                    } else if (prod.codigo_barras === null) {
                        await pool.query("UPDATE productos SET codigo_barras = ? WHERE id = ?", [`SIN_CODIGO_${prod.id}`, prod.id]);
                        console.log(`❌ Sin código web. Marcado como SIN_CODIGO_${prod.id}`);
                    }

                    if (infoLimpia) {
                        await pool.query("UPDATE productos SET info_nutricional = ? WHERE id = ?", [JSON.stringify(infoLimpia), prod.id]);
                        console.log(`✅ Nutrientes guardados para: ${prod.nombre}`);
                    } else if (prod.info_nutricional === null) {
                        await pool.query("UPDATE productos SET info_nutricional = ? WHERE id = ?", [JSON.stringify({"estado": "No disponible"}), prod.id]);
                        console.log(`❌ Sin tabla. Marcado 'No disponible'.`);
                    }

                } catch (err) {
                    console.error(`❌ Error en ${prod.nombre}:`, err.message);
                } finally {
                    await page.close();
                }
            }));
            
            procesados += lote.length;
            console.log(`📊 Avance: ${procesados} de ${productos.length} productos de Jumbo.`);
            
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log('\n🚀 ¡Proceso de detalles Jumbo completado a toda velocidad!');
        await browser.close();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error general:', error);
        process.exit(1);
    }
}

rasparDetallesJumbo();