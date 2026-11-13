const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const pool = require('./db');

// Categorías de Lider a escanear
const urlsLider = [
    'https://super.lider.cl/browse/despensa/aceites-y-aderezos/46589040_87511978',
    'https://super.lider.cl/browse/despensa/arroz-y-legumbres/arroz/46589040_29552324_51088530',
    'https://super.lider.cl/browse/despensa/pastas-y-salsas/46589040_59615139',
    'https://super.lider.cl/browse/despensa/harinas-y-polvos/46589040_63459781',
    'https://super.lider.cl/browse/despensa/conservas/46589040_54223540',
    'https://super.lider.cl/browse/despensa/desayuno-y-dulces/46589040_49480248',
    'https://super.lider.cl/browse/carnes-y-pescados/vacuno/56275647_81471203',
    'https://super.lider.cl/browse/carnes-y-pescados/pollo-y-pavo/56275647_24472066',
    'https://super.lider.cl/browse/carnes-y-pescados/cerdo/56275647_42362675',
    'https://super.lider.cl/browse/frescos-y-lacteos/lacteos/67113038_77454032',
    'https://super.lider.cl/browse/frescos-y-lacteos/quesos-y-fiambres/67113038_48216908',
    'https://super.lider.cl/browse/frescos-y-lacteos/frutas-y-verduras/67113038_64579215',
    'https://super.lider.cl/browse/bebidas-y-licores/bebidas-y-aguas/71649354_21584769',
    'https://super.lider.cl/browse/bebidas-y-licores/cervezas/71649354_83910462',
    'https://super.lider.cl/browse/bebidas-y-licores/vinos-y-espumantes/71649354_59283741',
    'https://super.lider.cl/browse/bebidas-y-licores/destilados-y-licores/71649354_38475610',
    'https://super.lider.cl/browse/limpieza-y-aseo/detergentes-y-cuidado-de-la-ropa/83746591_19283746',
    'https://super.lider.cl/browse/limpieza-y-aseo/papeles-hogar/83746591_56473829',
    'https://super.lider.cl/browse/perfumeria-y-salud/cuidado-personal/91827364_28374651',
    'https://super.lider.cl/browse/mundo-bebe/panales-y-toallas-humedas/37485960_84736251'
];

// 1. Normalización exacta (limpia grados, GL, formatos de pack y estandariza unidades)
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

