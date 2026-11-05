const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const pool = require('./db');

const urlsLider = [
    'https://super.lider.cl/browse/despensa/aceites-y-aderezos/46589040_87511978',
    'https://super.lider.cl/browse/despensa/arroz-y-legumbres/arroz/46589040_29552324_51088530',
    'https://super.lider.cl/browse/despensa/pastas-y-salsas/46589040_59615139',
    'https://super.lider.cl/browse/despensa/harinas-y-polvos/46589040_37852653',
    'https://super.lider.cl/browse/despensa/arroz-y-legumbres/46589040_29552324',
    'https://super.lider.cl/browse/despensa/salsas/46589040_47278253',
    'https://super.lider.cl/browse/despensa/conservas/46589040_33283038',
    'https://super.lider.cl/browse/despensa/alimentos-instantaneos/46589040_52225904',
    'https://super.lider.cl/browse/despensa/cocina-internacional/46589040_15612080',
    'https://super.lider.cl/browse/frescos-y-lacteos/quesos/45669105_72564080',
    'https://super.lider.cl/browse/carnes-y-pescados/vacuno/21856785_29265944',
    'https://super.lider.cl/browse/carnes-y-pescados/cerdo/21856785_97025819',
    'https://super.lider.cl/browse/carnes-y-pescados/pollo/21856785_36612818',
    'https://super.lider.cl/browse/carnes-y-pescados/pavo/21856785_66365889',
    'https://super.lider.cl/browse/carnes-y-pescados/para-parrilla/21856785_96130591',
    'https://super.lider.cl/browse/carnes-y-pescados/cordero/21856785_32675613',
    'https://super.lider.cl/content/pescados-y-mariscos/29592908',
    'https://super.lider.cl/browse/frutas-y-verduras/frutas/22884697_93034836',
    'https://super.lider.cl/browse/frutas-y-verduras/verduras/22884697_56981658',
    'https://super.lider.cl/browse/frutas-y-verduras/frutos-secos/22884697_77940868',
    'https://super.lider.cl/browse/bebidas-y-snacks/bebidas/13901022_56657077',
    'https://super.lider.cl/browse/bebidas-y-snacks/jugos/13901022_61163586',
    'https://super.lider.cl/browse/bebidas-y-snacks/refrigerados/13901022_41934663',
    'https://super.lider.cl/browse/bebidas-y-snacks/bebidas-funcionales/13901022_63687960',
    'https://super.lider.cl/browse/bebidas-y-snacks/aguas/13901022_67311042',
    'https://super.lider.cl/browse/bebidas-y-snacks/snacks-y-picoteo/13901022_66742898',
    'https://super.lider.cl/browse/frescos-y-lacteos/fiambres-y-embutidos/45669105_22196003',
    'https://super.lider.cl/browse/frescos-y-lacteos/leche/45669105_39354732',
    'https://super.lider.cl/browse/frescos-y-lacteos/bebidas-vegetales/45669105_53011137',
    'https://super.lider.cl/browse/frescos-y-lacteos/yoghurt/45669105_59066660',
    'https://super.lider.cl/browse/frescos-y-lacteos/postres-refrigerados/45669105_15349134',
    'https://super.lider.cl/browse/frescos-y-lacteos/dulces_mermeladas_y_manjar/45669105_21333127',
    'https://super.lider.cl/browse/frescos-y-lacteos/mantequillas-y-margarinas/45669105_15064481',
    'https://super.lider.cl/browse/frescos-y-lacteos/cremas/45669105_27824002',
    'https://super.lider.cl/browse/colaciones/barritas-y-cereales/49858221_71008317',
    'https://super.lider.cl/content/browse/colaciones/fruta-colacion/49858221_82147941',
    'https://super.lider.cl/browse/colaciones/galletas-y-snack-colacion/49858221_84316329',
    'https://super.lider.cl/browse/colaciones/jugos-colacion/49858221_87081691',
    'https://super.lider.cl/browse/colaciones/leches-colacion/49858221_52536805',
    'https://super.lider.cl/browse/colaciones/yoghurt/49858221_10191488',
    'https://super.lider.cl/browse/desayunos-y-dulces/cafe-te-y-hierbas/23483116_11894805',
    'https://super.lider.cl/browse/desayunos-y-dulces/cereales/23483116_70936805',
    'https://super.lider.cl/browse/desayunos-y-dulces/postres-para-preparar/23483116_58016199',
    'https://super.lider.cl/browse/desayunos-y-dulces/galletas-y-colaciones-dulces/23483116_20760251',
    'https://super.lider.cl/browse/desayunos-y-dulces/dulces-mermeladas-y-manjar/23483116_35492092',
    'https://super.lider.cl/browse/desayunos-y-dulces/chocolates-y-candy/23483116_82062599',
    'https://super.lider.cl/browse/limpieza-y-aseo/detergentes/43390617_23557375',
    'https://super.lider.cl/browse/limpieza-y-aseo/papeles/43390617_72719306',
    'https://super.lider.cl/browse/limpieza-y-aseo/ambientadores/43390617_32024397',
    'https://super.lider.cl/browse/limpieza-y-aseo/mas-sustentables/43390617_56006489',
    'https://super.lider.cl/browse/limpieza-y-aseo/bano-y-cocina/43390617_15090475',
    'https://super.lider.cl/browse/limpieza-y-aseo/accesorios-aseo/43390617_61764352',
    'https://super.lider.cl/browse/limpieza-y-aseo/insecticidas-y-control-de-plagas/43390617_74938748'
];

