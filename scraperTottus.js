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

// Función auxiliar para extraer SOLO el precio real del arreglo "prices" de Tottus (ignorando precio por litro/kilo/PUM)
function extraerPrecioRealJSON(pricesArray) {
    if (!Array.isArray(pricesArray) || pricesArray.length === 0) return 0;

    let precioPreferido = 0; // internetPrice o eventPrice
    let precioNormal = 0;    // normalPrice
    let precioFallback = 0;

    for (const p of pricesArray) {
        if (!p || typeof p !== 'object') continue;

        const tipo = String(p.type || p.label || p.name || '').toLowerCase();
        const textoCompletoObj = JSON.stringify(p).toLowerCase();

        // Ignorar estrictamente cualquier precio por unidad de medida (PUM: por litro, por kg, etc.)
        if (
            tipo.includes('unit') ||
            tipo.includes('pum') ||
            tipo.includes('per') ||
            tipo.includes('medida') ||
            textoCompletoObj.includes('por lt') ||
            textoCompletoObj.includes('por kg') ||
            textoCompletoObj.includes('por l') ||
            textoCompletoObj.includes('por gr') ||
            textoCompletoObj.includes('por 100') ||
            textoCompletoObj.includes('por m') ||
            textoCompletoObj.includes('x lt') ||
            textoCompletoObj.includes('x kg')
        ) {
            continue;
        }

        const valStr = Array.isArray(p.price) ? p.price[0] : (p.price || p.value);
        if (!valStr) continue;

        const limpio = parseInt(valStr.toString().replace(/\./g, '').replace(/[^0-9]/g, ''), 10);
        if (!limpio || limpio < 100 || limpio > 5000000) continue;

        // Priorizar precio internet / oferta todo medio de pago
        if (tipo.includes('internet') || tipo.includes('event') || tipo.includes('offer')) {
            if (precioPreferido === 0 || limpio < precioPreferido) precioPreferido = limpio;
        } else if (tipo.includes('normal') || tipo.includes('list')) {
            if (precioNormal === 0 || limpio < precioNormal) precioNormal = limpio;
        } else if (tipo.includes('cmr')) {
            if (precioFallback === 0 || limpio < precioFallback) precioFallback = limpio;
        } else {
            // Si no trae tipo claro, guardamos el MAYOR entre los candidatos para jamás tomar un PUM oculto
            if (limpio > precioFallback) precioFallback = limpio;
        }
    }

    return precioPreferido || precioNormal || precioFallback || 0;
}

// 1. Normalización exacta mejorada (limpia grados, GL, formatos de pack y estandariza unidades)
function normalizarTextoCruce(texto) {
    if (!texto) return '';
    return texto
        .toString()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\b(\d+)\s*x\s*(\d+)/g, '$1un$2')
        .replace(/(\d+)\s*[°º]?\s*(gl|grados|grado)\b/g, '$1')
        .replace(/[°º]/g, '')
        .replace(/\b1000\s*(ml|cc)\b/g, '1l')
        .replace(/\b1000\s*(g|gr|grs|gramos)\b/g, '1kg')
        .replace(/(\d+[.,]?\d*)\s*(g|gr|grs|gramos)\b/g, '$1g')
        .replace(/(\d+[.,]?\d*)\s*(kg|kilos|kilo)\b/g, '$1kg')
        .replace(/(\d+[.,]?\d*)\s*(ml|cc)\b/g, '$1ml')
        .replace(/(\d+[.,]?\d*)\s*(l|lt|lts|litro|litros)\b/g, '$1l')
        .replace(/(\d+)\s*(un|und|unidades|unidad)\b/g, '$1un')
        .replace(/[^a-z0-9]/g, '');
}

