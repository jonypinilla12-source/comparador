const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const admin = require('firebase-admin');
require('dotenv').config();

// Inicializar Firebase Admin con la clave de servicio
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// Importamos la conexión a la base de datos
const pool = require('./db'); 

const app = express();

app.use(cors()); 
app.use(express.json()); 

const JWT_SECRET = process.env.JWT_SECRET || 'mi_clave_super_secreta_compra_inteligente_2026';
const googleClient = new OAuth2Client('509809950066-qjb5slfsogrltptcdqjaio8lri6ic9kn.apps.googleusercontent.com');

// ==========================================
// CONFIGURACIÓN DE IMÁGENES (MULTER)
// ==========================================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });
app.use('/uploads', express.static(uploadDir));

// ==========================================
// FUNCIONES AUXILIARES
// ==========================================
const verificarToken = (req, res, next) => {
    const authHeader = req.header('Authorization');
    if (!authHeader) return res.status(401).json({ error: 'Acceso denegado. Token faltante.' });
    
    const token = authHeader.replace('Bearer ', '');
    try {
        const verificado = jwt.verify(token, JWT_SECRET);
        req.user = verificado;
        next();
    } catch (error) {
        res.status(400).json({ error: 'Token no válido o expirado.' });
    }
};

// Fórmula de Haversine para distancias
function calcularDistancia(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radio de la Tierra en km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; 
}

