const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const pool = require('./db');

const categoriasSantaIsabel = [
    'https://www.santaisabel.cl/despensa',
    'https://www.santaisabel.cl/lacteos-huevos-y-congelados',
    'https://www.santaisabel.cl/botilleria',
    'https://www.santaisabel.cl/carnes-y-pescados',
    'https://www.santaisabel.cl/chocolates-galletas-y-snacks',
    'https://www.santaisabel.cl/limpieza',
    'https://www.santaisabel.cl/frutas-y-verduras'
];

async function explorarSantaIsabel() {
    try {
        console.log('1. Verificando supermercado Santa Isabel...');
        let supermercadoId;
        const [supermercados] = await pool.query("SELECT id FROM supermercados WHERE nombre = 'Santa Isabel'");
        
        if (supermercados.length > 0) {
            supermercadoId = supermercados[0].id;
        } else {
            const [nuevoSuper] = await pool.query("INSERT INTO supermercados (nombre, direccion) VALUES (?, ?)", ['Santa Isabel', 'Curicó']);
            supermercadoId = nuevoSuper.insertId;
        }

        const browser = await puppeteer.launch({ headless: true, defaultViewport: null, args: ['--start-maximized'] }); 
        const page = await browser.newPage();

        // Contadores Globales
        let totalNuevosGlobal = 0;
        let totalExistentesGlobal = 0;

        for (const urlCategoria of categoriasSantaIsabel) {
            console.log(`\n======================================================`);
            console.log(`🚀 INICIANDO NUEVA CATEGORÍA: ${urlCategoria}`);
            
            for (let numPagina = 1; numPagina <= 100; numPagina++) {
                const urlActual = `${urlCategoria}?page=${numPagina}`;
                console.log(`➡️ PÁGINA ${numPagina}: ${urlActual}`);
                
                await page.goto(urlActual, { waitUntil: 'networkidle2', timeout: 60000 }); 
                await new Promise(resolve => setTimeout(resolve, 5000));

                await page.evaluate(async () => {
                    await new Promise((resolve) => {
                        let totalHeight = 0;
                        let distance = 200;
                        let timer = setInterval(() => {
                            let scrollHeight = document.body.scrollHeight;
                            window.scrollBy(0, distance);
                            totalHeight += distance;
                            if(totalHeight >= scrollHeight - window.innerHeight){ clearInterval(timer); resolve(); }
                        }, 150);
                    });
                });

                const productosExtraidos = await page.evaluate(() => {
                    const cajasDeProducto = document.querySelectorAll('div[data-cnstrc-item-name]');
                    const resultados = [];
                    
                    cajasDeProducto.forEach(caja => {
                        const nombre = caja.getAttribute('data-cnstrc-item-name');
                        const precioTexto = caja.getAttribute('data-cnstrc-item-price');
                        const precio = parseInt(precioTexto) || 0;
                        
                        const enlaceEl = caja.querySelector('a');
                        const imgEl = caja.querySelector('img');
                        
                        if (nombre && enlaceEl && precio > 0) {
                            let marca = 'Sin marca';
                            try {
                                const jsonStr = enlaceEl.getAttribute('data-gtm-product-click');
                                if (jsonStr) {
                                    const jsonObj = JSON.parse(jsonStr);
                                    if (jsonObj.brand) marca = jsonObj.brand;
                                }
                            } catch (e) {}
                            
                            const urlParcial = enlaceEl.getAttribute('href');
                            const url_producto = urlParcial.startsWith('http') ? urlParcial : `https://www.santaisabel.cl${urlParcial}`;
                            const url_imagen = imgEl ? imgEl.getAttribute('src') : null;
                            
                            resultados.push({ 
                                nombre: nombre.trim(), 
                                marca: marca.trim(), 
                                precio, 
                                url_producto, 
                                url_imagen 
                            });
                        }
                    });
                    return resultados;
                });

                console.log(`¡Se extrajeron ${productosExtraidos.length} productos!`);

                if (productosExtraidos.length === 0) {
                    console.log('⚠️ No hay más productos. Saltando a la siguiente categoría...');
                    break; 
                }

                console.log('Guardando en MySQL...');
                let nuevosPagina = 0;
                let existentesPagina = 0;

                for (const prod of productosExtraidos) {
                    let productoId;
                    
                    // Cruce estricto por Nombre y Marca para enganchar con lo que ya guardó Lider o Jumbo
                    const [existente] = await pool.query(
                        `SELECT id FROM productos WHERE LOWER(nombre) = LOWER(?) AND LOWER(marca) = LOWER(?) LIMIT 1`, 
                        [prod.nombre, prod.marca]
                    );
                    
                    if (existente.length > 0) {
                        productoId = existente[0].id;
                        await pool.query(
                            "UPDATE productos SET url_imagen = COALESCE(url_imagen, ?) WHERE id = ?",
                            [prod.url_imagen, productoId]
                        );
                        existentesPagina++;
                        totalExistentesGlobal++;
                    } else {
                        const [nuevoProd] = await pool.query(
                            "INSERT INTO productos (nombre, marca, url_imagen) VALUES (?, ?, ?)", 
                            [prod.nombre, prod.marca, prod.url_imagen]
                        );
                        productoId = nuevoProd.insertId;
                        nuevosPagina++;
                        totalNuevosGlobal++;
                    }

                    // GESTIÓN DE PRECIO ACTUAL (Evitar duplicados el mismo día)
                    const [precioExistente] = await pool.query(
                        "SELECT id, precio, DATE(escaneado_en) as fecha_scan FROM precios_productos WHERE producto_id = ? AND supermercado_id = ? ORDER BY escaneado_en DESC LIMIT 1",
                        [productoId, supermercadoId]
                    );

                    let necesitaActualizarPrecio = true;

                    if (precioExistente.length > 0) {
                        const ultimoPrecio = precioExistente[0];
                        const esMismoDia = ultimoPrecio.fecha_scan && ultimoPrecio.fecha_scan.toISOString().split('T')[0] === new Date().toISOString().split('T')[0];
                        
                        if (esMismoDia && ultimoPrecio.precio === prod.precio) {
                             necesitaActualizarPrecio = false;
                        } else if (!esMismoDia) {
                            if (ultimoPrecio.precio !== prod.precio) {
                                await pool.query(
                                    "UPDATE precios_productos SET precio_anterior = ?, precio = ?, url_producto = ?, escaneado_en = NOW() WHERE id = ?",
                                    [ultimoPrecio.precio, prod.precio, prod.url_producto, ultimoPrecio.id]
                                );
                                necesitaActualizarPrecio = false;
                            } else {
                                await pool.query(
                                    "UPDATE precios_productos SET url_producto = ?, escaneado_en = NOW() WHERE id = ?",
                                    [prod.url_producto, ultimoPrecio.id]
                                );
                                necesitaActualizarPrecio = false;
                            }
                        }
                    }

                    if (necesitaActualizarPrecio && precioExistente.length === 0) {
                        await pool.query(
                            "INSERT INTO precios_productos (producto_id, supermercado_id, precio, url_producto, escaneado_en) VALUES (?, ?, ?, ?, NOW())",
                            [productoId, supermercadoId, prod.precio, prod.url_producto]
                        );
                    }

                    // HISTORIAL
                    const [historialHoy] = await pool.query(
                        "SELECT id FROM historial_precios WHERE producto_id = ? AND supermercado_id = ? AND DATE(fecha) = CURDATE() LIMIT 1",
                        [productoId, supermercadoId]
                    );

                    if (historialHoy.length === 0) {
                        await pool.query(
                            "INSERT INTO historial_precios (producto_id, supermercado_id, precio, fecha) VALUES (?, ?, ?, NOW())",
                            [productoId, supermercadoId, prod.precio]
                        );
                    }
                }
                
                console.log(`✅ Página procesada: ${nuevosPagina} productos nuevos agregados | ${existentesPagina} ya existían (se revisó el precio).`);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        console.log('\n======================================================');
        console.log('🚀 ¡PROCESO DE SANTA ISABEL COMPLETADO!');
        console.log(`📊 RESUMEN FINAL:`);
        console.log(`   - Nuevos productos creados: ${totalNuevosGlobal}`);
        console.log(`   - Productos ya existentes (unificados): ${totalExistentesGlobal}`);
        console.log('======================================================\n');
        
        await browser.close();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error durante el scraping:', error);
        process.exit(1);
    }
}

explorarSantaIsabel();