// 2. Extrae por separado el peso/volumen ("120g", "3000ml"), las unidades del pack ("6") y si tiene grados de alcohol ("40º")
function extraerInfoMedidas(texto) {
    if (!texto) return { pesoVolumen: null, unidadesPack: null, tieneGradosAlcohol: false };
    const limpio = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(',', '.');

    let pesoVolumen = null;
    let unidadesPack = null;
    const tieneGradosAlcohol = /\b(\d+)\s*([°º]|gl|grados|grado)\b/.test(limpio);

    // A. Detectar patrón "6 x 200 g" o "6x200ml"
    const matchMulti = limpio.match(/\b(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(ml|cc|l|lt|lts|litro|litros|g|gr|grs|gramos|kg|kilo|kilos)\b/);
    if (matchMulti) {
        unidadesPack = parseInt(matchMulti[1], 10);
    }

    // B. Detectar patrón "6 un", "6 unidades", "pack 6"
    if (!unidadesPack) {
        const matchUn = limpio.match(/\b(\d+)\s*(un|und|unidades|unidad)\b/) || limpio.match(/\bpack\s*(?:de\s*)?(\d+)\b/);
        if (matchUn) {
            unidadesPack = parseInt(matchUn[1], 10);
        }
    }

    // C. Extraer peso o volumen real (g, kg, ml, l) ignorando las unidades ("un")
    const matchPeso = limpio.match(/\b(\d+(?:\.\d+)?)\s*(ml|cc|l|lt|lts|litro|litros|g|gr|grs|gramos|kg|kilo|kilos)\b/);
    if (matchPeso) {
        let valor = parseFloat(matchPeso[1]);
        let unidad = matchPeso[2];

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
        }
        pesoVolumen = `${valor}${unidad}`;
    }

    return { pesoVolumen, unidadesPack, tieneGradosAlcohol };
}

// 3. Convierte el nombre en una lista de palabras clave limpias
function obtenerTokensClave(nombre, marca = '') {
    const stopWords = new Set([
        'de', 'el', 'la', 'los', 'las', 'en', 'con', 'para', 'por', 'sin', 'del', 'al', 'un', 'una',
        'gl', 'grados', 'grado', 'botella', 'envase', 'bolsa', 'caja', 'pack', 'display', 'formato',
        'unidades', 'unidad', 'und', 'tottus', 'marca', 'x', 'sabor',
        'carozzi', 'nestle', 'ccu', 'watts', 'soprole', 'agrosuper', 'unilever', 'tresmontes', 'iansa'
    ]);

    const textoCompleto = `${nombre} ${marca}`
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\b(\d+)\s*x\s*(\d+)/g, '$1 $2')
        .replace(/(\d+)\s*[°º]?\s*(gl|grados|grado)\b/g, '$1')
        .replace(/[°º]/g, ' ')
        .replace(/\b\d+(?:[.,]\d+)?\s*(ml|cc|l|lt|lts|litro|litros|g|gr|grs|gramos|kg|kilo|kilos|un|und|unidades|unidad)\b/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ');

    const tokens = textoCompleto
        .split(/\s+/)
        .map(w => {
            if (w.length > 4 && w.endsWith('es') && !w.endsWith('tes')) return w.slice(0, -2);
            if (w.length > 4 && w.endsWith('s')) return w.slice(0, -1);
            return w;
        })
        .filter(w => w.length >= 2 && !/^\d+$/.test(w) && !stopWords.has(w));

    return [...new Set(tokens)];
}