// 2. Extrae por separado el peso/volumen ("200g", "3000ml"), las unidades del pack ("6") y si tiene grados de alcohol ("40º")
function extraerInfoMedidas(texto) {
    if (!texto) return { pesoVolumen: null, unidadesPack: null, tieneGradosAlcohol: false };
    const limpio = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(',', '.');

    let pesoVolumen = null;
    let unidadesPack = null;
    const tieneGradosAlcohol = /\b(\d+)\s*([°º]|gl|grados|grado)\b/.test(limpio);

    const matchMulti = limpio.match(/\b(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(ml|cc|l|lt|lts|litro|litros|g|gr|grs|gramos|kg|kilo|kilos)\b/);
    if (matchMulti) {
        unidadesPack = parseInt(matchMulti[1], 10);
    }

    if (!unidadesPack) {
        const matchUn = limpio.match(/\b(\d+)\s*(un|und|unidades|unidad)\b/) || limpio.match(/\bpack\s*(?:de\s*)?(\d+)\b/);
        if (matchUn) {
            unidadesPack = parseInt(matchUn[1], 10);
        }
    }

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
        'unidades', 'unidad', 'und', 'lider', 'marca', 'x', 'sabor',
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
function buscarProductoPorSimilitud(prodExtraido, listaCatalogoProcesado) {
    const tokensProd = obtenerTokensClave(prodExtraido.nombre, prodExtraido.marca);
    if (tokensProd.length === 0) return null;

    const infoProd = extraerInfoMedidas(prodExtraido.nombre);
    const marcaProd = normalizarTextoCruce(prodExtraido.marca);

    let mejorId = null;
    let mejorPuntaje = 0;

    for (const itemBD of listaCatalogoProcesado) {
        const pesoP = infoProd.pesoVolumen;
        const pesoBD = itemBD.infoMedidas.pesoVolumen;

        if (pesoP && pesoBD && pesoP !== pesoBD) {
            continue;
        }

        if ((pesoP && !pesoBD) || (!pesoP && pesoBD)) {
            const ambosSonLicorConGrados = infoProd.tieneGradosAlcohol && itemBD.infoMedidas.tieneGradosAlcohol;
            if (!ambosSonLicorConGrados) {
                continue;
            }
        }

        const packP = infoProd.unidadesPack || 1;
        const packBD = itemBD.infoMedidas.unidadesPack || 1;
        if (packP !== packBD && (packP > 1 || packBD > 1)) {
            continue;
        }

        let coincidencias = 0;
        for (const t of tokensProd) {
            if (itemBD.tokens.includes(t)) {
                coincidencias++;
            }
        }

        if (coincidencias === 0) continue;

        const minTokens = Math.min(tokensProd.length, itemBD.tokens.length);
        const maxTokens = Math.max(tokensProd.length, itemBD.tokens.length);
        
        let puntaje = coincidencias / minTokens;
        const ratioLongitud = minTokens / maxTokens;
        puntaje = (puntaje * 0.75) + (ratioLongitud * 0.25);

        const marcaCoincide = marcaProd && itemBD.marcaNorm && (
            marcaProd === itemBD.marcaNorm ||
            itemBD.nombreNorm.includes(marcaProd) ||
            marcaProd.includes(itemBD.marcaNorm)
        );
        if (marcaCoincide) {
            puntaje += 0.12;
        }

        if (pesoP && pesoBD && pesoP === pesoBD) {
            puntaje += 0.12;
        }

        if (packP > 1 && packP === packBD) {
            puntaje += 0.10;
        }

        if (coincidencias >= 2 && puntaje >= 0.80 && puntaje > mejorPuntaje) {
            mejorPuntaje = puntaje;
            mejorId = itemBD.id;
        }
    }

    return mejorId;
}

// 5. Espera cuando la página muestra pantalla de validación
async function verificarEstadoPagina(page) {
    let titulo = await page.title();
    if (!titulo.toLowerCase().includes('robot') && !titulo.toLowerCase().includes('human') && !titulo.toLowerCase().includes('moment')) {
        return true;
    }

    console.log(`⏳ Pantalla de espera detectada ("${titulo}"). Aguardando resolución...`);
    for (let i = 1; i <= 3; i++) {
        await new Promise(r => setTimeout(r, 6000));
        titulo = await page.title();
        if (!titulo.toLowerCase().includes('robot') && !titulo.toLowerCase().includes('human') && !titulo.toLowerCase().includes('moment')) {
            console.log('✅ Página cargada correctamente.');
            return true;
        }
    }
    return false;
}

async function explorarLider() {
    try {
        console.log('1. Verificando supermercado Lider en la base de datos...');
        let supermercadoId;
        const [supermercados] = await pool.query("SELECT id FROM supermercados WHERE LOWER(nombre) LIKE '%lider%' LIMIT 1");
        
        if (supermercados.length > 0) {
            supermercadoId = supermercados[0].id;
        } else {
            const [nuevoSuper] = await pool.query(
                "INSERT INTO supermercados (nombre, url_logo) VALUES (?, ?)", 
                ['Lider', 'https://www.google.com/s2/favicons?domain=lider.cl&sz=128']
            );
            supermercadoId = nuevoSuper.insertId;
        }

        const [sucursalesLider] = await pool.query(
            "SELECT id FROM sucursales WHERE supermercado_id = ? LIMIT 1",
            [supermercadoId]
        );
        if (sucursalesLider.length === 0) {
            await pool.query(
                "INSERT INTO sucursales (supermercado_id, nombre_local, direccion, latitud, longitud) VALUES (?, ?, ?, ?, ?)",
                [supermercadoId, 'Lider Curicó', 'Av. O\'Higgins 201, Curicó', -34.9854, -71.2415]
            );
            console.log('📍 Sucursal Lider Curicó registrada automáticamente.');
        }

        console.log('2. Cargando catálogo actual de productos para cruce...');
        const [catalogoActual] = await pool.query("SELECT id, nombre, marca, codigo_barras FROM productos");
        const mapaCatalogo = new Map();
        const mapaCodigos = new Map();
        const catalogoProcesado = [];

        for (const item of catalogoActual) {
            const claveSoloNombre = normalizarTextoCruce(item.nombre);
            const claveNombreMarca = normalizarTextoCruce(`${item.nombre} ${item.marca || ''}`);
            const claveMarcaNombre = normalizarTextoCruce(`${item.marca || ''} ${item.nombre}`);

            if (claveSoloNombre) mapaCatalogo.set(claveSoloNombre, item.id);
            if (claveNombreMarca) mapaCatalogo.set(claveNombreMarca, item.id);
            if (claveMarcaNombre) mapaCatalogo.set(claveMarcaNombre, item.id);

            if (item.codigo_barras) {
                const codLimpio = item.codigo_barras.toString().trim().replace(/^0+/, '');
                if (codLimpio) mapaCodigos.set(codLimpio, item.id);
            }

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

        console.log('3. Iniciando navegador Puppeteer (Modo Ventana Real con Xvfb)...');
        // Importante: headless: false para que utilice el monitor virtual Xvfb configurado en GitHub Actions
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

        // Interceptar respuestas JSON de la API / Next.js de Lider
        let productosCapturadosRed = [];
        page.on('response', async (response) => {
            try {
                const url = response.url();
                const contentType = response.headers()['content-type'] || '';
                if (contentType.includes('application/json') && (url.includes('lider') || url.includes('browse') || url.includes('search') || url.includes('graphql'))) {
                    const data = await response.json();

                    function extraerDesdeObjetoLider(obj) {
                        if (!obj || typeof obj !== 'object') return;
                        if (Array.isArray(obj)) {
                            for (const el of obj) {
                                if (el && typeof el === 'object' && (el.name || el.displayName) && (el.priceInfo || el.prices || el.SalesPrice)) {
                                    const nombre = (el.name || el.displayName || '').trim();
                                    const marca = (el.brand || 'Sin marca').trim();
                                    const codigo_barras = (el.gtin13 || el.ean || el.upc || el.usItemId || '').toString().trim();
                                    const canonical = el.canonicalUrl || el.productPageUrl || '';
                                    const url_producto = canonical
                                        ? (canonical.startsWith('http') ? canonical : `https://super.lider.cl${canonical}`)
                                        : '';
                                    const url_imagen = el.imageInfo?.thumbnailUrl || el.image || (Array.isArray(el.images) ? el.images[0] : null);

                                    let precio = 0;
                                    // Estructura Walmart GraphQL (priceInfo.currentPrice.price)
                                    const candidatosPrecio = [
                                        el.priceInfo?.currentPrice?.price,
                                        el.priceInfo?.currentPrice?.priceString,
                                        el.SalesPrice,
                                        el.price
                                    ];
                                    for (const cand of candidatosPrecio) {
                                        if (cand != null) {
                                            const limpio = parseInt(cand.toString().replace(/\./g, '').replace(/[^0-9]/g, ''), 10);
                                            if (limpio >= 100 && limpio < 5000000) {
                                                precio = limpio;
                                                break;
                                            }
                                        }
                                    }

                                    if (nombre && precio > 0) {
                                        productosCapturadosRed.push({ nombre, marca, precio, url_producto, url_imagen, codigo_barras });
                                    }
                                } else {
                                    extraerDesdeObjetoLider(el);
                                }
                            }
                            return;
                        }
                        for (const k of Object.keys(obj)) {
                            extraerDesdeObjetoLider(obj[k]);
                        }
                    }

                    extraerDesdeObjetoLider(data);
                }
            } catch (_) {}
        });

        // Calentar sesión visitando portada principal
        console.log('🌐 Abriendo portada de Lider para inicializar sesión...');
        try {
            await page.goto('https://super.lider.cl/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await new Promise(r => setTimeout(r, 5000));
            await verificarEstadoPagina(page);
        } catch (_) {}

        let totalActualizadosGlobal = 0;
        let totalOmitidosGlobal = 0;

        for (const urlCategoria of urlsLider) {
            console.log(`\n======================================================`);
            console.log(`🚀 INICIANDO CATEGORÍA LIDER: ${urlCategoria}`);
            
            let paginasVaciasConsecutivas = 0;

            for (let numPagina = 1; numPagina <= 35; numPagina++) {
                productosCapturadosRed = [];
                const separador = urlCategoria.includes('?') ? '&' : '?';
                const urlActual = `${urlCategoria}${separador}page=${numPagina}`;
                console.log(`➡️ PÁGINA ${numPagina}: ${urlActual}`);

                let productosExtraidos = [];

                for (let intento = 1; intento <= 2; intento++) {
                    try {
                        await page.goto(urlActual, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    } catch (err) {
                        console.log(`⚠️ Timeout controlado en intento ${intento}, continuando...`);
                    }

                    console.log('Esperando a que cargue...');
                    await new Promise(resolve => setTimeout(resolve, 6000));

                    const paginaLista = await verificarEstadoPagina(page);
                    const tituloPagina = await page.title();
                    console.log(`📄 Título en Lider: "${tituloPagina}"`);

                    if (!paginaLista) {
                        console.log('⚠️ La página no cargó el catálogo en este intento.');
                        continue;
                    }

                    console.log('Bajando por la página para cargar todas las imágenes...');
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
                                if (totalHeight >= scrollHeight - window.innerHeight || steps > 30) {
                                    clearInterval(timer);
                                    resolve();
                                }
                            }, 130);
                        });
                    });
                    await new Promise(resolve => setTimeout(resolve, 2500));

                    const productosDOM = await page.evaluate(() => {
                        const resultados = [];
                        const nombresVistos = new Set();

                        // A. Extraer desde __NEXT_DATA__ de Lider (estructura Walmart Chile)
                        function buscarEnNextData(obj) {
                            if (!obj || typeof obj !== 'object') return;
                            if (Array.isArray(obj)) {
                                for (const el of obj) {
                                    if (el && typeof el === 'object' && (el.name || el.displayName) && (el.priceInfo || el.SalesPrice)) {
                                        const nombre = (el.name || el.displayName || '').trim();
                                        const marca = (el.brand || 'Sin marca').trim();
                                        const codigo_barras = (el.gtin13 || el.ean || el.upc || el.usItemId || '').toString().trim();
                                        const canonical = el.canonicalUrl || '';
                                        const url_producto = canonical
                                            ? (canonical.startsWith('http') ? canonical : `https://super.lider.cl${canonical}`)
                                            : '';
                                        const url_imagen = el.imageInfo?.thumbnailUrl || null;

                                        let precio = 0;
                                        const rawPrice = el.priceInfo?.currentPrice?.price || el.priceInfo?.currentPrice?.priceString || el.SalesPrice;
                                        if (rawPrice != null) {
                                            const limpio = parseInt(rawPrice.toString().replace(/\./g, '').replace(/[^0-9]/g, ''), 10);
                                            if (limpio >= 100 && limpio < 5000000) precio = limpio;
                                        }

                                        if (nombre && precio > 0 && !nombresVistos.has(nombre.toLowerCase())) {
                                            nombresVistos.add(nombre.toLowerCase());
                                            resultados.push({ nombre, marca, precio, url_producto, url_imagen, codigo_barras });
                                        }
                                    } else {
                                        buscarEnNextData(el);
                                    }
                                }
                                return;
                            }
                            for (const k of Object.keys(obj)) {
                                buscarEnNextData(obj[k]);
                            }
                        }

                        try {
                            const nextScript = document.getElementById('__NEXT_DATA__');
                            if (nextScript) {
                                const nextJson = JSON.parse(nextScript.textContent);
                                buscarEnNextData(nextJson);
                            }
                        } catch (e) {}

                        // B. Respaldo desde tarjetas HTML visibles en pantalla (ignorando precios por litro/kg)
                        const cards = document.querySelectorAll('[data-item-id], [data-automation-id="product-title"], div[class*="product-card"], li[class*="product"]');
                        cards.forEach(card => {
                            const contenedor = card.closest('[data-item-id], div[class*="product"], li') || card;
                            const linkEl = contenedor.querySelector('a[href*="/ip/"], a[href*="/product/"], a');
                            if (!linkEl) return;

                            const tituloEl = contenedor.querySelector('[data-automation-id="product-title"], span[class*="product-description"], h2, h3');
                            const marcaEl = contenedor.querySelector('span[class*="brand"], div[class*="brand"]');
                            const imgEl = contenedor.querySelector('img');

                            const nombre = (tituloEl ? tituloEl.textContent : linkEl.textContent || '').trim();
                            if (!nombre || nombre.length <= 3 || nombresVistos.has(nombre.toLowerCase())) return;

                            const marca = (marcaEl ? marcaEl.textContent : 'Sin marca').trim();
                            const url_producto = linkEl.href || '';
                            const url_imagen = imgEl ? (imgEl.currentSrc || imgEl.src) : null;

                            let precio = 0;
                            const nodosPrecio = contenedor.querySelectorAll('[data-automation-id="product-price"] span, [class*="price"] span, span');
                            nodosPrecio.forEach(el => {
                                if (el.children.length > 1) return;
                                const txt = (el.textContent || '').trim();
                                const txtPadre = (el.parentElement ? el.parentElement.textContent : txt).toLowerCase();

                                // Ignorar precios por litro/kilo/unidad de medida y precios tachados
                                if (
                                    el.tagName === 'S' ||
                                    el.tagName === 'DEL' ||
                                    /por\s*(lt|kg|l|gr|g|ml|cc|100|un)\b/i.test(txtPadre) ||
                                    /\$\s*\d+.*\s*\/\s*(kg|lt|l|g|ml)/i.test(txtPadre)
                                ) {
                                    return;
                                }

                                const m = txt.match(/^\$\s*(\d{1,3}(?:\.\d{3})+|\d{3,6})$/);
                                if (m) {
                                    const limpio = parseInt(m[1].replace(/\./g, ''), 10);
                                    if (limpio >= 100 && limpio < 5000000 && precio === 0) {
                                        precio = limpio;
                                    }
                                }
                            });

                            if (precio > 0) {
                                nombresVistos.add(nombre.toLowerCase());
                                resultados.push({ nombre, marca, precio, url_producto, url_imagen, codigo_barras: '' });
                            }
                        });

                        return resultados;
                    });

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
                }

                console.log(`¡Se extrajeron ${productosExtraidos.length} productos de esta página!`);

                if (productosExtraidos.length === 0) {
                    paginasVaciasConsecutivas++;
                    console.log(`⚠️ No se detectaron productos (${paginasVaciasConsecutivas}/2 vacías consecutivas).`);
                    if (paginasVaciasConsecutivas >= 2) {
                        console.log('🏁 Pasando a la siguiente categoría...');
                        break;
                    }
                    continue;
                }

                paginasVaciasConsecutivas = 0;

                let actualizadosPagina = 0;
                let omitidosPagina = 0;

                for (const prod of productosExtraidos) {
                    let productoId = null;

                    // 1. Cruzar por código de barras si Lider lo provee
                    if (prod.codigo_barras) {
                        const codLimpio = prod.codigo_barras.replace(/^0+/, '');
                        if (mapaCodigos.has(codLimpio)) {
                            productoId = mapaCodigos.get(codLimpio);
                        }
                    }

                    // 2. Cruzar por nombre exacto o normalizado
                    if (!productoId) {
                        const clave1 = normalizarTextoCruce(prod.nombre);
                        const clave2 = normalizarTextoCruce(`${prod.nombre} ${prod.marca}`);
                        const clave3 = normalizarTextoCruce(`${prod.marca} ${prod.nombre}`);

                        productoId = mapaCatalogo.get(clave1) || mapaCatalogo.get(clave2) || mapaCatalogo.get(clave3) || null;
                    }

                    // 3. Cruzar por similitud inteligente con validación de gramaje
                    if (!productoId) {
                        productoId = buscarProductoPorSimilitud(prod, catalogoProcesado);
                    }

                    if (!productoId) {
                        omitidosPagina++;
                        totalOmitidosGlobal++;
                        continue;
                    }

                    // 4. Filtro de coherencia de precios contra precios PUM o formatos distintos
                    const [otrosPrecios] = await pool.query(
                        "SELECT AVG(precio) as promedio FROM precios_productos WHERE producto_id = ? AND supermercado_id != ?",
                        [productoId, supermercadoId]
                    );

                    if (otrosPrecios.length > 0 && otrosPrecios[0].promedio) {
                        const prom = Number(otrosPrecios[0].promedio);
                        if (prod.precio < prom * 0.55 || prod.precio > prom * 1.85) {
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

                    if (precioExistente.length > 0) {
                        const ultimoPrecio = precioExistente[0];
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
                    } else {
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
        console.log('🚀 ¡PROCESO DE LIDER COMPLETADO!');
        console.log(`📊 RESUMEN FINAL:`);
        console.log(`   - 🔗 Precios de Lider añadidos/actualizados: ${totalActualizadosGlobal}`);
        console.log(`   - 🚫 Productos omitidos: ${totalOmitidosGlobal}`);
        console.log('======================================================\n');

        await browser.close();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error durante el scraping de Lider:', error);
        process.exit(1);
    }
}

explorarLider();