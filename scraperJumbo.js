const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const pool = require('./db');

// LINKS DE JUMBO (Puedes agregar más)
const categoriasJumbo = [
    /*'https://www.jumbo.cl/frutas-y-verduras',
    'https://www.jumbo.cl/lacteos-huevos-y-congelados',
    'https://www.jumbo.cl/quesos-y-fiambres',
    'https://www.jumbo.cl/carnes-y-pescados',
    'https://www.jumbo.cl/panaderia-y-pasteleria',
    'https://www.jumbo.cl/licores-bebidas-y-aguas',
    'https://www.jumbo.cl/chocolates-galletas-y-snacks',
    'https://www.jumbo.cl/limpieza',
    'https://www.jumbo.cl/belleza-y-cuidado-personal',*/
    'https://www.jumbo.cl/mascotas',
];

async function explorarJumbo() {
    try {
        console.log('1. Verificando supermercado Jumbo...');
        let supermercadoId;
        const [supermercados] = await pool.query("SELECT id FROM supermercados WHERE nombre = 'Jumbo'");
        
        if (supermercados.length > 0) {
            supermercadoId = supermercados[0].id;
        } else {
            const [nuevoSuper] = await pool.query(
                "INSERT INTO supermercados (nombre, direccion) VALUES (?, ?)", 
                ['Jumbo', 'Curicó']
            );
            supermercadoId = nuevoSuper.insertId;
        }

        const browser = await puppeteer.launch({ 
            headless: false, 
            defaultViewport: null, 
            args: ['--start-maximized'] 
        }); 
        const page = await browser.newPage();

        // Contadores Globales
        let totalNuevosGlobal = 0;
        let totalExistentesGlobal = 0;

        for (const urlCategoria of categoriasJumbo) {
            console.log(`\n======================================================`);
            console.log(`🚀 INICIANDO NUEVA CATEGORÍA JUMBO: ${urlCategoria}`);
            
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
                            if (totalHeight >= scrollHeight - window.innerHeight) { 
                                clearInterval(timer); 
                                resolve(); 
                            }
                        }, 150);
                    });
                });

                const productosExtraidos = await page.evaluate(() => {
                    // Jumbo usa contenedores de VTEX o Constructor.io
                    const cajasDeProducto = document.querySelectorAll('div[data-cnstrc-item-name], div.vtex-product-summary-2-x-container');
                    const resultados = [];
                    
                    cajasDeProducto.forEach(caja => {
                        // Nombre
                        let nombre = caja.getAttribute('data-cnstrc-item-name');
                        if (!nombre) {
                            const nombreEl = caja.querySelector('.vtex-product-summary-2-x-productBrand');
                            if (nombreEl) nombre = nombreEl.innerText.trim();
                        }

                        // Precio Normal
                        let precio = 0;
                        const precioTexto = caja.getAttribute('data-cnstrc-item-price');
                        if (precioTexto) {
                            precio = parseInt(precioTexto) || 0;
                        } else {
                            const precioEl = caja.querySelector('.vtex-product-price-1-x-sellingPriceValue');
                            if (precioEl) precio = parseInt(precioEl.innerText.replace(/[^0-9]/g, '')) || 0;
                        }

                        // LÓGICA DE PRECIO TARJETA / PRIME
                        let precio_tarjeta = null;
                        let tarjeta_nombre = null;

                        const enlaceEl = caja.querySelector('a');
                        const imgEl = caja.querySelector('img');
                        
                        if (nombre && enlaceEl && precio > 0) {
                            let marca = 'Sin marca';
                            try {
                                const jsonStr = enlaceEl.getAttribute('data-gtm-product-click');
                                if (jsonStr) {
                                    const jsonObj = JSON.parse(jsonStr);
                                    if (jsonObj.brand) marca = jsonObj.brand.trim();
                                }
                            } catch (e) {}

                            // Respaldo de marca si no viene en el atributo GTM
                            if (marca === 'Sin marca') {
                                const marcaEl = caja.querySelector('.vtex-product-summary-2-x-productBrandName');
                                if (marcaEl && marcaEl.innerText.trim() !== '') {
                                    marca = marcaEl.innerText.trim();
                                }
                            }
                            
                            const urlParcial = enlaceEl.getAttribute('href');
                            const url_producto = urlParcial.startsWith('http') ? urlParcial : `https://www.jumbo.cl${urlParcial}`;
                            const url_imagen = imgEl ? imgEl.getAttribute('src') : null;
                            
                            resultados.push({ 
                                nombre: nombre.trim(), 
                                marca, 
                                precio, 
                                precio_tarjeta, 
                                tarjeta_nombre,
                                url_producto, 
                                url_imagen, 
                                codigo_barras: null 
                            });
                        }
                    });
                    return resultados;
                });

                console.log(`¡Se extrajeron ${productosExtraidos.length} productos de Jumbo!`);

                if (productosExtraidos.length === 0) {
                    console.log('⚠️ No hay más productos en esta categoría. Saltando a la siguiente...');
                    break; 
                }

                console.log('Guardando en MySQL...');
                let nuevosPagina = 0;
                let existentesPagina = 0;

                for (const prod of productosExtraidos) {
                    // Cruce Híbrido Blindado (Por EAN-13 o por Nombre + Marca exacta)
                    const [existente] = await pool.query(
                        `SELECT id FROM productos 
                         WHERE (codigo_barras = ? AND codigo_barras IS NOT NULL) 
                            OR (LOWER(nombre) = LOWER(?) AND LOWER(marca) = LOWER(?)) 
                         LIMIT 1`, 
                        [prod.codigo_barras, prod.nombre, prod.marca]
                    );
                    
                    let productoId;
                    if (existente.length > 0) {
                        productoId = existente[0].id;
                        // Actualizamos la imagen por si el producto original no tenía
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

                    // GESTIÓN DE PRECIO ACTUAL (Con historial de baja de precio)
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
                            "INSERT INTO precios_productos (producto_id, supermercado_id, precio, precio_tarjeta, tarjeta_nombre, url_producto, escaneado_en) VALUES (?, ?, ?, ?, ?, ?, NOW())",
                            [productoId, supermercadoId, prod.precio, prod.precio_tarjeta, prod.tarjeta_nombre, prod.url_producto]
                        );
                    }

                    // HISTORIAL DE PRECIOS
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
        console.log('🚀 ¡PROCESO DE JUMBO COMPLETADO!');
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

explorarJumbo();