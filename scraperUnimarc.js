const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const pool = require('./db');

const urlsUnimarc = [
    'https://www.unimarc.cl/category/frutas-y-verduras',
    'https://www.unimarc.cl/category/carnes',
    'https://www.unimarc.cl/category/lacteos-huevos-y-refrigerados',
    'https://www.unimarc.cl/category/quesos-y-fiambres',
    'https://www.unimarc.cl/category/panaderia-y-pasteleria',
    'https://www.unimarc.cl/category/congelados',
    'https://www.unimarc.cl/category/despensa',
    'https://www.unimarc.cl/category/desayuno-y-dulces',
    'https://www.unimarc.cl/category/bebidas-y-licores',
    'https://www.unimarc.cl/category/limpieza',
    'https://www.unimarc.cl/category/mascotas',
    'https://www.unimarc.cl/category/bebes-y-ninos'
];

function normalizarEAN13(codigo) {
    if (!codigo) return null;
    let limpio = codigo.toString().trim().replace(/^0+/, '');
    if (limpio.length === 13) return limpio;
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

function extraerPrecio(prod) {
    if (!prod || typeof prod !== 'object') return 0;

    const parsear = (val) => {
        if (val === null || val === undefined || val === '') return 0;
        if (typeof val === 'number') return val;
        let str = val.toString().replace(/[^0-9]/g, '');
        let num = parseInt(str, 10);
        return isNaN(num) ? 0 : num;
    };

    let p = parsear(prod.price) || parsear(prod.bestPrice) || parsear(prod.spotPrice) || parsear(prod.Price);
    if (p > 0) return p;

    if (prod.pricing) {
        p = parsear(prod.pricing.bestPrice) || parsear(prod.pricing.price);
        if (p > 0) return p;
    }

    if (prod.priceRange) {
        p = parsear(prod.priceRange.sellingPrice?.lowPrice) || parsear(prod.priceRange.listPrice?.lowPrice);
        if (p > 0) return p;
    }

    if (Array.isArray(prod.sellers) && prod.sellers.length > 0) {
        const offer = prod.sellers[0]?.commertialOffer;
        if (offer) {
            p = parsear(offer.Price) || parsear(offer.spotPrice) || parsear(offer.ListPrice);
            if (p > 0) return p;
        }
        p = parsear(prod.sellers[0]?.price);
        if (p > 0) return p;
    }

    if (Array.isArray(prod.items) && prod.items.length > 0) {
        for (let item of prod.items) {
            p = extraerPrecio(item);
            if (p > 0) return p;
        }
    }

    return 0;
}

function extraerProductosDeJson(obj, acumulador) {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
        obj.forEach(item => extraerProductosDeJson(item, acumulador));
    } else {
        if (obj.availableProducts && Array.isArray(obj.availableProducts)) {
            obj.availableProducts.forEach(prod => {
                const nombre = prod.nameComplete || prod.name;
                const marca = prod.brand || 'Sin marca';
                const ean = prod.ean || prod.sku || prod.itemId || (prod.items && prod.items[0]?.ean) || null;
                const slug = prod.detailUrl || prod.slug || '';
                const url_producto = slug.startsWith('http') 
                    ? slug 
                    : (slug ? `https://www.unimarc.cl${slug.startsWith('/') ? '' : '/'}${slug}` : '');

                const url_imagen = Array.isArray(prod.images) && prod.images.length > 0 
                    ? (typeof prod.images[0] === 'string' ? prod.images[0] : prod.images[0]?.imageUrl || null)
                    : null;

                const precio = extraerPrecio(prod);

                if (nombre && precio > 0) {
                    if (!acumulador.some(p => p.nombre === nombre)) {
                        acumulador.push({
                            nombre: nombre.trim(),
                            marca: marca.trim(),
                            precio: precio,
                            codigo_barras: ean ? ean.toString() : null,
                            url_producto,
                            url_imagen
                        });
                    }
                }
            });
        }

        for (let key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                extraerProductosDeJson(obj[key], acumulador);
            }
        }
    }
}

