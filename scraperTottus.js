const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const pool = require('./db');

// Categorías de Tottus a escanear
const urlsTottus = [
    'https://www.tottus.cl/tottus-cl/lista/CATG27055/Despensa',
    'https://www.tottus.cl/tottus-cl/lista/CATG27069/Carnes',
    'https://www.tottus.cl/tottus-cl/lista/CATG27070/Frutas-y-Verduras',
    'https://www.tottus.cl/tottus-cl/lista/CATG27139/Lacteos-y-Quesos',
    'https://www.tottus.cl/tottus-cl/lista/CATG27109/Fiambres-y-Huevos',
    'https://www.tottus.cl/tottus-cl/lista/CATG29182/Bebestibles',
    'https://www.tottus.cl/tottus-cl/lista/CATG27075/Panaderia-y-Pasteleria',
    'https://www.tottus.cl/tottus-cl/lista/CATG27073/Congelados',
    'https://www.tottus.cl/tottus-cl/lista/CATG27074/Aseo-y-Limpieza',
    'https://www.tottus.cl/tottus-cl/lista/CATG27087/Mundo-Bebe',
    'https://www.tottus.cl/tottus-cl/lista/CATG27084/Cuidado-Personal'
];

// 1. Normalización exacta mejorada (limpia grados, GL, envases y estandariza unidades)
function normalizarTextoCruce(texto) {
    if (!texto) return '';
    return texto
        .toString()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        // Eliminar "gl" o "grados" pegados a los grados de alcohol (ej: "40º gl" -> "40")
        .replace(/(\d+)\s*[°º]?\s*(gl|grados|grado)\b/g, '$1')
        .replace(/[°º]/g, '')
        // Estandarizar unidades (1000 ml -> 1l, 1000 g -> 1kg)
        .replace(/\b1000\s*(ml|cc)\b/g, '1l')
        .replace(/\b1000\s*(g|gr|grs|gramos)\b/g, '1kg')
        .replace(/(\d+[.,]?\d*)\s*(g|gr|grs|gramos)\b/g, '$1g')
        .replace(/(\d+[.,]?\d*)\s*(kg|kilos|kilo)\b/g, '$1kg')
        .replace(/(\d+[.,]?\d*)\s*(ml|cc)\b/g, '$1ml')
        .replace(/(\d+[.,]?\d*)\s*(l|lt|lts|litro|litros)\b/g, '$1l')
        .replace(/(\d+)\s*(un|und|unidades|unidad)\b/g, '$1un')
        .replace(/[^a-z0-9]/g, '');
}

// 2. Extrae la medida principal del producto (ej: "1000ml", "750ml", "500g") para no mezclar tamaños distintos
function extraerMedida(texto) {
    if (!texto) return null;
    const limpio = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(',', '.');
    const match = limpio.match(/\b(\d+(?:\.\d+)?)\s*(ml|cc|l|lt|lts|litro|litros|g|gr|grs|gramos|kg|kilo|kilos|un|und|unidades)\b/);
    if (!match) return null;
    
    let valor = parseFloat(match[1]);
    let unidad = match[2];

    // Convertir todo a una unidad base para comparar con exactitud (ml o g)
    if (['l', 'lt', 'lts', 'litro', 'litros'].includes(unidad)) {
        valor = Math.round(valor * 1000);
        unidad = 'ml';
    } else if (unidad === 'cc') {
        unidad = 'ml';
    } else if (['kg', 'kilo', 'kilos'].includes(unidad)) {
        valor = Math.round(valor * 1000);
        unidad = 'g';
    } else if (['gr', 'grs', 'gramos'].includes(unidad)) {
        unidad = 'g';
    } else if (['und', 'unidades'].includes(unidad)) {
        unidad = 'un';
    }
    return `${valor}${unidad}`;
}

// 3. Convierte el nombre en una lista de palabras clave limpias (sin conectores ni medidas)
function obtenerTokensClave(nombre, marca = '') {
    const stopWords = new Set([
        'de', 'el', 'la', 'los', 'las', 'en', 'con', 'para', 'por', 'sin', 'del', 'al', 'un', 'una',
        'gl', 'grados', 'grado', 'botella', 'envase', 'bolsa', 'caja', 'pack', 'display', 'formato',
        'unidades', 'unidad', 'un', 'und', 'tottus', 'marca'
    ]);

    const textoCompleto = `${nombre} ${marca}`
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/(\d+)\s*[°º]?\s*(gl|grados|grado)\b/g, '$1')
        .replace(/[°º]/g, ' ')
        // Quitamos las medidas de los tokens porque ya las validamos con extraerMedida()
        .replace(/\b\d+(?:[.,]\d+)?\s*(ml|cc|l|lt|lts|litro|litros|g|gr|grs|gramos|kg|kilo|kilos|un|und|unidades)\b/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ');

    return [...new Set(
        textoCompleto
            .split(/\s+/)
            .filter(w => w.length >= 2 && !stopWords.has(w))
    )];
}

