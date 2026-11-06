const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

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
// PRODUCTOS Y RECETAS
// ==========================================
app.get('/api/productos', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const busqueda = req.query.busqueda || '';
    const categoria = req.query.categoria || '';
    const userLat = parseFloat(req.query.lat);
    const userLon = parseFloat(req.query.lon);

    try {
        let whereClause = "WHERE 1=1";
        let paramsCount = [];

        if (busqueda) {
            whereClause += " AND (p.nombre LIKE ? OR p.marca LIKE ? OR p.codigo_barras LIKE ?)";
            const term = `%${busqueda}%`;
            paramsCount.push(term, term, term);
        }

        if (categoria && categoria.toLowerCase() !== 'todos') {
            whereClause += " AND p.categoria = ?";
            paramsCount.push(categoria);
        }

        const countQuery = `SELECT COUNT(DISTINCT p.id) as total FROM productos p ${whereClause}`;
        const [countResult] = await pool.query(countQuery, paramsCount);
        const totalItems = countResult[0].total;
        const totalPages = Math.ceil(totalItems / limit);

        if (totalItems === 0) {
            return res.json({ data: [], currentPage: page, totalPages: 0 });
        }

        const idsQuery = `SELECT DISTINCT p.id FROM productos p ${whereClause} LIMIT ? OFFSET ?`;
        const [idsRows] = await pool.query(idsQuery, [...paramsCount, limit, offset]);
        const ids = idsRows.map(r => r.id);

        if (ids.length === 0) {
            return res.json({ data: [], currentPage: page, totalPages: 0 });
        }

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
        const [rows] = await pool.query(queryData, [ids]);

        // Cargar todas las sucursales de la base de datos (siempre)
        const [sucursales] = await pool.query("SELECT * FROM sucursales WHERE latitud IS NOT NULL AND longitud IS NOT NULL");

        const obtenerColores = (nombreSuper) => {
            const lower = nombreSuper.toLowerCase();
            if (lower.includes('lider')) return { bgColor: '#DBEAFE', textColor: '#1D4ED8' };
            if (lower.includes('santa')) return { bgColor: '#FEE2E2', textColor: '#B91C1C' };
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

            // Obtener sucursal real desde la tabla `sucursales` (con o sin userLat/userLon)
            const sucInfo = obtenerSucursalDeMarca(sucursales, row.supermercado_id, userLat, userLon);

            productosMap[row.id].all_prices.push({ 
                supermercado_id: row.supermercado_id,
                supermarket: row.supermarket, 
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

        const productosArray = ids.map(id => productosMap[id]).filter(Boolean);
        
        const productosFormateados = productosArray.map(prod => {
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
        });

        res.json({ data: productosFormateados, currentPage: page, totalPages: totalPages });
    } catch (error) {
        console.error("Error productos:", error);
        res.status(500).json({ error: 'Error al obtener productos' });
    }
});

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
// CARRITO MULTI-LISTAS Y SUCURSALES
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

            // Obtener sucursal real de la tabla `sucursales` (siempre)
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
// RUTA: OBTENER SUCURSALES CERCANAS (MAPA GENERAL)
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`));