// Busca la sucursal de la tabla `sucursales` para un supermercado_id
function obtenerSucursalDeMarca(sucursales, supermercadoId, userLat, userLon) {
    const sucursalesDeMarca = sucursales.filter(s => Number(s.supermercado_id) === Number(supermercadoId));
    if (sucursalesDeMarca.length === 0) return null;

    let sucursalSeleccionada = sucursalesDeMarca[0];
    let minDistance = Infinity;
    let distanciaStr = null;

    if (!isNaN(userLat) && !isNaN(userLon)) {
        sucursalesDeMarca.forEach(suc => {
            const d = calcularDistancia(userLat, userLon, Number(suc.latitud), Number(suc.longitud));
            if (d < minDistance) {
                minDistance = d;
                sucursalSeleccionada = suc;
                distanciaStr = (d < 1) ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`;
            }
        });
    }

    return {
        sucursal_id: sucursalSeleccionada.id,
        nombre_local: sucursalSeleccionada.nombre_local,
        direccion: sucursalSeleccionada.direccion,
        latitud: Number(sucursalSeleccionada.latitud),
        longitud: Number(sucursalSeleccionada.longitud),
        distancia_km: minDistance !== Infinity ? minDistance : null,
        distancia_str: distanciaStr
    };
}

// Obtener o crear lista por defecto si Flutter aún no envía lista_id
async function obtenerListaPorDefecto(usuario_id) {
    const [listas] = await pool.query("SELECT id FROM listas_compras WHERE usuario_id = ? ORDER BY id ASC LIMIT 1", [usuario_id]);
    if (listas.length > 0) return listas[0].id;
    
    const [res] = await pool.query("INSERT INTO listas_compras (usuario_id, nombre) VALUES (?, 'Mi Lista Principal')", [usuario_id]);
    return res.insertId;
}

app.get('/api/test', (req, res) => {
    res.json({ estado: 'éxito', mensaje: '¡La API funciona perfectamente!' });
});

// ==========================================
// RUTAS DE AUTENTICACIÓN
// ==========================================
app.post('/api/registro', async (req, res) => {
    const { nombre, apellido, fecha_nacimiento, email, password } = req.body;
    try {
        const [existe] = await pool.query("SELECT id FROM usuarios WHERE email = ?", [email]);
        if (existe.length > 0) return res.status(400).json({ error: 'El correo ya está registrado.' });

        const passwordHash = await bcrypt.hash(password, 10);
        const [resultado] = await pool.query(
            "INSERT INTO usuarios (nombre, apellido, fecha_nacimiento, email, password_hash, creado_en) VALUES (?, ?, ?, ?, ?, NOW())",
            [nombre, apellido, fecha_nacimiento, email, passwordHash]
        );
        res.status(201).json({ mensaje: 'Usuario registrado exitosamente', id: resultado.insertId });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [usuarios] = await pool.query("SELECT * FROM usuarios WHERE email = ?", [email]);
        if (usuarios.length === 0) return res.status(401).json({ error: 'Credenciales inválidas.' });

        const usuario = usuarios[0];
        if (!usuario.password_hash) return res.status(401).json({ error: 'Por favor, inicia sesión con Google.' });

        const esValida = await bcrypt.compare(password, usuario.password_hash);
        if (!esValida) return res.status(401).json({ error: 'Credenciales inválidas.' });

        const token = jwt.sign({ id: usuario.id, email: usuario.email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({
            mensaje: 'Login exitoso', token,
            usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, avatar: usuario.url_avatar }
        });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/api/login-google', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Falta el token' });
    try {
        const googleRes = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${token}`);
        const payload = await googleRes.json();
        if (payload.error) return res.status(401).json({ error: 'Token inválido' });
        
        const email = payload.email;
        const nombre = payload.given_name || payload.name;
        const apellido = payload.family_name || '';

        const [usuarios] = await pool.query("SELECT * FROM usuarios WHERE email = ?", [email]);
        let usuario = usuarios[0];

        if (!usuario) {
            const [resultado] = await pool.query(
                "INSERT INTO usuarios (nombre, apellido, email, google_id, creado_en) VALUES (?, ?, ?, ?, NOW())",
                [nombre, apellido, email, payload.sub]
            );
            usuario = { id: resultado.insertId, nombre, email };
        }

        const jwtToken = jwt.sign({ id: usuario.id, email: usuario.email }, JWT_SECRET, { expiresIn: '30d' });
        res.status(200).json({ mensaje: 'Login exitoso', token: jwtToken, usuario: { id: usuario.id, nombre: usuario.nombre } });
    } catch (error) {
        res.status(401).json({ error: 'Error de token' });
    }
});

// ==========================================
// REGISTRAR TOKEN FCM
// ==========================================
app.post('/api/usuario/fcm-token', verificarToken, async (req, res) => {
    const usuario_id = req.user.id;
    const { fcm_token } = req.body;
    try {
        await pool.query(
            "UPDATE usuarios SET fcm_token = ? WHERE id = ?",
            [fcm_token, usuario_id]
        );
        res.json({ mensaje: 'Token FCM actualizado correctamente' });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar token FCM' });
    }
});

// ==========================================
// GESTIÓN DE LISTAS DE COMPRAS
// ==========================================
app.get('/api/listas', verificarToken, async (req, res) => {
    const usuario_id = req.user.id;
    try {
        const [listas] = await pool.query("SELECT * FROM listas_compras WHERE usuario_id = ? ORDER BY creado_en DESC", [usuario_id]);
        res.json(listas);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener listas' });
    }
});

app.post('/api/listas', verificarToken, async (req, res) => {
    const usuario_id = req.user.id;
    const { nombre } = req.body;
    try {
        const [resultado] = await pool.query(
            "INSERT INTO listas_compras (usuario_id, nombre) VALUES (?, ?)", 
            [usuario_id, nombre || 'Nueva Lista']
        );
        res.status(201).json({ id: resultado.insertId, nombre, mensaje: 'Lista creada' });
    } catch (error) {
        res.status(500).json({ error: 'Error al crear la lista' });
    }
});

// ==========================================
// RUTA: ELIMINAR UNA LISTA COMPLETA Y SUS PRODUCTOS
// ==========================================
app.delete('/api/listas/:id', verificarToken, async (req, res) => {
    const listaId = parseInt(req.params.id);
    const usuarioId = req.user.id;

    try {
        await pool.query(
            "DELETE FROM favoritos WHERE lista_id = ? AND usuario_id = ?",
            [listaId, usuarioId]
        );
        await pool.query(
            "DELETE FROM listas_compras WHERE id = ? AND usuario_id = ?",
            [listaId, usuarioId]
        );

        res.json({ mensaje: 'Lista eliminada correctamente' });
    } catch (error) {
        console.error('Error al eliminar lista:', error);
        res.status(500).json({ error: 'Error al eliminar la lista' });
    }
});

// ==========================================
// RUTA: EXPLORAR PRODUCTOS
// ==========================================
app.get('/api/productos', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const categoria = req.query.categoria;
    const busqueda = req.query.busqueda;
    const userLat = parseFloat(req.query.lat);
    const userLon = parseFloat(req.query.lon);

    try {
        let whereClause = "";
        let queryParams = [];
        let orderClause = `
            COUNT(DISTINCT pp.supermercado_id) DESC,
            MAX(CASE WHEN pp.precio_anterior IS NOT NULL AND pp.precio < pp.precio_anterior THEN (pp.precio_anterior - pp.precio) ELSE 0 END) DESC,
            MAX(pp.escaneado_en) DESC,
            MIN(pp.precio) ASC
        `;

        if (busqueda && busqueda.trim() !== '') {
            const palabras = busqueda.trim().split(/\s+/);
            const condiciones = palabras.map(() => `(p.nombre LIKE ? OR p.marca LIKE ? OR p.codigo_barras LIKE ?)`);
            whereClause = "WHERE " + condiciones.join(" AND ");
            
            palabras.forEach(palabra => {
                const term = `%${palabra}%`;
                queryParams.push(term, term, term);
            });

            const primeraPalabra = `${palabras[0]}%`;
            const fraseExacta = `%${busqueda.trim()}%`;
            orderClause = `
                (CASE 
                    WHEN p.nombre LIKE ${pool.escape(primeraPalabra)} THEN 0 
                    WHEN p.nombre LIKE ${pool.escape(fraseExacta)} THEN 1 
                    ELSE 2 
                END),
                COUNT(DISTINCT pp.supermercado_id) DESC,
                MIN(pp.precio) ASC
            `;
        } else if (categoria && categoria !== 'Todos') {
            whereClause = "WHERE p.categoria = ?";
            queryParams.push(categoria);
        }

        const [countResult] = await pool.query(
            `SELECT COUNT(DISTINCT p.id) as total FROM productos p JOIN precios_productos pp ON p.id = pp.producto_id ${whereClause}`,
            queryParams
        );
        const totalProducts = countResult[0].total;
        const totalPages = Math.ceil(totalProducts / limit) || 1;

        const queryIds = `
            SELECT p.id 
            FROM productos p
            JOIN precios_productos pp ON p.id = pp.producto_id
            ${whereClause}
            GROUP BY p.id
            ORDER BY ${orderClause}
            LIMIT ? OFFSET ?
        `;
        const [idRows] = await pool.query(queryIds, [...queryParams, limit, offset]);

        if (idRows.length === 0) {
            return res.json({ data: [], currentPage: page, totalPages: 1 });
        }

        const productIds = idRows.map(row => row.id);

        const queryData = `
            SELECT 
                p.id, p.nombre as name, p.marca as brand, p.url_imagen, p.info_nutricional, 
                s.id as supermercado_id, s.nombre as supermarket, s.url_logo, 
                pp.precio as price, pp.precio_anterior, pp.url_producto, pp.escaneado_en 
            FROM productos p 
            JOIN precios_productos pp ON p.id = pp.producto_id 
            JOIN supermercados s ON pp.supermercado_id = s.id 
            WHERE p.id IN (?)
        `;
        const [rows] = await pool.query(queryData, [productIds]);
        const [sucursales] = await pool.query("SELECT * FROM sucursales WHERE latitud IS NOT NULL AND longitud IS NOT NULL");

        const obtenerColores = (nombreSuper) => {
            const lower = nombreSuper.toLowerCase();
            if (lower.includes('lider')) return { bgColor: '#DBEAFE', textColor: '#1D4ED8' };
            if (lower.includes('santa')) return { bgColor: '#FEE2E2', textColor: '#B91C1C' };
            if (lower.includes('unimarc')) return { bgColor: '#FEF3C7', textColor: '#B45309' };
            if (lower.includes('tottus')) return { bgColor: '#DCFCE7', textColor: '#15803D' };
            return { bgColor: '#DCFCE7', textColor: '#15803D' };
        };

        const productosMap = {};
        rows.forEach(row => {
            if (!productosMap[row.id]) {
                let nutricionObj = null;
                if (row.info_nutricional) {
                    try { nutricionObj = typeof row.info_nutricional === 'string' ? JSON.parse(row.info_nutricional) : row.info_nutricional; } catch (e) {}
                }
                productosMap[row.id] = { id: row.id, name: row.name, brand: row.brand, url_imagen: row.url_imagen, nutrition: nutricionObj, all_prices: [] };
            }
            
            const idxExistente = productosMap[row.id].all_prices.findIndex(p => Number(p.supermercado_id) === Number(row.supermercado_id));
            const sucInfo = obtenerSucursalDeMarca(sucursales, row.supermercado_id, userLat, userLon);

            const nuevoPrecioObj = { 
                supermercado_id: row.supermercado_id,
                supermarket: row.supermarket, 
                price: row.price, 
                precio_anterior: row.precio_anterior,
                escaneado_en: row.escaneado_en,
                url_producto: row.url_producto, 
                url_logo: row.url_logo,
                nombre_local: sucInfo ? sucInfo.nombre_local : null,
                direccion: sucInfo ? sucInfo.direccion : null,
                latitud: sucInfo ? sucInfo.latitud : null,
                longitud: sucInfo ? sucInfo.longitud : null,
                distancia_str: sucInfo ? sucInfo.distancia_str : null,
                distancia_km: sucInfo ? sucInfo.distancia_km : null
            };

            if (idxExistente === -1) {
                productosMap[row.id].all_prices.push(nuevoPrecioObj);
            } else if (row.price < productosMap[row.id].all_prices[idxExistente].price) {
                productosMap[row.id].all_prices[idxExistente] = nuevoPrecioObj;
            }
        });

        const formattedProducts = productIds.map(id => {
            const prod = productosMap[id];
            if (!prod || prod.all_prices.length === 0) return null;
            prod.all_prices.sort((a, b) => a.price - b.price);
            const cheapest = prod.all_prices[0];
            const mainColors = obtenerColores(cheapest.supermarket);
            return {
                id: prod.id, name: prod.name, brand: prod.brand, image_url: prod.url_imagen, nutrition: prod.nutrition,
                supermarket: cheapest.supermarket, price: '$ ' + cheapest.price.toLocaleString('es-CL'),
                url_logo: cheapest.url_logo, bgColor: mainColors.bgColor, textColor: mainColors.textColor,
                escaneado_en: cheapest.escaneado_en,
                all_prices: prod.all_prices.map(p => {
                    const col = obtenerColores(p.supermarket);
                    return { 
                        ...p,
                        priceStr: '$ ' + p.price.toLocaleString('es-CL'), 
                        bgColor: col.bgColor, 
                        textColor: col.textColor
                    };
                })
            };
        }).filter(Boolean);

        res.json({ data: formattedProducts, currentPage: page, totalPages: totalPages });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener productos' });
    }
});

