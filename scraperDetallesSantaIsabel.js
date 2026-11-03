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

// Normalizador EAN-13 idéntico al de Lider para asegurar coincidencia 100% exacta
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

async function rasparDetallesSantaIsabel() {
    try {
        console.log('1. Buscando productos de Santa Isabel incompletos o sin cruzar...');
        
        const [productos] = await pool.query(`
            SELECT p.id, p.nombre, p.codigo_barras, p.info_nutricional, pp.url_producto 
            FROM productos p
            JOIN precios_productos pp ON p.id = pp.producto_id
            WHERE (p.codigo_barras IS NULL OR p.info_nutricional IS NULL)
            AND pp.url_producto LIKE '%santaisabel.cl%'
            LIMIT 5000
        `);

        if (productos.length === 0) {
            console.log('✅ Todos los productos de Santa Isabel están completos o ya fueron revisados.');
            process.exit(0);
        }

        console.log(`¡Vamos a raspar ${productos.length} productos usando concurrencia (Modo Pulpo)!`);

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

                    // 1. EXTRAER CÓDIGO EAN Y NORMALIZAR A 13 DÍGITOS
                    let codigoExtraido = await page.evaluate(() => {
                        const scripts = document.querySelectorAll('script');
                        for (const script of scripts) {
                            const contenido = script.textContent || script.innerText || '';
                            const match = contenido.match(/"gtin(?:13)?"\s*:\s*"(\d+)"/i);
                            if (match && match[1]) return match[1]; 
                        }
                        return null;
                    });

                    if (codigoExtraido) {
                        codigoExtraido = normalizarEAN13(codigoExtraido);
                    }

                    // 2. EXTRAER TABLA NUTRICIONAL DINÁMICA
                    await page.evaluate(() => {
                        window.scrollBy(0, 800);
                        const acordeones = document.querySelectorAll('details summary');
                        acordeones.forEach(btn => {
                            if (btn.textContent.toLowerCase().includes('nutricional')) {
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
                    
                    // ==========================================
                    // 3. FUSIÓN EXACTA POR EAN-13 CON LIDER
                    // ==========================================
                    if (codigoExtraido) {
                        const [duplicado] = await pool.query(
                            `SELECT id, info_nutricional FROM productos 
                             WHERE id != ? AND codigo_barras = ? 
                             LIMIT 1`, 
                            [prod.id, codigoExtraido]
                        );
                        
                        if (duplicado.length > 0) {
                            const idOriginal = duplicado[0].id;
                            const infoOriginal = duplicado[0].info_nutricional;
                            console.log(`⚠️ ¡Cruce EAN-13 exitoso (${codigoExtraido})! Uniendo "${prod.nombre}" con ID: ${idOriginal}...`);
                            
                            // Si Santa Isabel tiene tabla nutricional y el original no tenía (o estaba como "No disponible"), actualizamos
                            if (infoLimpia && (!infoOriginal || infoOriginal.includes('No disponible'))) {
                                await pool.query(
                                    "UPDATE productos SET info_nutricional = ? WHERE id = ?",
                                    [JSON.stringify(infoLimpia), idOriginal]
                                );
                            }

                            // Movemos el precio de Santa Isabel y su historial al producto original
                            await pool.query("UPDATE IGNORE precios_productos SET producto_id = ? WHERE producto_id = ?", [idOriginal, prod.id]);
                            await pool.query("UPDATE IGNORE historial_precios SET producto_id = ? WHERE producto_id = ?", [idOriginal, prod.id]);
                            
                            // Limpiamos registros huérfanos y borramos el duplicado
                            await pool.query("DELETE FROM precios_productos WHERE producto_id = ?", [prod.id]);
                            await pool.query("DELETE FROM historial_precios WHERE producto_id = ?", [prod.id]);
                            await pool.query("DELETE FROM productos WHERE id = ?", [prod.id]);
                            
                            console.log(`✅ Fusión completada en el ID ${idOriginal}.`);
                            return; 
                        } else {
                            await pool.query("UPDATE productos SET codigo_barras = ? WHERE id = ?", [codigoExtraido, prod.id]);
                            console.log(`✅ Código ${codigoExtraido} guardado para: ${prod.nombre}`);
                        }
                        
                    } else if (prod.codigo_barras === null) {
                        await pool.query("UPDATE productos SET codigo_barras = ? WHERE id = ?", [`SIN_CODIGO_${prod.id}`, prod.id]);
                        console.log(`❌ Sin código en la web. Marcado como SIN_CODIGO_${prod.id}`);
                    }

                    // Guardar Info Nutricional si el producto no se fusionó/eliminó
                    if (infoLimpia) {
                        await pool.query("UPDATE productos SET info_nutricional = ? WHERE id = ?", [JSON.stringify(infoLimpia), prod.id]);
                        console.log(`✅ Nutrientes guardados para: ${prod.nombre}`);
                    } else if (prod.info_nutricional === null) {
                        await pool.query("UPDATE productos SET info_nutricional = ? WHERE id = ?", [JSON.stringify({"estado": "No disponible"}), prod.id]);
                        console.log(`❌ Sin tabla nutricional. Marcado como 'No disponible'.`);
                    }

                } catch (err) {
                    console.error(`❌ Error en ${prod.nombre}:`, err.message);
                } finally {
                    await page.close();
                }
            }));
            
            procesados += lote.length;
            console.log(`📊 Avance: ${procesados} de ${productos.length} productos.`);
            
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log('\n🚀 ¡Proceso de detalles y fusión de Santa Isabel completado!');
        await browser.close();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error general:', error);
        process.exit(1);
    }
}

rasparDetallesSantaIsabel();