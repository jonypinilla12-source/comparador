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

// Función que convierte los códigos de 12 dígitos de Lider al estándar EAN-13 completo
function normalizarEAN13(codigo) {
    if (!codigo) return null;
    
    let limpio = codigo.toString().trim().replace(/^0+/, '');

    if (limpio.length === 13) {
        return limpio;
    }

    if (limpio.length === 12 && /^\d{12}$/.test(limpio)) {
        let suma = 0;
        for (let i = 0; i < 12; i++) {
            const digito = parseInt(limpio[i], 10);
            suma += (i % 2 === 0) ? digito * 1 : digito * 3;
        }
        const resto = suma % 10;
        const digitoVerificador = resto === 0 ? 0 : 10 - resto;
        return limpio + digitoVerificador.toString();
    }

    return limpio;
}

async function rasparDetallesLider() {
    try {
        console.log('1. Buscando productos de Lider para extraer código de barras e información nutricional...');
        
        const [productos] = await pool.query(`
            SELECT p.id as producto_id, p.nombre, p.codigo_barras, p.info_nutricional, pp.url_producto 
            FROM productos p
            JOIN precios_productos pp ON p.id = pp.producto_id
            WHERE (p.info_nutricional IS NULL OR p.codigo_barras IS NULL)
            AND pp.url_producto LIKE '%lider.cl%'
            LIMIT 5000
        `);

        if (productos.length === 0) {
            console.log('✅ Todos los productos de Lider listos.');
            process.exit(0);
        }

        console.log(`¡Vamos a raspar ${productos.length} productos en Modo Pulpo!`);

        const browser = await puppeteer.launch({ 
            headless: false, 
            defaultViewport: null,
            args: ['--start-maximized']
        }); 

        const lotes = dividirEnLotes(productos, 30);
        let procesados = 0;

        for (const lote of lotes) {
            console.log(`\n=============================================`);
            console.log(`🐙 Procesando lote de ${lote.length} productos a la vez...`);

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
                    
                    // ==========================================
                    // 1. EXTRAER Y NORMALIZAR CÓDIGO EAN-13
                    // ==========================================
                    let codigoExtraido = await page.evaluate(() => {
                        const scripts = document.querySelectorAll('script');
                        for (const script of scripts) {
                            const contenido = script.textContent || '';
                            const match = contenido.match(/"(?:gtin13|gtin)"\s*:\s*"(\d+)"/i);
                            if (match && match[1]) return match[1];
                        }
                        return null;
                    });

                    // ==========================================
                    // 2. EXTRAER TABLA NUTRICIONAL
                    // ==========================================
                    await page.evaluate(() => {
                        window.scrollBy(0, 800);
                        const botones = document.querySelectorAll('button');
                        botones.forEach(btn => {
                            if (btn.innerText.includes('Ficha nutricional') || (btn.getAttribute('aria-label') && btn.getAttribute('aria-label').includes('Ficha nutricional'))) {
                                if (btn.getAttribute('aria-expanded') === 'false') {
                                    btn.click();
                                }
                            }
                        });
                    });

                    await new Promise(resolve => setTimeout(resolve, 1500)); 

                    const infoLimpia = await page.evaluate(() => {
                        const info = {};
                        const filas = document.querySelectorAll('table tr, div[role="row"]');
                        
                        if (filas.length > 0) {
                            filas.forEach(fila => {
                                const columnas = fila.querySelectorAll('td, th, div[role="cell"], div[role="columnheader"]');
                                if (columnas.length >= 2) {
                                    const llave = columnas[0].innerText.trim();
                                    const valor100g = columnas[1].innerText.trim(); 
                                    
                                    if (llave !== "" && !llave.toLowerCase().includes('100g') && !llave.toLowerCase().includes('porción')) {
                                        info[llave] = valor100g;
                                    }
                                }
                            });
                        }
                        
                        if (Object.keys(info).length === 0) return null;
                        return info;
                    });

                    // ==========================================
                    // 3. FUSIÓN DE DUPLICADOS INTERNOS EN LIDER
                    // ==========================================
                    if (codigoExtraido) {
                        codigoExtraido = normalizarEAN13(codigoExtraido);
                        
                        // Buscamos si este código de barras EAN-13 ya existía en la base de datos bajo OTRO id
                        const [duplicado] = await pool.query(
                            `SELECT id, info_nutricional FROM productos 
                             WHERE id != ? AND codigo_barras = ? 
                             LIMIT 1`, 
                            [prod.producto_id, codigoExtraido]
                        );

                        if (duplicado.length > 0) {
                            const idOriginal = duplicado[0].id;
                            const infoOriginal = duplicado[0].info_nutricional;
                            console.log(`⚠️ ¡Duplicado interno detectado en Lider (${codigoExtraido})! Uniendo "${prod.nombre}" con ID: ${idOriginal}...`);
                            
                            // Si la extracción actual tiene nutrientes y el original no tenía, se los pasamos
                            if (infoLimpia && (!infoOriginal || infoOriginal.includes('No disponible'))) {
                                await pool.query(
                                    "UPDATE productos SET info_nutricional = ? WHERE id = ?",
                                    [JSON.stringify(infoLimpia), idOriginal]
                                );
                            }

                            // Movemos el precio y el historial de este duplicado hacia el ID original
                            await pool.query("UPDATE IGNORE precios_productos SET producto_id = ? WHERE producto_id = ?", [idOriginal, prod.producto_id]);
                            await pool.query("UPDATE IGNORE historial_precios SET producto_id = ? WHERE producto_id = ?", [idOriginal, prod.producto_id]);
                            
                            // Borramos los registros huérfanos del duplicado
                            await pool.query("DELETE FROM precios_productos WHERE producto_id = ?", [prod.producto_id]);
                            await pool.query("DELETE FROM historial_precios WHERE producto_id = ?", [prod.producto_id]);
                            await pool.query("DELETE FROM productos WHERE id = ?", [prod.producto_id]);
                            
                            console.log(`✅ Fusión interna completada en el ID ${idOriginal}.`);
                            return; // Terminamos con este producto, ya fue fusionado
                        } else {
                            // Si el código NO existía, simplemente lo guardamos en el producto actual
                            await pool.query(
                                "UPDATE productos SET codigo_barras = ? WHERE id = ?",
                                [codigoExtraido, prod.producto_id]
                            );
                            console.log(`📦 Código EAN-13 ${codigoExtraido} guardado para: ${prod.nombre}`);
                        }
                    } else if (prod.codigo_barras === null) {
                        await pool.query(
                            "UPDATE productos SET codigo_barras = ? WHERE id = ?",
                            [`SIN_CODIGO_${prod.producto_id}`, prod.producto_id]
                        );
                        console.log(`⚠️ Sin código en la web. Marcado SIN_CODIGO_${prod.producto_id}`);
                    }

                    // ==========================================
                    // 4. GUARDAR NUTRIENTES SI NO FUE FUSIONADO
                    // ==========================================
                    if (infoLimpia) {
                        await pool.query(
                            "UPDATE productos SET info_nutricional = ? WHERE id = ?",
                            [JSON.stringify(infoLimpia), prod.producto_id]
                        );
                        console.log(`✅ Nutrientes guardados para: ${prod.nombre}`);
                    } else if (prod.info_nutricional === null) {
                        await pool.query(
                            "UPDATE productos SET info_nutricional = ? WHERE id = ?",
                            [JSON.stringify({"estado": "No disponible"}), prod.producto_id]
                        );
                        console.log(`⚠️ Sin tabla nutricional. Marcado 'No disponible' para: ${prod.nombre}`);
                    }

                } catch (err) {
                    console.error(`❌ Error en ${prod.nombre}:`, err.message);
                } finally {
                    await page.close();
                }
            }));

            procesados += lote.length;
            console.log(`📊 Avance: ${procesados} de ${productos.length} productos de Lider.`);
            
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log('\n🚀 ¡Proceso de Lider completado a toda velocidad!');
        await browser.close();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error general:', error);
        process.exit(1);
    }
}

rasparDetallesLider();