// 4. Buscador por similitud inteligente con VALIDACIÓN ESTRICTA DE GRAMAJE
function buscarProductoPorSimilitud(prodTottus, listaCatalogoProcesado) {
    const tokensTottus = obtenerTokensClave(prodTottus.nombre, prodTottus.marca);
    if (tokensTottus.length === 0) return null;

    const infoTottus = extraerInfoMedidas(prodTottus.nombre);
    const marcaTottus = normalizarTextoCruce(prodTottus.marca);

    let mejorId = null;
    let mejorPuntaje = 0;

    for (const itemBD of listaCatalogoProcesado) {
        const pesoT = infoTottus.pesoVolumen;
        const pesoBD = itemBD.infoMedidas.pesoVolumen;

        // REGLA ESTRICTA DE GRAMAJE/VOLUMEN:
        if (pesoT && pesoBD && pesoT !== pesoBD) {
            continue;
        }

        if ((pesoT && !pesoBD) || (!pesoT && pesoBD)) {
            const ambosSonLicorConGrados = infoTottus.tieneGradosAlcohol && itemBD.infoMedidas.tieneGradosAlcohol;
            if (!ambosSonLicorConGrados) {
                continue;
            }
        }

        // REGLA B: Multipacks
        const packT = infoTottus.unidadesPack || 1;
        const packBD = itemBD.infoMedidas.unidadesPack || 1;
        if (packT !== packBD && (packT > 1 || packBD > 1)) {
            continue;
        }

        // REGLA C: Palabras clave en común
        let coincidencias = 0;
        for (const t of tokensTottus) {
            if (itemBD.tokens.includes(t)) {
                coincidencias++;
            }
        }

        if (coincidencias === 0) continue;

        const minTokens = Math.min(tokensTottus.length, itemBD.tokens.length);
        const maxTokens = Math.max(tokensTottus.length, itemBD.tokens.length);
        
        let puntaje = coincidencias / minTokens;
        const ratioLongitud = minTokens / maxTokens;
        puntaje = (puntaje * 0.75) + (ratioLongitud * 0.25);

        const marcaCoincide = marcaTottus && itemBD.marcaNorm && (
            marcaTottus === itemBD.marcaNorm ||
            itemBD.nombreNorm.includes(marcaTottus) ||
            marcaTottus.includes(itemBD.marcaNorm)
        );
        if (marcaCoincide) {
            puntaje += 0.12;
        }

        if (pesoT && pesoBD && pesoT === pesoBD) {
            puntaje += 0.12;
        }

        if (packT > 1 && packT === packBD) {
            puntaje += 0.10;
        }

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
                infoMedidas: extraerInfoMedidas(item.nombre),
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

        // Captura respuestas JSON internas de la red ignorando precios por litro/kilo
        let productosCapturadosRed = [];
        page.on('response', async (response) => {
            try {
                const url = response.url();
                const contentType = response.headers()['content-type'] || '';
                if (contentType.includes('application/json') && (url.includes('tottus') || url.includes('search') || url.includes('category') || url.includes('pageProps') || url.includes('api'))) {
                    const data = await response.json();
                    const posiblesListas = [
                        data?.results,
                        data?.data?.results,
                        data?.pageProps?.results,
                        data?.pageProps?.data?.results,
                        data?.props?.pageProps?.results,
                        data?.data?.products,
                        data?.products
                    ];
                    for (const lista of posiblesListas) {
                        if (Array.isArray(lista) && lista.length > 0) {
                            lista.forEach(item => {
                                const baseName = (item.displayName || item.name || '').trim();
                                const formatoExtra = (item.MeasurementUnit || item.unit || item.sellerName || item.topSpecifications?.[0] || '').toString().trim();
                                const nombre = formatoExtra && !baseName.toLowerCase().includes(formatoExtra.toLowerCase())
                                    ? `${baseName} ${formatoExtra}`
                                    : baseName;

                                const marca = (item.brand || 'Sin marca').trim();
                                const url_producto = item.url || (item.productId ? `https://www.tottus.cl/tottus-cl/articulo/${item.productId}/${encodeURIComponent(baseName)}` : '');
                                const url_imagen = Array.isArray(item.mediaUrls) && item.mediaUrls.length > 0 ? item.mediaUrls[0] : null;
                                
                                const precio = extraerPrecioRealJSON(item.prices);

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
            
            let paginasVaciasConsecutivas = 0;

            for (let numPagina = 1; numPagina <= 50; numPagina++) {
                productosCapturadosRed = [];
                const separador = urlCategoria.includes('?') ? '&' : '?';
                const urlActual = `${urlCategoria}${separador}page=${numPagina}`;
                console.log(`➡️ PÁGINA ${numPagina}: ${urlActual}`);

                let productosExtraidos = [];

                for (let intento = 1; intento <= 3; intento++) {
                    try {
                        let navegoPorClick = false;
                        if (numPagina > 1 && intento === 1) {
                            navegoPorClick = await page.evaluate((targetPage) => {
                                const botones = Array.from(document.querySelectorAll('button, a, li'));
                                const btnNumero = botones.find(b => b.textContent && b.textContent.trim() === String(targetPage));
                                if (btnNumero) {
                                    btnNumero.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                    btnNumero.click();
                                    return true;
                                }
                                const btnSiguiente = document.querySelector(
                                    'button[id*="next"], a[id*="next"], button[aria-label*="Siguiente"], button[aria-label*="next"], [class*="pagination"] button:last-child'
                                );
                                if (btnSiguiente && !btnSiguiente.disabled) {
                                    btnSiguiente.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                    btnSiguiente.click();
                                    return true;
                                }
                                return false;
                            }, numPagina);

                            if (navegoPorClick) {
                                console.log(`🖱️ Paginación SPA activada hacia página ${numPagina}...`);
                                await new Promise(resolve => setTimeout(resolve, 6000));
                            }
                        }

                        if (!navegoPorClick) {
                            await page.goto(urlActual, { waitUntil: 'domcontentloaded', timeout: 60000 });
                            await new Promise(resolve => setTimeout(resolve, 7000));
                        }
                    } catch (err) {
                        console.log(`⚠️ Timeout controlado en intento ${intento}, continuando...`);
                    }

                    let tituloPagina = await page.title();
                    console.log(`📄 Título en Tottus (Intento ${intento}): "${tituloPagina}"`);

                    if (tituloPagina.includes('Un momento') || tituloPagina.includes('Just a moment')) {
                        console.log('🛡️ Escudo Cloudflare detectado, simulando movimiento de mouse...');
                        await page.mouse.move(120 + intento * 20, 250);
                        await page.mouse.down();
                        await page.mouse.up();
                        await new Promise(resolve => setTimeout(resolve, 7000));
                        tituloPagina = await page.title();
                    }

                    try {
                        await page.waitForSelector('a[href*="/articulo/"], [data-pod], [class*="pod"]', { timeout: 10000 });
                    } catch (_) {}

                    console.log('Bajando por la página para cargar todas las imágenes (Lazy Load)...');
                    await page.evaluate(async () => {
                        await new Promise((resolve) => {
                            let totalHeight = 0;
                            let distance = 350;
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
                            }, 130);
                        });
                    });
                    await new Promise(resolve => setTimeout(resolve, 2500));

                    const productosDOM = await page.evaluate((numPagActual) => {
                        const resultados = [];
                        const nombresVistos = new Set();

                        function extraerPrecioLimpioJSONInterno(pricesArray) {
                            if (!Array.isArray(pricesArray) || pricesArray.length === 0) return 0;
                            let preferido = 0;
                            let normal = 0;
                            let fallback = 0;

                            for (const p of pricesArray) {
                                if (!p || typeof p !== 'object') continue;
                                const tipo = String(p.type || p.label || p.name || '').toLowerCase();
                                const raw = JSON.stringify(p).toLowerCase();

                                if (
                                    tipo.includes('unit') || tipo.includes('pum') || tipo.includes('per') || tipo.includes('medida') ||
                                    raw.includes('por lt') || raw.includes('por kg') || raw.includes('por l') ||
                                    raw.includes('por gr') || raw.includes('por 100') || raw.includes('x lt') || raw.includes('x kg')
                                ) {
                                    continue;
                                }

                                const valStr = Array.isArray(p.price) ? p.price[0] : (p.price || p.value);
                                if (!valStr) continue;
                                const limpio = parseInt(valStr.toString().replace(/\./g, '').replace(/[^0-9]/g, ''), 10);
                                if (!limpio || limpio < 100 || limpio > 5000000) continue;

                                if (tipo.includes('internet') || tipo.includes('event') || tipo.includes('offer')) {
                                    if (preferido === 0 || limpio < preferido) preferido = limpio;
                                } else if (tipo.includes('normal') || tipo.includes('list')) {
                                    if (normal === 0 || limpio < normal) normal = limpio;
                                } else if (tipo.includes('cmr')) {
                                    if (fallback === 0 || limpio < fallback) fallback = limpio;
                                } else {
                                    if (limpio > fallback) fallback = limpio;
                                }
                            }
                            return preferido || normal || fallback || 0;
                        }

                        // A. Extraer primero desde __NEXT_DATA__ (Más exacto porque distingue tipos de precio)
                        function buscarArraysProductos(obj) {
                            if (!obj || typeof obj !== 'object') return;
                            if (Array.isArray(obj)) {
                                for (const el of obj) {
                                    if (el && typeof el === 'object' && (el.displayName || el.productId) && Array.isArray(el.prices)) {
                                        const baseName = (el.displayName || el.name || '').trim();
                                        const formatoExtra = (el.MeasurementUnit || el.unit || '').toString().trim();
                                        const nombre = formatoExtra && !baseName.toLowerCase().includes(formatoExtra.toLowerCase())
                                            ? `${baseName} ${formatoExtra}`
                                            : baseName;

                                        const marca = (el.brand || 'Sin marca').trim();
                                        const url_producto = el.url || (el.productId ? `https://www.tottus.cl/tottus-cl/articulo/${el.productId}/${encodeURIComponent(baseName)}` : '');
                                        const url_imagen = Array.isArray(el.mediaUrls) && el.mediaUrls.length > 0 ? el.mediaUrls[0] : null;

                                        const precio = extraerPrecioLimpioJSONInterno(el.prices);

                                        if (nombre && precio > 0 && !nombresVistos.has(nombre.toLowerCase())) {
                                            nombresVistos.add(nombre.toLowerCase());
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

                        if (numPagActual === 1) {
                            try {
                                const nextScript = document.getElementById('__NEXT_DATA__');
                                if (nextScript) {
                                    const nextJson = JSON.parse(nextScript.textContent);
                                    buscarArraysProductos(nextJson);
                                }
                            } catch (e) {}
                        }

                        // B. Extraer desde Tarjetas HTML visibles ignorando cualquier bloque de precio por litro/kilo (PUM)
                        const cards = document.querySelectorAll('[data-pod], [class*="pod-"], li[class*="product"], div[class*="search-results"] a[href*="/articulo/"]');
                        cards.forEach(card => {
                            const contenedor = card.closest('[data-pod], li, div[class*="pod"]') || card;
                            const linkEl = contenedor.querySelector('a[href*="/articulo/"]') || (contenedor.tagName === 'A' ? contenedor : null);
                            if (!linkEl) return;

                            const nombreEl = contenedor.querySelector('b[class*="subTitle"], [class*="subTitle"], [class*="display-name"], h2, h3');
                            const marcaEl = contenedor.querySelector('b[class*="title"], [class*="brand"], [class*="title-rebrand"]');
                            const imgEl = contenedor.querySelector('img');

                            let gramajeExtra = '';
                            contenedor.querySelectorAll('span, p, div, b').forEach(el => {
                                const t = (el.textContent || '').trim();
                                if (t.length <= 20 && /^\d+(?:[.,]\d+)?\s*(?:x\s*\d+(?:[.,]\d+)?\s*)?(g|gr|grs|kg|ml|cc|l|lt|lts|un|und)\b/i.test(t)) {
                                    gramajeExtra = t;
                                }
                            });

                            const baseNombre = (nombreEl ? nombreEl.textContent : linkEl.textContent || '').trim();
                            const nombre = gramajeExtra && !baseNombre.toLowerCase().includes(gramajeExtra.toLowerCase())
                                ? `${baseNombre} ${gramajeExtra}`
                                : baseNombre;

                            if (!nombre || nombre.length <= 3 || nombre.toLowerCase().includes('word word') || nombresVistos.has(nombre.toLowerCase())) {
                                return;
                            }

                            const marca = (marcaEl ? marcaEl.textContent : 'Sin marca').trim();
                            const url_producto = linkEl.href || '';
                            const url_imagen = imgEl ? (imgEl.currentSrc || imgEl.src || imgEl.getAttribute('data-src')) : null;

                            let precio = 0;

                            // 1. Intentar primero desde atributos exactos de precio de venta (nunca contienen el PUM)
                            const elAtributoPrecio = contenedor.querySelector('[data-internet-price], [data-event-price], [data-cmr-price], [data-normal-price]');
                            if (elAtributoPrecio) {
                                const attrVal = elAtributoPrecio.getAttribute('data-internet-price') ||
                                                elAtributoPrecio.getAttribute('data-event-price') ||
                                                elAtributoPrecio.getAttribute('data-cmr-price') ||
                                                elAtributoPrecio.getAttribute('data-normal-price') || '';
                                const limpioAttr = parseInt(attrVal.replace(/\./g, '').replace(/[^0-9]/g, ''), 10);
                                if (limpioAttr >= 100 && limpioAttr < 5000000) {
                                    precio = limpioAttr;
                                }
                            }

                            // 2. Si no hay atributo data-*-price, leer los nodos de precio descartando PUM ("por LT", "por KG") y precios tachados
                            if (precio === 0) {
                                const candidatos = [];
                                const elementosPrecio = contenedor.querySelectorAll('[class*="price"], span, div');
                                elementosPrecio.forEach(el => {
                                    // Ignorar si tiene hijos con más spans para no duplicar contenedores enteros
                                    if (el.children.length > 2) return;

                                    const clase = ((el.className || '') + ' ' + (el.parentElement?.className || '')).toLowerCase();
                                    const textoPropio = (el.textContent || '').trim();
                                    const textoPadre = (el.parentElement ? el.parentElement.textContent : textoPropio).toLowerCase();

                                    // Descartar precios tachados (precio antiguo) y descartar precios por litro/kilo (PUM)
                                    if (
                                        clase.includes('pum') ||
                                        clase.includes('unit') ||
                                        clase.includes('crossed') ||
                                        clase.includes('old') ||
                                        el.tagName === 'S' ||
                                        el.tagName === 'DEL' ||
                                        /por\s*(lt|kg|l|gr|g|ml|cc|100|un|m)\b/i.test(textoPadre) ||
                                        /\(\s*\$.*por\s/i.test(textoPadre)
                                    ) {
                                        return;
                                    }

                                    // Buscar formato "$ 15.350" o "$15.350 UN"
                                    const matchPrecio = textoPropio.match(/\$\s*(\d{1,3}(?:\.\d{3})+|\d{3,7})(?!\s*por\b)/i);
                                    if (matchPrecio) {
                                        const limpio = parseInt(matchPrecio[1].replace(/\./g, ''), 10);
                                        if (limpio >= 100 && limpio < 5000000) {
                                            // Si dice explícitamente "UN" al lado (ej: "$15.350 UN"), es 100% el precio unitario real
                                            const esPrecioUnidadExplicito = /\$\s*\d{1,3}(?:\.\d{3})*\s*un\b/i.test(textoPadre);
                                            candidatos.push({ valor: limpio, prioritario: esPrecioUnidadExplicito });
                                        }
                                    }
                                });

                                const prioritarios = candidatos.filter(c => c.prioritario);
                                if (prioritarios.length > 0) {
                                    precio = Math.min(...prioritarios.map(c => c.valor));
                                } else if (candidatos.length > 0) {
                                    // Si quedaron varios candidatos y uno es una fracción pequeña (PUM que se coló), tomamos el mayor
                                    precio = Math.max(...candidatos.map(c => c.valor));
                                }
                            }

                            if (precio > 0) {
                                nombresVistos.add(nombre.toLowerCase());
                                resultados.push({ nombre, marca, precio, url_producto, url_imagen });
                            }
                        });

                        return resultados;
                    }, numPagina);

                    // Priorizamos productosCapturadosRed (que vienen del JSON limpio de la API de Tottus)
                    const mapaUnicosPagina = new Map();
                    [...productosCapturadosRed, ...productosDOM].forEach(p => {
                        const key = p.nombre.toLowerCase();
                        if (!mapaUnicosPagina.has(key)) {
                            mapaUnicosPagina.set(key, p);
                        }
                    });
                    productosExtraidos = Array.from(mapaUnicosPagina.values());

                    if (productosExtraidos.length > 0) {
                        break;
                    }

                    console.log(`🔄 0 productos en intento ${intento}/3 de página ${numPagina}. Esperando 5s antes de reintentar...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }

                console.log(`¡Se extrajeron ${productosExtraidos.length} productos limpios de esta página!`);

                if (productosExtraidos.length === 0) {
                    paginasVaciasConsecutivas++;
                    console.log(`⚠️ Página ${numPagina} sin productos (${paginasVaciasConsecutivas}/2 vacías consecutivas).`);
                    if (paginasVaciasConsecutivas >= 2) {
                        console.log('🏁 Fin confirmado de la categoría. Pasando a la siguiente...');
                        break;
                    }
                    continue;
                }

                paginasVaciasConsecutivas = 0;

                console.log('Cruzando con la base de datos (Exacto + Gramaje Estricto + Filtro Anti-PUM)...');
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

                        if (!productoId) {
                            productoId = buscarProductoPorSimilitud(prod, catalogoProcesado);
                        }
                    }

                    if (!productoId) {
                        omitidosPagina++;
                        totalOmitidosGlobal++;
                        continue; 
                    }

                    // ESCUDO DE COHERENCIA DE PRECIOS REFORZADO (55% a 185%):
                    // Evita guardar cualquier precio por litro (ej: 1/3 = 33% en envases de 3L o 1/2 = 50% en envases de 2L)
                    const [otrosPrecios] = await pool.query(
                        "SELECT AVG(precio) as promedio FROM precios_productos WHERE producto_id = ? AND supermercado_id != ?",
                        [productoId, supermercadoId]
                    );

                    if (otrosPrecios.length > 0 && otrosPrecios[0].promedio) {
                        const prom = Number(otrosPrecios[0].promedio);
                        if (prod.precio < prom * 0.55 || prod.precio > prom * 1.85) {
                            console.log(`🛡️ Cruce descartado por diferencia de formato/PUM: "${prod.nombre}" ($${prod.precio}) vs Promedio BD ($${Math.round(prom)})`);
                            omitidosPagina++;
                            totalOmitidosGlobal++;
                            continue;
                        }
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
                    } else {
                        await pool.query(
                            "UPDATE historial_precios SET precio = ? WHERE id = ?",
                            [prod.precio, historialHoy[0].id]
                        );
                    }
                }

                console.log(`✅ Página ${numPagina} lista: 🔗 ${actualizadosPagina} precios actualizados | 🚫 ${omitidosPagina} ignorados.`);
                await new Promise(resolve => setTimeout(resolve, 3500));
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