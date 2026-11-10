const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const pool = require('./db');

const urlsTottus = [
    'https://www.tottus.cl/tottus-cl/lista/CATG27055/Despensa',
    'https://www.tottus.cl/tottus-cl/lista/CATG27059/Lacteos-y-Quesos',
    'https://www.tottus.cl/tottus-cl/lista/CATG27075/Carnes-y-Pescados',
    'https://www.tottus.cl/tottus-cl/lista/CATG27087/Bebidas-Aguas-y-Jugos',
    'https://www.tottus.cl/tottus-cl/lista/CATG27095/Limpieza-y-Aseo'
];

function normalizarTextoCruce(texto) {
    if (!texto) return '';
    return texto
        .toString()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/(\d+)\s*(g|gr|grs|gramos)\b/g, '$1g')
        .replace(/(\d+)\s*(kg|kilos|kilo)\b/g, '$1kg')
        .replace(/(\d+)\s*(ml|cc)\b/g, '$1ml')
        .replace(/(\d+)\s*(l|lt|lts|litro|litros)\b/g, '$1l')
        .replace(/[^a-z0-9]/g, '');
}

async function explorarTottus() {
    try {
        console.log('1. Verificando supermercado Tottus en la base de datos...');
        let supermercadoId;
        const [supermercados] = await pool.query("SELECT id FROM supermercados WHERE LOWER(nombre) = 'tottus'");
        
        if (supermercados.length > 0) {
            supermercadoId = supermercados[0].id;
        } else {
            const [nuevoSuper] = await pool.query(
                "INSERT INTO supermercados (nombre, url_logo) VALUES (?, ?)", 
                ['Tottus', 'https://www.google.com/s2/favicons?domain=tottus.cl&sz=128']
            );
            supermercadoId = nuevoSuper.insertId;
        }

        const [sucursalesTottus] = await pool.query(
            "SELECT id FROM sucursales WHERE supermercado_id = ? LIMIT 1",
            [supermercadoId]
        );
        if (sucursalesTottus.length === 0) {
            await pool.query(
                "INSERT INTO sucursales (supermercado_id, nombre_local, direccion, latitud, longitud) VALUES (?, ?, ?, ?, ?)",
                [supermercadoId, 'Tottus Curicó', 'Av. Freire 70, Curicó', -34.9839, -71.2335]
            );
        }

        console.log('2. Cargando catálogo actual de productos para cruce inteligente...');
        const [catalogoActual] = await pool.query("SELECT id, nombre, marca FROM productos");
        const mapaCatalogo = new Map();

        for (const item of catalogoActual) {
            const claveSoloNombre = normalizarTextoCruce(item.nombre);
            const claveNombreMarca = normalizarTextoCruce(`${item.nombre} ${item.marca || ''}`);
            const claveMarcaNombre = normalizarTextoCruce(`${item.marca || ''} ${item.nombre}`);

            if (claveSoloNombre) mapaCatalogo.set(claveSoloNombre, item.id);
            if (claveNombreMarca) mapaCatalogo.set(claveNombreMarca, item.id);
            if (claveMarcaNombre) mapaCatalogo.set(claveMarcaNombre, item.id);
        }
        console.log(`📦 ${catalogoActual.length} productos base listos para cruzar.`);

        console.log('3. Iniciando navegador Stealth Puppeteer para Tottus...');
        const browser = await puppeteer.launch({ 
            headless: false, 
            defaultViewport: { width: 1366, height: 768 },
            args: [
                '--window-size=1366,768',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--lang=es-CL,es'
            ]
        });

        const page = await browser.newPage();

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        );
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'es-CL,es;q=0.9,en;q=0.8',
            'Upgrade-Insecure-Requests': '1'
        });
        try {
            await page.emulateTimezone('America/Santiago');
        } catch (e) {}

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => ['es-CL', 'es'] });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        });

        let productosCapturadosRed = [];
        page.on('response', async (response) => {
            try {
                const url = response.url();
                const contentType = response.headers()['content-type'] || '';
                if (contentType.includes('application/json') && (url.includes('tottus') || url.includes('search') || url.includes('category') || url.includes('pageProps'))) {
                    const data = await response.json();
                    const posiblesListas = [
                        data?.results,
                        data?.data?.results,
                        data?.pageProps?.results,
                        data?.pageProps?.data?.results,
                        data?.props?.pageProps?.results
                    ];
                    for (const lista of posiblesListas) {
                        if (Array.isArray(lista) && lista.length > 0) {
                            lista.forEach(item => {
                                const nombre = (item.displayName || item.name || '').trim();
                                const marca = (item.brand || 'Sin marca').trim();
                                const url_producto = item.url || (item.productId ? `https://www.tottus.cl/tottus-cl/articulo/${item.productId}/${encodeURIComponent(nombre)}` : '');
                                const url_imagen = Array.isArray(item.mediaUrls) && item.mediaUrls.length > 0 ? item.mediaUrls[0] : null;
                                let precio = 0;
                                if (Array.isArray(item.prices)) {
                                    for (const p of item.prices) {
                                        const valStr = Array.isArray(p.price) ? p.price[0] : p.price;
                                        if (valStr) {
                                            const limpio = parseInt(valStr.toString().replace(/\./g, '').replace(/[^0-9]/g, ''), 10);
                                            if (limpio > 0 && (precio === 0 || limpio < precio)) precio = limpio;
                                        }
                                    }
                                }
                                if (nombre && precio > 0) {
                                    productosCapturadosRed.push({ nombre, marca, precio, url_producto, url_imagen });
                                }
                            });
                        }
                    }
                }
            } catch (_) {}
        });

        let totalActualizadosGlobal = 0;
        let totalOmitidosGlobal = 0;

        for (const urlCategoria of urlsTottus) {
            console.log(`\n======================================================`);
            console.log(`🚀 INICIANDO CATEGORÍA TOTTUS: ${urlCategoria}`);
            
            for (let numPagina = 1; numPagina <= 50; numPagina++) {
                productosCapturadosRed = [];
                const separador = urlCategoria.includes('?') ? '&' : '?';
                const urlActual = `${urlCategoria}${separador}page=${numPagina}`;
                console.log(`➡️ PÁGINA ${numPagina}: ${urlActual}`);
                
                try {
                    await page.goto(urlActual, { waitUntil: 'networkidle0', timeout: 60000 });
                } catch (err) {
                    console.log('⚠️ Timeout de red controlado, continuando...');
                }

                // Pausa para que Cloudflare resuelva el desafío anti-bot
                console.log('Esperando resolución de seguridad de Tottus...');
                await new Promise(resolve => setTimeout(resolve, 8000));

                let tituloPagina = await page.title();
                console.log(`📄 Título en Tottus: "${tituloPagina}"`);

                // Si detecta "Un momento...", simulamos interacción humana para forzar la validación
                if (tituloPagina.includes('Un momento') || tituloPagina.includes('Just a moment')) {
                    console.log('🛡️ Escudo Cloudflare detectado, simulando movimiento de mouse...');
                    await page.mouse.move(120, 250);
                    await page.mouse.down();
                    await page.mouse.up();
                    await new Promise(resolve => setTimeout(resolve, 6000));
                    tituloPagina = await page.title();
                    console.log(`📄 Título tras simulación: "${tituloPagina}"`);
                }

                console.log('Bajando por la página para cargar todas las imágenes (Lazy Load)...');
                await page.evaluate(async () => {
                    await new Promise((resolve) => {
                        let totalHeight = 0;
                        let distance = 300;
                        let steps = 0;
                        let timer = setInterval(() => {
                            let scrollHeight = document.body ? document.body.scrollHeight : 0;
                            window.scrollBy(0, distance);
                            totalHeight += distance;
                            steps++;
                            if (totalHeight >= scrollHeight - window.innerHeight || steps > 35) {
                                clearInterval(timer);
                                resolve();
                            }
                        }, 120);
                    });
                });
                await new Promise(resolve => setTimeout(resolve, 2500));

                const productosDOM = await page.evaluate(() => {
                    const resultados = [];
                    const urlsVistas = new Set();

                    function buscarArraysProductos(obj) {
                        if (!obj || typeof obj !== 'object') return;
                        if (Array.isArray(obj)) {
                            for (const el of obj) {
                                if (el && typeof el === 'object' && (el.displayName || el.productId) && Array.isArray(el.prices)) {
                                    const nombre = (el.displayName || el.name || '').trim();
                                    const marca = (el.brand || 'Sin marca').trim();
                                    const url_producto = el.url || (el.productId ? `https://www.tottus.cl/tottus-cl/articulo/${el.productId}/${encodeURIComponent(nombre)}` : '');
                                    const url_imagen = Array.isArray(el.mediaUrls) && el.mediaUrls.length > 0 ? el.mediaUrls[0] : null;

                                    let precio = 0;
                                    for (const p of el.prices) {
                                        const valStr = Array.isArray(p.price) ? p.price[0] : p.price;
                                        if (valStr) {
                                            const limpio = parseInt(valStr.toString().replace(/\./g, '').replace(/[^0-9]/g, ''), 10);
                                            if (limpio > 0 && (precio === 0 || limpio < precio)) precio = limpio;
                                        }
                                    }
                                    if (nombre && precio > 0 && !urlsVistas.has(nombre.toLowerCase())) {
                                        urlsVistas.add(nombre.toLowerCase());
                                        resultados.push({ nombre, marca, precio, url_producto, url_imagen });
                                    }
                                } else {
                                    buscarArraysProductos(el);
                                }
                            }
                            return;
                        }
                        for (const k of Object.keys(obj)) {
                            buscarArraysProductos(obj[k]);
                        }
                    }

                    try {
                        const nextScript = document.getElementById('__NEXT_DATA__');
                        if (nextScript) {
                            const nextJson = JSON.parse(nextScript.textContent);
                            buscarArraysProductos(nextJson);
                        }
                    } catch (e) {}

                    const selectoresTarjetas = [
                        '[data-pod="catalyst-pod"]',
                        'div.pod',
                        'a.pod-link',
                        'li[class*="product"]',
                        'div[class*="search-results"] div[class*="pod"]'
                    ];

                    let tarjetas = [];
                    for (const sel of selectoresTarjetas) {
                        const encontrados = document.querySelectorAll(sel);
                        if (encontrados.length > 0) {
                            tarjetas = Array.from(encontrados);
                            break;
                        }
                    }

                    if (tarjetas.length === 0) {
                        const links = document.querySelectorAll('a[href*="/tottus-cl/articulo/"], a[href*="/tottus-cl/product/"]');
                        links.forEach(l => {
                            const contenedor = l.closest('[data-pod], div.pod, li') || l;
                            if (!tarjetas.includes(contenedor)) tarjetas.push(contenedor);
                        });
                    }

                    tarjetas.forEach(caja => {
                        const nombreEl = caja.querySelector('b.pod-subTitle, [class*="pod-subTitle"], [id*="testId-pod-displaySubTitle"], h2, h3');
                        const marcaEl = caja.querySelector('b.pod-title, [class*="pod-title"], [id*="testId-pod-displayTitle"]');
                        const enlaceEl = caja.tagName === 'A' ? caja : caja.querySelector('a[href]');
                        const imgEl = caja.querySelector('img');

                        if (!nombreEl || !enlaceEl) return;

                        const nombre = nombreEl.innerText.trim();
                        if (!nombre || urlsVistas.has(nombre.toLowerCase())) return;

                        const marca = marcaEl ? marcaEl.innerText.trim() : 'Sin marca';
                        const href = enlaceEl.getAttribute('href') || '';
                        const url_producto = href.startsWith('http') ? href : `https://www.tottus.cl${href}`;
                        const url_imagen = imgEl ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src')) : null;

                        let precio = 0;
                        const nodosPrecio = caja.querySelectorAll('li[data-internet-price], li[data-cmr-price], li[data-event-price], span.copy10, [class*="prices"] span, [class*="price"]');
                        
                        if (nodosPrecio.length > 0) {
                            for (const nodo of nodosPrecio) {
                                const attrPrecio = nodo.getAttribute('data-internet-price') || nodo.getAttribute('data-cmr-price') || nodo.getAttribute('data-event-price');
                                if (attrPrecio) {
                                    const num = parseInt(attrPrecio.replace(/\./g, '').replace(/[^0-9]/g, ''), 10);
                                    if (num > 0 && (precio === 0 || num < precio)) precio = num;
                                } else {
                                    const m = (nodo.innerText || '').match(/\$\s?([\d\.]+)/);
                                    if (m) {
                                        const num = parseInt(m[1].replace(/\./g, ''), 10);
                                        if (num > 0 && (precio === 0 || num < precio)) precio = num;
                                    }
                                }
                            }
                        }

                        if (precio === 0) {
                            const matchTexto = (caja.innerText || '').match(/\$\s?([\d\.]+)/);
                            if (matchTexto) {
                                precio = parseInt(matchTexto[1].replace(/\./g, ''), 10) || 0;
                            }
                        }

                        if (nombre && precio > 0) {
                            urlsVistas.add(nombre.toLowerCase());
                            resultados.push({ nombre, marca, precio, url_producto, url_imagen });
                        }
                    });

                    return resultados;
                });

                const mapaUnicosPagina = new Map();
                [...productosDOM, ...productosCapturadosRed].forEach(p => {
                    const key = p.nombre.toLowerCase();
                    if (!mapaUnicosPagina.has(key)) {
                        mapaUnicosPagina.set(key, p);
                    }
                });
                const productosExtraidos = Array.from(mapaUnicosPagina.values());

                console.log(`¡Se extrajeron ${productosExtraidos.length} productos de esta página!`);

                if (productosExtraidos.length === 0) {
                    console.log('⚠️ No se detectaron productos en esta página. Pasando a la siguiente categoría...');
                    break;
                }

                console.log('Cruzando con la base de datos (Solo productos existentes)...');
                let actualizadosPagina = 0;
                let omitidosPagina = 0;

                for (const prod of productosExtraidos) {
                    let productoId = null;

                    const [existenteSQL] = await pool.query(
                        `SELECT id FROM productos 
                         WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))
                            OR (LOWER(TRIM(nombre)) = LOWER(TRIM(?)) AND LOWER(TRIM(marca)) = LOWER(TRIM(?)))
                         LIMIT 1`,
                        [prod.nombre, prod.nombre, prod.marca]
                    );

                    if (existenteSQL.length > 0) {
                        productoId = existenteSQL[0].id;
                    } else {
                        const clave1 = normalizarTextoCruce(prod.nombre);
                        const clave2 = normalizarTextoCruce(`${prod.nombre} ${prod.marca}`);
                        const clave3 = normalizarTextoCruce(`${prod.marca} ${prod.nombre}`);

                        productoId = mapaCatalogo.get(clave1) || mapaCatalogo.get(clave2) || mapaCatalogo.get(clave3) || null;
                    }

                    if (!productoId) {
                        omitidosPagina++;
                        totalOmitidosGlobal++;
                        continue; 
                    }

                    await pool.query(
                        "UPDATE productos SET url_imagen = COALESCE(url_imagen, ?) WHERE id = ?",
                        [prod.url_imagen, productoId]
                    );
                    actualizadosPagina++;
                    totalActualizadosGlobal++;

                    const [precioExistente] = await pool.query(
                        "SELECT id, precio, DATE(escaneado_en) as fecha_scan FROM precios_productos WHERE producto_id = ? AND supermercado_id = ? ORDER BY escaneado_en DESC LIMIT 1",
                        [productoId, supermercadoId]
                    );

                    let necesitaInsertarPrecio = true;

                    if (precioExistente.length > 0) {
                        const ultimoPrecio = precioExistente[0];
                        const fechaScanStr = ultimoPrecio.fecha_scan instanceof Date
                            ? ultimoPrecio.fecha_scan.toISOString().split('T')[0]
                            : String(ultimoPrecio.fecha_scan).split('T')[0];
                        const hoyStr = new Date().toISOString().split('T')[0];
                        const esMismoDia = fechaScanStr === hoyStr;

                        if (esMismoDia && Number(ultimoPrecio.precio) === Number(prod.precio)) {
                            necesitaInsertarPrecio = false;
                        } else {
                            if (Number(ultimoPrecio.precio) !== Number(prod.precio)) {
                                await pool.query(
                                    "UPDATE precios_productos SET precio_anterior = ?, precio = ?, url_producto = ?, escaneado_en = NOW() WHERE id = ?",
                                    [ultimoPrecio.precio, prod.precio, prod.url_producto, ultimoPrecio.id]
                                );
                            } else {
                                await pool.query(
                                    "UPDATE precios_productos SET url_producto = ?, escaneado_en = NOW() WHERE id = ?",
                                    [prod.url_producto, ultimoPrecio.id]
                                );
                            }
                            necesitaInsertarPrecio = false;
                        }
                    }

                    if (necesitaInsertarPrecio && precioExistente.length === 0) {
                        await pool.query(
                            "INSERT INTO precios_productos (producto_id, supermercado_id, precio, url_producto, escaneado_en) VALUES (?, ?, ?, ?, NOW())",
                            [productoId, supermercadoId, prod.precio, prod.url_producto]
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

                console.log(`✅ Página ${numPagina} lista: 🔗 ${actualizadosPagina} precios actualizados | 🚫 ${omitidosPagina} ignorados.`);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        console.log('\n======================================================');
        console.log('🚀 ¡PROCESO DE TOTTUS COMPLETADO!');
        console.log(`📊 RESUMEN FINAL:`);
        console.log(`   - 🔗 Precios de Tottus añadidos/actualizados a productos existentes: ${totalActualizadosGlobal}`);
        console.log(`   - 🚫 Productos de Tottus omitidos (no estaban em tu BD): ${totalOmitidosGlobal}`);
        console.log('======================================================\n');

        await browser.close();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error durante el scraping de Tottus:', error);
        process.exit(1);
    }
}

explorarTottus();