async function explorarUnimarc() {
    try {
        console.log('1. Verificando supermercado Unimarc en la base de datos...');
        let supermercadoId;
        const [supermercados] = await pool.query("SELECT id FROM supermercados WHERE nombre = 'Unimarc'");

        if (supermercados.length > 0) {
            supermercadoId = supermercados[0].id;
        } else {
            const [nuevoSuper] = await pool.query("INSERT INTO supermercados (nombre, direccion) VALUES (?, ?)", ['Unimarc', 'Curicó']);
            supermercadoId = nuevoSuper.insertId;
        }

        console.log('2. Iniciando navegador Stealth Puppeteer para Unimarc...');
        const browser = await puppeteer.launch({ 
            headless: process.env.CI ? 'new' : false, 
            defaultViewport: null,
            args: [
                '--start-maximized',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });
        const page = await browser.newPage();

        // Intercepta peticiones Fetch y XHR a nivel de navegador
        await page.evaluateOnNewDocument(() => {
            window.__capturedJsons = window.__capturedJsons || [];

            const originalFetch = window.fetch;
            window.fetch = async function(...args) {
                const response = await originalFetch.apply(this, args);
                try {
                    const clone = response.clone();
                    const contentType = clone.headers.get('content-type') || '';
                    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                    if (contentType.includes('json') || url.includes('.json')) {
                        const data = await clone.json();
                        window.__capturedJsons.push(data);
                    }
                } catch (e) {}
                return response;
            };

            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function(...args) {
                this.addEventListener('load', function() {
                    try {
                        const contentType = this.getResponseHeader('content-type') || '';
                        if (contentType.includes('json') || this.responseURL.includes('.json')) {
                            const data = JSON.parse(this.responseText);
                            window.__capturedJsons.push(data);
                        }
                    } catch (e) {}
                });
                return originalSend.apply(this, args);
            };
        });

        let totalNuevosGlobal = 0;
        let totalExistentesGlobal = 0;

        for (const urlCategoria of urlsUnimarc) {
            console.log(`\n======================================================`);
            console.log(`🚀 INICIANDO CATEGORÍA UNIMARC: ${urlCategoria}`);

            try {
                let productosCapturados = [];
                let paginaActual = 1;
                let hayMasPaginas = true;

                while (hayMasPaginas && paginaActual <= 50) {
                    const urlPagina = paginaActual === 1 ? urlCategoria : `${urlCategoria}?page=${paginaActual}`;
                    console.log(`\n📄 Procesando Página ${paginaActual}: ${urlPagina}`);

                    await page.goto(urlPagina, { waitUntil: 'networkidle2', timeout: 60000 });
                    await new Promise(resolve => setTimeout(resolve, 4000));

                    // Scroll para asegurar que la página cargue todo su contenido y active eventos de red
                    await page.evaluate(async () => {
                        await new Promise((resolve) => {
                            let totalHeight = 0;
                            let distance = 300;
                            let timer = setInterval(() => {
                                let scrollHeight = document.body.scrollHeight;
                                window.scrollBy(0, distance);
                                totalHeight += distance;
                                if(totalHeight >= scrollHeight - window.innerHeight){ clearInterval(timer); resolve(); }
                            }, 100);
                        });
                    });
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    // 1. Extraer estado inicial (__NEXT_DATA__) si existe en el DOM
                    const nextData = await page.evaluate(() => {
                        try {
                            return window.__NEXT_DATA__ || JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
                        } catch (e) { return null; }
                    });

                    let cantidadAntes = productosCapturados.length;

                    if (nextData) {
                        extraerProductosDeJson(nextData, productosCapturados);
                    }

                    // 2. Extraer JSONs capturados por la interceptación de red
                    const jsons = await page.evaluate(() => window.__capturedJsons || []);
                    jsons.forEach(j => extraerProductosDeJson(j, productosCapturados));
                    await page.evaluate(() => { window.__capturedJsons = []; });

                    let cantidadDespues = productosCapturados.length;
                    console.log(`📊 Total acumulado de productos en esta categoría: ${cantidadDespues}`);

                    // Si esta página no aportó ningún producto nuevo respecto a la anterior, asumimos que llegamos al final
                    if (cantidadDespues === cantidadAntes) {
                        console.log(`🏁 No se encontraron más productos nuevos. Fin de la categoría.`);
                        hayMasPaginas = false;
                    } else {
                        paginaActual++;
                    }
                }

                console.log(`\n📦 TOTAL CAPTURADO en ${urlCategoria}: ${productosCapturados.length} productos.`);

                // Guardado masivo en la Base de Datos MySQL
                for (const prod of productosCapturados) {
                    let productoId;
                    const ean = normalizarEAN13(prod.codigo_barras);

                    const [existente] = await pool.query(
                        `SELECT id FROM productos 
                         WHERE (codigo_barras = ? AND codigo_barras IS NOT NULL) 
                            OR (LOWER(nombre) = LOWER(?) AND LOWER(marca) = LOWER(?)) 
                         LIMIT 1`, 
                        [ean, prod.nombre, prod.marca]
                    );

                    if (existente.length > 0) {
                        productoId = existente[0].id;
                        await pool.query(
                            "UPDATE productos SET url_imagen = COALESCE(url_imagen, ?), codigo_barras = COALESCE(codigo_barras, ?) WHERE id = ?",
                            [prod.url_imagen, ean, productoId]
                        );
                        totalExistentesGlobal++;
                    } else {
                        const [nuevoProd] = await pool.query(
                            "INSERT INTO productos (nombre, marca, url_imagen, codigo_barras) VALUES (?, ?, ?, ?)", 
                            [prod.nombre, prod.marca, prod.url_imagen, ean]
                        );
                        productoId = nuevoProd.insertId;
                        totalNuevosGlobal++;
                    }

                    const [precioExistente] = await pool.query(
                        "SELECT id, precio FROM precios_productos WHERE producto_id = ? AND supermercado_id = ? ORDER BY escaneado_en DESC LIMIT 1",
                        [productoId, supermercadoId]
                    );

                    if (precioExistente.length === 0) {
                        await pool.query(
                            "INSERT INTO precios_productos (producto_id, supermercado_id, precio, url_producto, escaneado_en) VALUES (?, ?, ?, ?, NOW())",
                            [productoId, supermercadoId, prod.precio, prod.url_producto]
                        );
                    } else {
                        await pool.query(
                            "UPDATE precios_productos SET precio = ?, url_producto = ?, escaneado_en = NOW() WHERE id = ?",
                            [prod.precio, prod.url_producto, precioExistente[0].id]
                        );
                    }

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

                console.log(`✅ Categoría procesada con éxito.`);

            } catch (catError) {
                console.error(`⚠️ Error procesando la categoría ${urlCategoria}:`, catError.message);
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log('\n======================================================');
        console.log('🚀 ¡PROCESO DE UNIMARC COMPLETADO!');
        console.log(`📊 RESUMEN FINAL: Nuevos: ${totalNuevosGlobal} | Existentes: ${totalExistentesGlobal}`);
        console.log('======================================================\n');

        await browser.close();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error general en scraperUnimarc:', error);
        process.exit(1);
    }
}

explorarUnimarc();