// Función que convierte los códigos de 12 dígitos de Lider al estándar EAN-13 completo y quita ceros iniciales
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

async function explorarLider() {
    try {
        console.log('1. Verificando supermercado Lider en la base de datos...');
        let supermercadoId;
        const [supermercados] = await pool.query("SELECT id FROM supermercados WHERE nombre = 'Lider'");
        
        if (supermercados.length > 0) {
            supermercadoId = supermercados[0].id;
        } else {
            const [nuevoSuper] = await pool.query("INSERT INTO supermercados (nombre, direccion) VALUES (?, ?)", ['Lider', 'Curicó']);
            supermercadoId = nuevoSuper.insertId;
        }

        console.log('2. Iniciando navegador Puppeteer...');
        const browser = await puppeteer.launch({ 
            headless: true, 
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });
        const page = await browser.newPage();

        // Contadores Globales para el reporte final
        let totalNuevosGlobal = 0;
        let totalExistentesGlobal = 0;

        for (const urlCategoria of urlsLider) {
            console.log(`\n======================================================`);
            console.log(`🚀 INICIANDO CATEGORÍA: ${urlCategoria}`);
            
            for (let numPagina = 1; numPagina <= 50; numPagina++) {
                const urlActual = `${urlCategoria}?page=${numPagina}`;
                console.log(`➡️ PÁGINA ${numPagina}: ${urlActual}`);
                
                await page.goto(urlActual, { waitUntil: 'networkidle2', timeout: 60000 }); 
                console.log('Esperando a que cargue...');
                await new Promise(resolve => setTimeout(resolve, 5000));

                console.log('Bajando por la página para cargar todas las imágenes...');
                await page.evaluate(async () => {
                    await new Promise((resolve) => {
                        let totalHeight = 0;
                        let distance = 150; 
                        let timer = setInterval(() => {
                            let scrollHeight = document.body.scrollHeight;
                            window.scrollBy(0, distance);
                            totalHeight += distance;
                            if(totalHeight >= scrollHeight - window.innerHeight){ clearInterval(timer); resolve(); }
                        }, 100);
                    });
                });

                const productosExtraidos = await page.evaluate(() => {
                    const cajasDeProducto = document.querySelectorAll('div[role="group"]');
                    const resultados = [];
                    
                    cajasDeProducto.forEach(caja => {
                        const tituloEl = caja.querySelector('[data-automation-id="product-title"]');
                        const precioEl = caja.querySelector('[data-automation-id="product-price"]');
                        const enlaceEl = caja.querySelector('a[href*="/ip/"]');
                        const imgEl = caja.querySelector('img[data-testid="productTileImage"]');
                        
                        if (tituloEl && precioEl && enlaceEl) {
                            const nombre = tituloEl.innerText.trim();
                            
                            let marca = 'Sin marca';
                            const marcaEl = caja.querySelector('div.mb1.mt2.b.f6.black');
                            if (marcaEl) marca = marcaEl.innerText.trim();
                            
                            const urlParcial = enlaceEl.getAttribute('href');
                            const url_producto = urlParcial.startsWith('http') ? urlParcial : `https://super.lider.cl${urlParcial}`;
                            const url_imagen = imgEl ? imgEl.getAttribute('src') : null;

                            let codigo_barras = null;
                            const matchUrl = url_producto.match(/\/ip\/[^\/]+\/(\d+)$/);
                            if (matchUrl && matchUrl[1]) {
                                if (matchUrl[1].length >= 12) {
                                    codigo_barras = matchUrl[1];
                                }
                            }
                            
                            const precioTexto = precioEl.innerText;
                            let precio = 0;
                            const matchPrecio = precioTexto.match(/\$\s?([\d\.]+)/);
                            if (matchPrecio) {
                                precio = parseInt(matchPrecio[1].replace(/\./g, '')) || 0;
                            }
                            
                            if (precio > 0) {
                                resultados.push({ nombre, marca, precio, url_producto, url_imagen, codigo_barras });
                            }
                        }
                    });
                    return resultados;
                });

                console.log(`¡Se extrajeron ${productosExtraidos.length} productos de esta página!`);

                if (productosExtraidos.length === 0) {
                    console.log('⚠️ No hay más productos. Saltando a la siguiente categoría...');
                    break; 
                }

                console.log('Guardando en MySQL...');
                
                // Contadores locales por página
                let nuevosPagina = 0;
                let existentesPagina = 0;

                for (const prod of productosExtraidos) {
                    let productoId;
                    
                    // APLICAMOS LA NORMALIZACIÓN AQUÍ ANTES DE GUARDAR O BUSCAR
                    if (prod.codigo_barras) {
                        prod.codigo_barras = normalizarEAN13(prod.codigo_barras);
                    }
                    
                    const [existente] = await pool.query(
                        `SELECT id FROM productos 
                         WHERE (codigo_barras = ? AND codigo_barras IS NOT NULL) 
                            OR (LOWER(nombre) = LOWER(?) AND LOWER(marca) = LOWER(?)) 
                         LIMIT 1`, 
                        [prod.codigo_barras, prod.nombre, prod.marca]
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
                            "INSERT INTO productos (nombre, marca, url_imagen, codigo_barras) VALUES (?, ?, ?, ?)", 
                            [prod.nombre, prod.marca, prod.url_imagen, prod.codigo_barras]
                        );
                        productoId = nuevoProd.insertId;
                        nuevosPagina++;
                        totalNuevosGlobal++;
                    }

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
                
                // Reporte visual al terminar la página
                console.log(`✅ Página procesada: ${nuevosPagina} productos nuevos agregados | ${existentesPagina} ya existían (se revisó el precio).`);
                
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        console.log('\n======================================================');
        console.log('🚀 ¡PROCESO DE LIDER COMPLETADO!');
        console.log(`📊 RESUMEN FINAL:`);
        console.log(`   - Nuevos productos creados: ${totalNuevosGlobal}`);
        console.log(`   - Productos ya existentes verificados: ${totalExistentesGlobal}`);
        console.log('======================================================\n');
        
        await browser.close();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error durante el scraping:', error);
        process.exit(1);
    }
}

explorarLider();