// ==========================================
// RUTA: RECETAS
// ==========================================
app.get('/api/recetas', async (req, res) => {
    try {
        const [recetas] = await pool.query("SELECT * FROM recetas");
        if (recetas.length === 0) return res.json([]);

        for (let receta of recetas) {
            const [ingredientes] = await pool.query(`
                SELECT p.id, p.nombre, p.marca, p.url_imagen, rp.cantidad, MIN(pp.precio) as mejor_precio_actual
                FROM receta_producto rp
                JOIN productos p ON rp.producto_id = p.id
                LEFT JOIN precios_productos pp ON p.id = pp.producto_id
                WHERE rp.receta_id = ?
                GROUP BY p.id, p.nombre, p.marca, p.url_imagen, rp.cantidad
            `, [receta.id]);
            
            receta.ingredientes = ingredientes;
            receta.precio_total_estimado = ingredientes.reduce((acc, ing) => acc + ((Number(ing.mejor_precio_actual) || 0) * (Number(ing.cantidad) || 1)), 0);
        }
        res.json(recetas);
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar recetas' });
    }
});

// ==========================================
// CARRITO Y SUCURSALES
// ==========================================
app.get('/api/mi-lista', verificarToken, async (req, res) => {
    const listaId = req.query.lista_id;
    const userLat = parseFloat(req.query.lat);
    const userLon = parseFloat(req.query.lon);

    try {
        const queryListas = "SELECT id, producto_id, cantidad FROM favoritos WHERE lista_id = ?";
        const [listaRows] = await pool.query(queryListas, [listaId]);

        if (listaRows.length === 0) {
            return res.json({ productos: [], resumen: { opciones: [] } });
        }

        const productIds = listaRows.map(row => row.producto_id);
        const cantidadesMap = {};
        listaRows.forEach(row => { cantidadesMap[row.producto_id] = row.cantidad; });

        const queryData = `
            SELECT 
                p.id, p.nombre as name, p.marca as brand, p.url_imagen, p.info_nutricional, 
                s.id as supermercado_id, s.nombre as supermarket, s.url_logo, 
                pp.precio as price, pp.url_producto 
            FROM productos p 
            JOIN precios_productos pp ON p.id = pp.producto_id 
            JOIN supermercados s ON pp.supermercado_id = s.id 
            WHERE p.id IN (?)
        `;
        const [rows] = await pool.query(queryData, [productIds]);
        const [sucursales] = await pool.query("SELECT * FROM sucursales WHERE latitud IS NOT NULL AND longitud IS NOT NULL");

        const obtenerColores = (nombreSuper) => {
            const lower = nombreSuper.toLowerCase();
            if (lower.includes('lider')) return { bgColor: '#DBEAFE', textColor: '#1D4ED8' };
            if (lower.includes('santa')) return { bgColor: '#FEE2E2', textColor: '#B91C1C' };
            return { bgColor: '#DCFCE7', textColor: '#15803D' };
        };

        const productosMap = {};
        const resumenCostos = { combinada: 0, tiendas: {} };

        rows.forEach(row => {
            const prodId = row.id;
            const cantidad = cantidadesMap[prodId] || 1;

            if (!productosMap[prodId]) {
                let nutricionObj = null;
                if (row.info_nutricional) {
                    try { nutricionObj = typeof row.info_nutricional === 'string' ? JSON.parse(row.info_nutricional) : row.info_nutricional; } catch (e) {}
                }
                productosMap[prodId] = { producto_id: prodId, nombre: row.name, marca: row.brand, image_url: row.url_imagen, url_imagen: row.url_imagen, cantidad, all_prices: [] };
            }

            const sucInfo = obtenerSucursalDeMarca(sucursales, row.supermercado_id, userLat, userLon);

            productosMap[prodId].all_prices.push({ 
                supermarket: row.supermarket, 
                supermercado_id: row.supermercado_id,
                price: row.price, 
                url_producto: row.url_producto, 
                url_logo: row.url_logo,
                nombre_local: sucInfo ? sucInfo.nombre_local : null,
                direccion: sucInfo ? sucInfo.direccion : null,
                latitud: sucInfo ? sucInfo.latitud : null,
                longitud: sucInfo ? sucInfo.longitud : null,
                distancia_str: sucInfo ? sucInfo.distancia_str : null,
                distancia_km: sucInfo ? sucInfo.distancia_km : null
            });
        });

        const productosFinal = [];
        
        Object.values(productosMap).forEach(prod => {
            prod.all_prices.sort((a, b) => a.price - b.price);
            const cheapest = prod.all_prices[0];
            resumenCostos.combinada += (cheapest.price * prod.cantidad);

            prod.all_prices.forEach(p => {
                const c = obtenerColores(p.supermarket);
                p.priceStr = '$ ' + p.price.toLocaleString('es-CL');
                p.bgColor = c.bgColor;
                p.textColor = c.textColor;

                if (!resumenCostos.tiendas[p.supermarket]) {
                    resumenCostos.tiendas[p.supermarket] = { 
                        supermercado_id: p.supermercado_id,
                        nombre: p.supermarket, 
                        total: 0, 
                        faltantes: [], 
                        url_logo: p.url_logo,
                        sucursal_cercana: p.latitud != null ? {
                            nombre_local: p.nombre_local,
                            direccion: p.direccion,
                            latitud: p.latitud,
                            longitud: p.longitud,
                            distancia_str: p.distancia_str,
                            distancia_km: p.distancia_km
                        } : null
                    };
                }
                resumenCostos.tiendas[p.supermarket].total += (p.price * prod.cantidad);
            });

            const tiendasDelProducto = prod.all_prices.map(p => p.supermarket);
            Object.keys(resumenCostos.tiendas).forEach(t => {
                if (!tiendasDelProducto.includes(t)) {
                    resumenCostos.tiendas[t].faltantes.push({ id: prod.producto_id, nombre: prod.nombre });
                }
            });

            productosFinal.push(prod);
        });

        const opciones = [
            { nombre: 'COMBINADO', total: resumenCostos.combinada, total_str: '$ ' + resumenCostos.combinada.toLocaleString('es-CL'), faltantes: [], url_logo: null }
        ];

        let mejorTiendaUnica = null;
        let mejorCostoUnico = Infinity;

        Object.values(resumenCostos.tiendas).forEach(t => {
            t.total_str = '$ ' + t.total.toLocaleString('es-CL');
            opciones.push(t);
            if (t.faltantes.length === 0 && t.total < mejorCostoUnico) {
                mejorCostoUnico = t.total;
                mejorTiendaUnica = t.nombre;
            }
        });

        opciones.sort((a, b) => a.total - b.total);
        let ahorroEst = 0;
        if (opciones.length > 1) {
            const tiendasCompletas = opciones.filter(o => o.faltantes.length === 0 && o.nombre !== 'COMBINADO');
            if (tiendasCompletas.length > 0) {
                const masCara = Math.max(...tiendasCompletas.map(o => o.total));
                if (masCara > opciones[0].total) {
                    ahorroEst = masCara - opciones[0].total;
                }
            }
        }

        const resumenFinal = {
            mejor_supermercado: mejorTiendaUnica || 'COMBINADO',
            ahorro_estimado: ahorroEst > 0 ? '$ ' + ahorroEst.toLocaleString('es-CL') : null,
            ahorro_total: ahorroEst,
            opciones
        };

        res.json({ productos: productosFinal, resumen: resumenFinal });
    } catch (error) {
        console.error("Error al obtener lista:", error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/api/mi-lista/agregar', verificarToken, async (req, res) => {
    const usuario_id = req.user.id;
    let { producto_id, cantidad, lista_id } = req.body;
    try {
        if (!lista_id) lista_id = await obtenerListaPorDefecto(usuario_id);

        const [existe] = await pool.query("SELECT id FROM favoritos WHERE usuario_id = ? AND producto_id = ? AND lista_id = ?", [usuario_id, producto_id, lista_id]);
        if (existe.length > 0) {
            await pool.query("UPDATE favoritos SET cantidad = cantidad + ? WHERE id = ?", [cantidad || 1, existe[0].id]);
        } else {
            await pool.query("INSERT INTO favoritos (usuario_id, producto_id, cantidad, lista_id, creado_en) VALUES (?, ?, ?, ?, NOW())", [usuario_id, producto_id, cantidad || 1, lista_id]);
        }
        res.json({ mensaje: 'Producto agregado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al guardar' });
    }
});

app.put('/api/mi-lista/actualizar', verificarToken, async (req, res) => {
    const usuario_id = req.user.id;
    let { producto_id, cantidad, lista_id } = req.body;
    try {
        if (!lista_id) lista_id = await obtenerListaPorDefecto(usuario_id);
        await pool.query("UPDATE favoritos SET cantidad = ? WHERE usuario_id = ? AND producto_id = ? AND lista_id = ?", [cantidad, usuario_id, producto_id, lista_id]);
        res.json({ mensaje: 'Cantidad actualizada' });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar' });
    }
});

app.delete('/api/mi-lista/eliminar/:producto_id', verificarToken, async (req, res) => {
    const usuario_id = req.user.id;
    const { producto_id } = req.params;
    let lista_id = req.query.lista_id;
    try {
        if (!lista_id) lista_id = await obtenerListaPorDefecto(usuario_id);
        await pool.query("DELETE FROM favoritos WHERE usuario_id = ? AND producto_id = ? AND lista_id = ?", [usuario_id, producto_id, lista_id]);
        res.json({ mensaje: 'Producto eliminado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al eliminar' });
    }
});

// ==========================================
// RUTA: SUCURSALES
// ==========================================
app.get('/api/sucursales', async (req, res) => {
    const userLat = parseFloat(req.query.lat);
    const userLon = parseFloat(req.query.lon);

    try {
        let queryData = `
            SELECT 
                suc.id as sucursal_id, 
                suc.supermercado_id,
                suc.nombre_local, 
                suc.direccion, 
                suc.latitud, 
                suc.longitud,
                sup.nombre as nombre_cadena,
                sup.url_logo
            FROM sucursales suc
            JOIN supermercados sup ON suc.supermercado_id = sup.id
            WHERE suc.latitud IS NOT NULL AND suc.longitud IS NOT NULL
        `;

        const [rows] = await pool.query(queryData);

        const sucursalesProcesadas = rows.map(row => {
            let distancia = null;
            let distanciaStr = null;

            if (!isNaN(userLat) && !isNaN(userLon) && row.latitud && row.longitud) {
                distancia = calcularDistancia(userLat, userLon, Number(row.latitud), Number(row.longitud));
                if (distancia < 1) {
                    distanciaStr = `${Math.round(distancia * 1000)} m`;
                } else {
                    distanciaStr = `${distancia.toFixed(1)} km`;
                }
            }

            return {
                ...row,
                latitud: Number(row.latitud),
                longitud: Number(row.longitud),
                distancia_km: distancia,
                distancia_str: distanciaStr
            };
        });

        if (!isNaN(userLat) && !isNaN(userLon)) {
            sucursalesProcesadas.sort((a, b) => {
                if (a.distancia_km === null) return 1;
                if (b.distancia_km === null) return -1;
                return a.distancia_km - b.distancia_km;
            });
        }

        res.json(sucursalesProcesadas);
    } catch (error) {
        console.error("Error al obtener sucursales:", error);
        res.status(500).json({ error: 'Error interno del servidor al consultar sucursales.' });
    }
});

// ==========================================
// RUTA: ESCÁNER INTELIGENTE
// ==========================================
app.get('/api/escanear/:codigo', async (req, res) => {
    const codigoRaw = (req.params.codigo || '').trim();
    const codigoSinCeros = codigoRaw.replace(/^0+/, '');
    const codigoConCero = codigoSinCeros.length === 12 ? '0' + codigoSinCeros : codigoSinCeros;
    const userLat = parseFloat(req.query.lat);
    const userLon = parseFloat(req.query.lon);

    try {
        const [prodRows] = await pool.query(
            `SELECT id, nombre, marca, categoria, codigo_barras 
             FROM productos 
             WHERE codigo_barras IN (?, ?, ?) 
                OR codigo_barras LIKE ? 
             LIMIT 1`,
            [codigoRaw, codigoSinCeros, codigoConCero, `%${codigoSinCeros}%`]
        );

        if (prodRows.length === 0) {
            return res.status(404).json({ encontrado: false, mensaje: 'Producto no encontrado en la base de datos' });
        }

        const prodBase = prodRows[0];

        const stopWords = ['de', 'el', 'la', 'los', 'las', 'en', 'con', 'para', 'por', 'sin', 'un', 'una', 'bolsa', 'botella', 'caja', 'pack', 'envase', 'formato', 'display', 'doypack', 'tira', 'sachet', 'tarro', 'lata'];
        const marcaPalabras = (prodBase.marca || '').toLowerCase().split(/\s+/).filter(Boolean);

        const palabrasClave = (prodBase.nombre || '')
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 3 && !stopWords.includes(w) && !marcaPalabras.includes(w))
            .slice(0, 2);

        let idsSimilares = [];
        if (palabrasClave.length > 0) {
            let whereSim = "WHERE p.id != ?";
            let paramsSim = [prodBase.id];

            whereSim += " AND p.nombre LIKE ?";
            paramsSim.push(`%${palabrasClave[0]}%`);

            let orderSim = "COUNT(DISTINCT pp.supermercado_id) DESC, MIN(pp.precio) ASC";
            if (palabrasClave.length > 1) {
                orderSim = `(CASE WHEN p.nombre LIKE '%${palabrasClave[1]}%' THEN 0 ELSE 1 END), ` + orderSim;
            }

            const [simRows] = await pool.query(
                `SELECT p.id 
                 FROM productos p
                 JOIN precios_productos pp ON p.id = pp.producto_id
                 ${whereSim}
                 GROUP BY p.id
                 ORDER BY ${orderSim}
                 LIMIT 6`,
                paramsSim
            );
            idsSimilares = simRows.map(r => r.id);
        }

        const todosLosIds = [prodBase.id, ...idsSimilares];

        const [rows] = await pool.query(`
            SELECT 
                p.id, p.nombre as name, p.marca as brand, p.url_imagen, p.info_nutricional, 
                s.id as supermercado_id, s.nombre as supermarket, s.url_logo, 
                pp.precio as price, pp.precio_anterior, pp.url_producto 
            FROM productos p 
            JOIN precios_productos pp ON p.id = pp.producto_id 
            JOIN supermercados s ON pp.supermercado_id = s.id 
            WHERE p.id IN (?)
        `, [todosLosIds]);

        const [sucursales] = await pool.query("SELECT * FROM sucursales WHERE latitud IS NOT NULL AND longitud IS NOT NULL");

        const obtenerColores = (nombreSuper) => {
            const lower = nombreSuper.toLowerCase();
            if (lower.includes('lider')) return { bgColor: '#DBEAFE', textColor: '#1D4ED8' };
            if (lower.includes('santa')) return { bgColor: '#FEE2E2', textColor: '#B91C1C' };
            if (lower.includes('unimarc')) return { bgColor: '#FEF3C7', textColor: '#B45309' };
            return { bgColor: '#DCFCE7', textColor: '#15803D' };
        };

        const productosMap = {};
        rows.forEach(row => {
            if (!productosMap[row.id]) {
                let nutricionObj = null;
                if (row.info_nutricional) {
                    try { nutricionObj = typeof row.info_nutricional === 'string' ? JSON.parse(row.info_nutricional) : row.info_nutricional; } catch (e) {}
                }
                productosMap[row.id] = { id: row.id, name: row.name, brand: row.brand, url_imagen: row.url_imagen, nutrition: nutricionObj, all_prices: [] };
            }

            const idxExistente = productosMap[row.id].all_prices.findIndex(p => Number(p.supermercado_id) === Number(row.supermercado_id));
            const sucInfo = obtenerSucursalDeMarca(sucursales, row.supermercado_id, userLat, userLon);

            const nuevoPrecioObj = { 
                supermercado_id: row.supermercado_id,
                supermarket: row.supermarket, 
                price: row.price, 
                precio_anterior: row.precio_anterior,
                escaneado_en: row.escaneado_en,
                url_producto: row.url_producto, 
                url_logo: row.url_logo,
                nombre_local: sucInfo ? sucInfo.nombre_local : null,
                direccion: sucInfo ? sucInfo.direccion : null,
                latitud: sucInfo ? sucInfo.latitud : null,
                longitud: sucInfo ? sucInfo.longitud : null,
                distancia_str: sucInfo ? sucInfo.distancia_str : null,
                distancia_km: sucInfo ? sucInfo.distancia_km : null
            };

            if (idxExistente === -1) {
                productosMap[row.id].all_prices.push(nuevoPrecioObj);
            } else if (row.price < productosMap[row.id].all_prices[idxExistente].price) {
                productosMap[row.id].all_prices[idxExistente] = nuevoPrecioObj;
            }
        });

        const formatearProducto = (prod) => {
            if (!prod || prod.all_prices.length === 0) return null;
            prod.all_prices.sort((a, b) => a.price - b.price);
            const cheapest = prod.all_prices[0];
            const col = obtenerColores(cheapest.supermarket);
            return {
                id: prod.id, name: prod.name, brand: prod.brand, image_url: prod.url_imagen, nutrition: prod.nutrition,
                supermarket: cheapest.supermarket, price: '$ ' + cheapest.price.toLocaleString('es-CL'),
                url_logo: cheapest.url_logo, bgColor: col.bgColor, textColor: col.textColor,
                all_prices: prod.all_prices.map(p => {
                    const c = obtenerColores(p.supermarket);
                    return { ...p, priceStr: '$ ' + p.price.toLocaleString('es-CL'), bgColor: c.bgColor, textColor: c.textColor };
                })
            };
        };

        const productoPrincipal = formatearProducto(productosMap[prodBase.id]);
        const productosSimilares = idsSimilares.map(id => formatearProducto(productosMap[id])).filter(Boolean);

        res.json({
            encontrado: true,
            producto: productoPrincipal,
            similares: productosSimilares
        });
    } catch (error) {
        console.error("Error en escanear:", error);
        res.status(500).json({ error: 'Error al procesar el código escaneado' });
    }
});

// ==========================================
// INICIALIZAR TABLAS EXTRAS
// ==========================================
async function inicializarTablasExtras() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS notificaciones_usuario (
                id INT AUTO_INCREMENT PRIMARY KEY,
                usuario_id INT NOT NULL,
                producto_id INT NOT NULL,
                supermercado VARCHAR(100),
                precio_anterior INT,
                precio_nuevo INT,
                leida TINYINT(1) DEFAULT 0,
                fecha DATE NOT NULL,
                creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_notif_dia (usuario_id, producto_id, supermercado, fecha)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS historial_compras_usuario (
                id INT AUTO_INCREMENT PRIMARY KEY,
                usuario_id INT NOT NULL,
                lista_id INT,
                total_pagado INT NOT NULL,
                ahorro_logrado INT NOT NULL,
                detalle_json JSON,
                fecha DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            ALTER TABLE usuarios 
            ADD COLUMN IF NOT EXISTS fcm_token TEXT,
            ADD COLUMN IF NOT EXISTS notificaciones_activas TINYINT(1) DEFAULT 1,
            ADD COLUMN IF NOT EXISTS es_pro TINYINT(1) DEFAULT 0
        `);
    } catch (e) {
        console.error("Error creando tablas extras:", e.message);
    }
}
inicializarTablasExtras();

// ==========================================
// TAREA AUTOMÁTICA EN SEGUNDO PLANO (CRON)
// ==========================================
async function ejecutarRadarOfertas() {
    console.log('🔍 Ejecutando radar automático de ofertas en segundo plano...');
    try {
        const [ofertasTop] = await pool.query(`
            SELECT 
                p.id, p.nombre as name, p.marca as brand, p.url_imagen, pp.precio, pp.precio_anterior, s.nombre as supermercado
            FROM productos p
            JOIN precios_productos pp ON p.id = pp.producto_id
            JOIN supermercados s ON pp.supermercado_id = s.id
            WHERE pp.precio_anterior > pp.precio 
            AND ((pp.precio_anterior - pp.precio) / pp.precio_anterior) >= 0.15
            ORDER BY (pp.precio_anterior - pp.precio) DESC
            LIMIT 5
        `);

        if (ofertasTop.length === 0) return;

        const [usuariosTokens] = await pool.query(`
            SELECT id, fcm_token FROM usuarios WHERE fcm_token IS NOT NULL AND notificaciones_activas = 1
        `);

        for (var usuario of usuariosTokens) {
            const oferta = ofertasTop[Math.floor(Math.random() * ofertasTop.length)];
            
            const mensajePayload = {
                token: usuario.fcm_token,
                notification: {
                    title: '🔥 ¡Super Oferta Detectada!',
                    body: `${oferta.name} bajó a $${oferta.precio} en ${oferta.supermercado}. ¡Aprovecha!`,
                },
                data: {
                    producto_id: oferta.id.toString(),
                    tipo: 'oferta_radar'
                },
                android: {
                    notification: {
                        imageUrl: oferta.url_imagen || '',
                        sound: 'default',
                        priority: 'high'
                    }
                }
            };

            try {
                await admin.messaging().send(mensajePayload);
                console.log(`🚀 Notificación enviada a usuario ${usuario.id}: ${oferta.name}`);
            } catch (err) {
                console.error(`Error enviando a usuario ${usuario.id}:`, err.message);
            }
        }
    } catch (e) {
        console.error('Error en el cron job de ofertas:', e);
    }
}

cron.schedule('0 10,13,17 * * *', ejecutarRadarOfertas, {
    scheduled: true,
    timezone: "America/Santiago"
});

cron.schedule('30 19 * * *', ejecutarRadarOfertas, {
    scheduled: true,
    timezone: "America/Santiago"
});

// ==========================================
// RUTAS DE NOTIFICACIONES
// ==========================================
app.get('/api/notificaciones', verificarToken, async (req, res) => {
    const usuario_id = req.user.id;
    try {
        const [bajadas] = await pool.query(`
            SELECT DISTINCT
                f.producto_id,
                s.nombre AS supermercado,
                pp.precio AS precio_nuevo,
                COALESCE(pp.precio_anterior, f.precio_objetivo) AS precio_ant
            FROM favoritos f
            JOIN precios_productos pp ON f.producto_id = pp.producto_id
            JOIN supermercados s ON pp.supermercado_id = s.id
            WHERE f.usuario_id = ?
              AND (
                  (pp.precio_anterior IS NOT NULL AND pp.precio < pp.precio_anterior)
                  OR (f.precio_objetivo IS NOT NULL AND pp.precio < f.precio_objetivo)
              )
        `, [usuario_id]);

        for (const b of bajadas) {
            await pool.query(`
                INSERT IGNORE INTO notificaciones_usuario 
                (usuario_id, producto_id, supermercado, precio_anterior, precio_nuevo, fecha)
                VALUES (?, ?, ?, ?, ?, CURDATE())
            `, [usuario_id, b.producto_id, b.supermercado, b.precio_ant, b.precio_nuevo]);
        }

        const [notifs] = await pool.query(`
            SELECT 
                n.id, n.producto_id, n.supermercado, n.precio_anterior, n.precio_nuevo, 
                n.leida, n.creado_en,
                p.nombre, p.marca, p.url_imagen
            FROM notificaciones_usuario n
            JOIN productos p ON n.producto_id = p.id
            WHERE n.usuario_id = ?
            ORDER BY n.creado_en DESC
            LIMIT 30
        `, [usuario_id]);

        res.json(notifs);
    } catch (error) {
        console.error("Error en notificaciones:", error);
        res.status(500).json({ error: 'Error al obtener notificaciones' });
    }
});

app.put('/api/notificaciones/leer', verificarToken, async (req, res) => {
    const usuario_id = req.user.id;
    try {
        await pool.query("UPDATE notificaciones_usuario SET leida = 1 WHERE usuario_id = ?", [usuario_id]);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: 'Error al marcar notificaciones' });
    }
});

// ==========================================
// REGISTRO DE COMPRAS Y PERFIL
// ==========================================
app.post('/api/compras/registrar', verificarToken, async (req, res) => {
    const usuario_id = req.user.id;
    const { lista_id, total_pagado, ahorro_logrado, items } = req.body;
    try {
        await pool.query(
            "INSERT INTO historial_compras_usuario (usuario_id, lista_id, total_pagado, ahorro_logrado, detalle_json, fecha) VALUES (?, ?, ?, ?, ?, NOW())",
            [usuario_id, lista_id || null, total_pagado || 0, ahorro_logrado || 0, JSON.stringify(items || [])]
        );
        res.json({ mensaje: 'Compra registrada con éxito', ahorro_logrado });
    } catch (error) {
        res.status(500).json({ error: 'Error al registrar compra' });
    }
});

app.get('/api/perfil/resumen-mes', verificarToken, async (req, res) => {
    const usuario_id = req.user.id;
    try {
        const [ahorroRows] = await pool.query(`SELECT COALESCE(SUM(ahorro_logrado), 0) AS ahorro_mes, COALESCE(SUM(total_pagado), 0) AS gastado_mes, COUNT(id) AS compras_mes FROM historial_compras_usuario WHERE usuario_id = ? AND MONTH(fecha) = MONTH(CURDATE()) AND YEAR(fecha) = YEAR(CURDATE())`, [usuario_id]);
        const [listasRows] = await pool.query("SELECT COUNT(id) AS total_listas FROM listas_compras WHERE usuario_id = ?", [usuario_id]);
        const [userRows] = await pool.query("SELECT es_pro FROM usuarios WHERE id = ?", [usuario_id]); // NUEVO

        res.json({
            ahorro_mes: Number(ahorroRows[0].ahorro_mes || 0),
            gastado_mes: Number(ahorroRows[0].gastado_mes || 0),
            compras_mes: Number(ahorroRows[0].compras_mes || 0),
            total_listas: Number(listasRows[0].total_listas || 0),
            es_pro: userRows.length > 0 ? (userRows[0].es_pro === 1) : false // NUEVO
        });
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener resumen mensual' });
    }
});


// ==========================================
// MÓDULO DE PAGOS Y SUSCRIPCIONES (MERCADO PAGO)
// ==========================================
const { MercadoPagoConfig, PreApproval } = require('mercadopago');

const MP_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-4666261307030308-111114-027741ea48875d652c922aa5ea1e0b34-3462407532';
const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });

// Asegurar que la tabla suscripciones exista
pool.query(`
    CREATE TABLE IF NOT EXISTS suscripciones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        transaccion_id VARCHAR(100),
        monto INT DEFAULT 2990,
        estado VARCHAR(50),
        fecha_expiracion DATETIME,
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).catch(err => console.error('Error tabla suscripciones:', err.message));

// Función auxiliar para activar el PRO en BD
async function activarUsuarioPro(usuarioId, transaccionId, monto = 2990) {
    if (!usuarioId) return;
    const fechaExpiracion = new Date();
    fechaExpiracion.setDate(fechaExpiracion.getDate() + 30);

    await pool.query(`UPDATE usuarios SET es_pro = 1 WHERE id = ?`, [usuarioId]);
    await pool.query(
        `INSERT INTO suscripciones (usuario_id, transaccion_id, monto, estado, fecha_expiracion) VALUES (?, ?, ?, 'activo', ?)`,
        [usuarioId, transaccionId.toString(), Number(monto) || 2990, fechaExpiracion]
    );
    console.log(`👑 Usuario ID ${usuarioId} actualizado a PRO exitosamente.`);
}

// 1. Endpoint para crear Suscripción con 7 DÍAS GRATIS
app.post('/api/crear-suscripcion', verificarToken, async (req, res) => {
    try {
        const usuario_id = req.user.id;
        const emailOriginal = req.user.email;
        const { plan_nombre, precio } = req.body;

        const emailPagador = (emailOriginal === 'jonypinilla.12@gmail.com' || emailOriginal === 'jonycruzado.12@gmail.com') 
            ? 'test_user_1008424578@testuser.com' 
            : emailOriginal;

        const preApproval = new PreApproval(client);
        const result = await preApproval.create({
            body: {
                reason: plan_nombre || 'Ahorrapp Pro - Suscripción Mensual (7 Días Gratis)',
                auto_recurring: {
                    frequency: 1,
                    frequency_type: 'months',
                    transaction_amount: Number(precio) || 2990,
                    currency_id: 'CLP',
                    free_trial: {
                        frequency: 7,
                        frequency_type: 'days'
                    }
                },
                back_url: 'https://api.opinox.cl/api/suscripcion-exitosa',
                notification_url: 'https://api.opinox.cl/api/webhook/mercadopago',
                payer_email: emailPagador,
                external_reference: usuario_id.toString()
            }
        });

        res.json({ success: true, init_point: result.init_point });

    } catch (error) {
        console.error('Error MP:', error);
        res.status(500).json({ success: false, error: 'No se pudo iniciar la suscripción' });
    }
});

// 1.5 Ruta de retorno cuando el usuario termina de pagar en el navegador
app.get('/api/suscripcion-exitosa', async (req, res) => {
    const preapprovalId = req.query.preapproval_id;
    if (preapprovalId) {
        try {
            const response = await fetch(`https://api.mercadopago.com/preapproval/${preapprovalId}`, {
                headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
            });
            const subData = await response.json();
            if (subData.status === 'authorized' && subData.external_reference) {
                await activarUsuarioPro(subData.external_reference, subData.id, subData.auto_recurring?.transaction_amount);
            }
        } catch (e) {
            console.error('Error verificando retorno MP:', e);
        }
    }
    res.send(`
        <html>
            <body style="font-family: sans-serif; text-align: center; padding-top: 60px; background: #1E1B4B; color: white;">
                <h1>👑 ¡Suscripción PRO Activada!</h1>
                <p>Ya puedes cerrar esta ventana y volver a la aplicación Ahorrapp.</p>
            </body>
        </html>
    `);
});

// 2. Endpoint para Cancelar Suscripción (Mantiene el mes activo)
app.put('/api/cancelar-suscripcion', verificarToken, async (req, res) => {
    try {
        const usuario_id = req.user.id;
        await pool.query("UPDATE suscripciones SET estado = 'cancelada_pendiente_expirar' WHERE usuario_id = ?", [usuario_id]);
        res.json({ success: true, mensaje: 'Suscripción cancelada. Seguirás siendo PRO hasta que termine tu ciclo actual.' });
    } catch (error) {
        res.status(500).json({ error: 'Error al cancelar' });
    }
});

// 3. Webhook de Mercado Pago (Soporta Suscripciones con 7 días gratis y Pagos directos)
app.post('/api/webhook/mercadopago', async (req, res) => {
    try {
        const eventData = req.body;
        const type = eventData.type || req.query.type || req.query.topic;
        const dataId = eventData.data?.id || req.query['data.id'] || req.query.id;

        console.log('🔔 Webhook MP recibido:', { type, action: eventData.action, dataId });

        // CASO A: Suscripción (PreApproval) autorizada (activa los 7 días gratis de inmediato)
        if (type === 'subscription_preapproval' || type === 'preapproval' || (eventData.action && eventData.action.includes('preapproval'))) {
            if (dataId) {
                const response = await fetch(`https://api.mercadopago.com/preapproval/${dataId}`, {
                    headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
                });
                const subData = await response.json();

                if (subData.status === 'authorized') {
                    await activarUsuarioPro(subData.external_reference, subData.id, subData.auto_recurring?.transaction_amount);
                }
            }
        }

        // CASO B: Cobro de pago normal aprobado
        if (type === 'payment' || eventData.action === 'payment.created') {
            if (dataId) {
                const response = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
                    headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
                });
                const pagoData = await response.json();

                if (pagoData.status === 'approved') {
                    await activarUsuarioPro(pagoData.external_reference, pagoData.id, pagoData.transaction_amount);
                }
            }
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Error en Webhook MP:', error);
        res.status(500).send('Error interno');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`));