// 4. Buscador por similitud inteligente cuando falla el cruce exacto
function buscarProductoPorSimilitud(prodTottus, listaCatalogoProcesado) {
    const tokensTottus = obtenerTokensClave(prodTottus.nombre, prodTottus.marca);
    if (tokensTottus.length === 0) return null;

    const medidaTottus = extraerMedida(prodTottus.nombre);
    const marcaTottus = normalizarTextoCruce(prodTottus.marca);

    let mejorId = null;
    let mejorPuntaje = 0;

    for (const itemBD of listaCatalogoProcesado) {
        // Regla A: Si AMBOS productos tienen medida explícita (ej: 1L vs 750ml) y son distintas, descartar de inmediato
        if (medidaTottus && itemBD.medida && medidaTottus !== itemBD.medida) {
            continue;
        }

        // Regla B: Contar cuántas palabras clave comparten (ej: ['whisky', 'white', 'horse', '40'])
        let coincidencias = 0;
        for (const t of tokensTottus) {
            if (itemBD.tokens.includes(t)) {
                coincidencias++;
            }
        }

        if (coincidencias === 0) continue;

        // Calculamos porcentaje de similitud sobre el producto que tenga menos palabras descriptivas
        const minTokens = Math.min(tokensTottus.length, itemBD.tokens.length);
        const maxTokens = Math.max(tokensTottus.length, itemBD.tokens.length);
        
        let puntaje = coincidencias / minTokens;

        // Penalizar levemente si uno tiene muchas más palabras que el otro
        const ratioLongitud = minTokens / maxTokens;
        puntaje = (puntaje * 0.75) + (ratioLongitud * 0.25);

        // Bonus si la marca coincide o está contenida
        if (marcaTottus && itemBD.marcaNorm && (marcaTottus === itemBD.marcaNorm || itemBD.nombreNorm.includes(marcaTottus))) {
            puntaje += 0.1;
        }

        // Bonus si ambos tienen exactamente la misma medida (ej: ambos dicen 1000ml)
        if (medidaTottus && itemBD.medida && medidaTottus === itemBD.medida) {
            puntaje += 0.1;
        }

        // Exigimos al menos 2 palabras clave en común y un puntaje >= 0.80 para asegurar que sea el mismo producto
        if (coincidencias >= 2 && puntaje >= 0.80 && puntaje > mejorPuntaje) {
            mejorPuntaje = puntaje;
            mejorId = itemBD.id;
        }
    }

    return mejorId;
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
            console.log('📍 Sucursal Tottus Curicó registrada automáticamente.');
        }

        console.log('2. Cargando catálogo actual de productos para cruce inteligente...');
        const [catalogoActual] = await pool.query("SELECT id, nombre, marca FROM productos");
        const mapaCatalogo = new Map();
        const catalogoProcesado = [];

        for (const item of catalogoActual) {
            const claveSoloNombre = normalizarTextoCruce(item.nombre);
            const claveNombreMarca = normalizarTextoCruce(`${item.nombre} ${item.marca || ''}`);
            const claveMarcaNombre = normalizarTextoCruce(`${item.marca || ''} ${item.nombre}`);

            if (claveSoloNombre) mapaCatalogo.set(claveSoloNombre, item.id);
            if (claveNombreMarca) mapaCatalogo.set(claveNombreMarca, item.id);
            if (claveMarcaNombre) mapaCatalogo.set(claveMarcaNombre, item.id);

            catalogoProcesado.push({
                id: item.id,
                nombreOriginal: item.nombre,
                nombreNorm: claveSoloNombre,
                marcaNorm: normalizarTextoCruce(item.marca || ''),
                medida: extraerMedida(item.nombre),
                tokens: obtenerTokensClave(item.nombre, item.marca || '')
            });
        }
        console.log(`📦 ${catalogoActual.length} productos base listos para cruzar.`);

        console.log('3. Iniciando navegador Stealth Puppeteer para Tottus...');
        const browser = await puppeteer.launch({ 
            headless: process.env.CI ? 'new' : false, 
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

        // Captura respuestas JSON internas de la red
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

                console.log('Esperando resolución de seguridad de Tottus...');
                await new Promise(resolve => setTimeout(resolve, 8000));

                let tituloPagina = await page.title();
                console.log(`📄 Título en Tottus: "${tituloPagina}"`);

                if (tituloPagina.includes('Un momento') || tituloPagina.includes('Just a moment')) {
                    console.log('🛡️ Escudo Cloudflare detectado, simulando movimiento de mouse...');
                    await page.mouse.move(120, 250);
                    await page.mouse.down();
                    await page.mouse.up();
                    await new Promise(resolve => setTimeout(resolve, 6000));
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

                // Extracción limpia basada exclusivamente en __NEXT_DATA__
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

                console.log(`¡Se extrajeron ${productosExtraidos.length} productos limpios de esta página!`);

                if (productosExtraidos.length === 0) {
                    console.log('⚠️ No se detectaron más productos en esta categoría. Pasando a la siguiente...');
                    break;
                }

                console.log('Cruzando con la base de datos (Exacto + Similitud Inteligente)...');
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

                        // Si no cruzó exacto, usamos el cruce inteligente por similitud de palabras y medidas
                        if (!productoId) {
                            productoId = buscarProductoPorSimilitud(prod, catalogoProcesado);
                        }
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
        console.log(`   - 🚫 Productos de Tottus omitidos (no estaban en tu BD): ${totalOmitidosGlobal}`);
        console.log('======================================================\n');

        await browser.close();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error durante el scraping de Tottus:', error);
        process.exit(1);
    }
}

explorarTottus();