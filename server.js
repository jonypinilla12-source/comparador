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
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; 
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
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        const categoria = req.query.categoria || 'Todos';
        const busqueda = req.query.busqueda || '';
        
        // RECIBIMOS LA UBICACIÓN DESDE FLUTTER
        const lat = parseFloat(req.query.lat);
        const lon = parseFloat(req.query.lon);

        let filtroSql = "";
        let queryParamsCount = [];
        let queryParamsIds = [];

        if (busqueda) {
            const busquedaLimpia = busqueda.trim();
            if (/^\d+$/.test(busquedaLimpia)) {
                filtroSql = " AND p.codigo_barras = ?";
                queryParamsCount = [busquedaLimpia];
                queryParamsIds = [busquedaLimpia, limit, offset];
            } else {
                const palabras = busquedaLimpia.toLowerCase().split(' ').filter(p => p.length > 0);
                let condiciones = [];
                palabras.forEach(palabra => {
                    let termino = palabra;
                    if (termino.endsWith('s') && termino.length > 3) termino = termino.slice(0, -1);
                    condiciones.push("(LOWER(p.nombre) LIKE ? OR LOWER(p.marca) LIKE ?)");
                    queryParamsCount.push(`%${termino}%`, `%${termino}%`);
                    queryParamsIds.push(`%${termino}%`, `%${termino}%`);
                });
                filtroSql = " AND (" + condiciones.join(" AND ") + ")";
                queryParamsIds.push(limit, offset);
            }
        } else if (categoria !== 'Todos') {
            filtroSql = " AND p.categoria = ?";
            queryParamsCount = [categoria];
            queryParamsIds = [categoria, limit, offset];
        } else {
            queryParamsIds = [limit, offset];
        }

        const queryCount = `SELECT COUNT(DISTINCT pp.producto_id) as total FROM precios_productos pp JOIN productos p ON p.id = pp.producto_id WHERE 1=1 ${filtroSql}`;
        const [countResult] = await pool.query(queryCount, queryParamsCount);
        const totalProductos = countResult[0].total;
        const totalPages = Math.ceil(totalProductos / limit);

        if (totalProductos === 0) return res.json({ data: [], currentPage: page, totalPages: 0 });

        const queryIds = `SELECT p.id, COUNT(DISTINCT pp.supermercado_id) as cant_supermercados FROM productos p JOIN precios_productos pp ON p.id = pp.producto_id WHERE 1=1 ${filtroSql} GROUP BY p.id ORDER BY cant_supermercados DESC, p.id DESC LIMIT ? OFFSET ?`;
        const [productosIds] = await pool.query(queryIds, queryParamsIds);

        if (productosIds.length === 0) return res.json({ data: [], currentPage: page, totalPages: totalPages });
        const ids = productosIds.map(p => p.id);

        const queryData = `
            SELECT p.id, p.nombre as name, p.marca as brand, p.url_imagen, p.info_nutricional, 
                   s.id as supermercado_id, s.nombre as supermarket, s.url_logo, pp.precio as price, pp.url_producto 
            FROM productos p 
            JOIN precios_productos pp ON p.id = pp.producto_id 
            JOIN supermercados s ON pp.supermercado_id = s.id 
            WHERE p.id IN (?)`;
        const [rows] = await pool.query(queryData, [ids]);
        
        // CALCULAMOS LAS SUCURSALES CERCANAS
        let sucursalesInfo = {};
        if (!isNaN(lat) && !isNaN(lon)) {
            const [sucursales] = await pool.query("SELECT * FROM sucursales");
            sucursales.forEach(suc => {
                const dist = calcularDistancia(lat, lon, suc.latitud, suc.longitud);
                if (!sucursalesInfo[suc.supermercado_id] || dist < sucursalesInfo[suc.supermercado_id].distancia) {
                    sucursalesInfo[suc.supermercado_id] = {
                        nombre_local: suc.nombre_local,
                        distancia: dist,
                        distancia_str: dist < 1 ? `${(dist * 1000).toFixed(0)} m` : `${dist.toFixed(1)} km`,
                        latitud: suc.latitud,
                        longitud: suc.longitud
                    };
                }
            });
        }
        
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
            productosMap[row.id].all_prices.push({ 
                supermercado_id: row.supermercado_id, // Añadido para el cruce
                supermarket: row.supermarket, 
                price: row.price, 
                url_producto: row.url_producto, 
                url_logo: row.url_logo 
            });
        });

        const productosArray = ids.map(id => productosMap[id]).filter(Boolean);
        const productosFormateados = productosArray.map(prod => {
            prod.all_prices.sort((a, b) => a.price - b.price);
            const cheapest = prod.all_prices[0];
            const col = obtenerColores(cheapest.supermarket);
            return {
                id: prod.id, name: prod.name, brand: prod.brand, image_url: prod.url_imagen, nutrition: prod.nutrition,
                supermarket: cheapest.supermarket, price: '$' + cheapest.price.toLocaleString('es-CL'),
                url_logo: cheapest.url_logo,
                bgColor: col.bgColor, textColor: col.textColor,
                all_prices: prod.all_prices.map(p => {
                    const c = obtenerColores(p.supermarket);
                    const suc = sucursalesInfo[p.supermercado_id]; // Obtenemos la sucursal
                    return { 
                        supermarket: p.supermarket, 
                        price: p.price, // Mantenemos el int para los cálculos
                        priceStr: '$' + p.price.toLocaleString('es-CL'), 
                        url_producto: p.url_producto, 
                        url_logo: p.url_logo, 
                        bgColor: c.bgColor, 
                        textColor: c.textColor,
                        // Añadimos los datos de la sucursal al producto
                        nombre_local: suc ? suc.nombre_local : null,
                        distancia_str: suc ? suc.distancia_str : null,
                        latitud: suc ? suc.latitud : null,
                        longitud: suc ? suc.longitud : null,
                    };
                })
            };
        });

        res.json({ data: productosFormateados, currentPage: page, totalPages: totalPages });
    } catch (error) {
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
    const usuario_id = req.user.id;
    let lista_id = req.query.lista_id;
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);

    try {
        if (!lista_id) lista_id = await obtenerListaPorDefecto(usuario_id);

        const queryLista = `
            SELECT f.id as favorito_id, f.cantidad, p.id as producto_id, p.nombre, p.marca, p.url_imagen 
            FROM favoritos f
            JOIN productos p ON f.producto_id = p.id
            WHERE f.usuario_id = ? AND f.lista_id = ?
        `;
        const [productosLista] = await pool.query(queryLista, [usuario_id, lista_id]);
        if (productosLista.length === 0) return res.json({ productos: [], resumen: null });

        const idsProductos = productosLista.map(p => p.producto_id);

        const queryPrecios = `
            SELECT pp.producto_id, pp.precio, s.id as supermercado_id, s.nombre as supermarket, s.url_logo, pp.url_producto
            FROM precios_productos pp
            JOIN supermercados s ON pp.supermercado_id = s.id
            WHERE pp.producto_id IN (?)
        `;
        const [precios] = await pool.query(queryPrecios, [idsProductos]);

        // Calcular sucursales cercanas si hay GPS
        let sucursalesInfo = {};
        if (!isNaN(lat) && !isNaN(lon)) {
            const [sucursales] = await pool.query("SELECT * FROM sucursales");
            sucursales.forEach(suc => {
                const dist = calcularDistancia(lat, lon, suc.latitud, suc.longitud);
                if (!sucursalesInfo[suc.supermercado_id] || dist < sucursalesInfo[suc.supermercado_id].distancia) {
                    sucursalesInfo[suc.supermercado_id] = {
                        nombre_local: suc.nombre_local,
                        distancia: dist,
                        distancia_str: dist < 1 ? `${(dist * 1000).toFixed(0)} m` : `${dist.toFixed(1)} km`,
                        latitud: suc.latitud,
                        longitud: suc.longitud
                    };
                }
            });
        }

        let totalesSupermercados = {};
        precios.forEach(p => {
            if (!totalesSupermercados[p.supermarket]) {
                totalesSupermercados[p.supermarket] = { id: p.supermercado_id, total: 0, items_encontrados: [], items_faltantes: [], url_logo: p.url_logo };
            }
        });

        let totalCombinado = 0;
        const obtenerColores = (nombre) => {
            const l = nombre.toLowerCase();
            if (l.includes('lider')) return { bgColor: '#DBEAFE', textColor: '#1D4ED8' };
            if (l.includes('santa')) return { bgColor: '#FEE2E2', textColor: '#B91C1C' };
            return { bgColor: '#DCFCE7', textColor: '#15803D' };
        };

        const productosFinales = productosLista.map(prod => {
            const preciosDelProducto = precios.filter(p => p.producto_id === prod.producto_id);
            for (let superm in totalesSupermercados) {
                const precioEnSuper = preciosDelProducto.find(p => p.supermarket === superm);
                if (precioEnSuper) {
                    totalesSupermercados[superm].total += (precioEnSuper.precio * prod.cantidad);
                    totalesSupermercados[superm].items_encontrados.push(prod.producto_id);
                } else {
                    totalesSupermercados[superm].items_faltantes.push({ nombre: prod.nombre, marca: prod.marca || 'Sin marca', imagen: prod.url_imagen });
                }
            }
            preciosDelProducto.sort((a, b) => a.precio - b.precio);
            if (preciosDelProducto.length > 0) totalCombinado += (preciosDelProducto[0].precio * prod.cantidad);

            return {
                favorito_id: prod.favorito_id, producto_id: prod.producto_id, nombre: prod.nombre, 
                marca: prod.marca, cantidad: prod.cantidad, image_url: prod.url_imagen,
                all_prices: preciosDelProducto.map(p => {
                    const col = obtenerColores(p.supermarket);
                    return { supermarket: p.supermarket, price: p.precio, priceStr: '$' + p.precio.toLocaleString('es-CL'), url_producto: p.url_producto, url_logo: p.url_logo, bgColor: col.bgColor, textColor: col.textColor };
                })
            };
        });

        let opciones = [{ nombre: 'Combinado (Varias Tiendas)', total: totalCombinado, total_str: '$' + totalCombinado.toLocaleString('es-CL'), bgColor: '#F3F4F6', textColor: '#1F2937', faltantes: [], estaCompleto: true }];

        for (const [nombre, data] of Object.entries(totalesSupermercados)) {
            if (data.items_encontrados.length > 0) {
                const col = obtenerColores(nombre);
                opciones.push({
                    nombre: nombre, total: data.total, total_str: '$' + data.total.toLocaleString('es-CL'),
                    bgColor: col.bgColor, textColor: col.textColor,
                    faltantes: data.items_faltantes, estaCompleto: data.items_faltantes.length === 0,
                    sucursal_cercana: sucursalesInfo[data.id] || null,
                    url_logo: data.url_logo
                });
            }
        }

        opciones.sort((a, b) => {
            if (a.estaCompleto && !b.estaCompleto) return -1;
            if (!a.estaCompleto && b.estaCompleto) return 1;
            if (!a.estaCompleto && !b.estaCompleto) return a.faltantes.length - b.faltantes.length;
            return a.total - b.total;
        });

        let ahorroTotal = 0;
        const opcionesCompletas = opciones.filter(o => o.estaCompleto);
        if (opcionesCompletas.length > 1) {
            ahorroTotal = opcionesCompletas[opcionesCompletas.length - 1].total - opcionesCompletas[0].total;
        }

        res.json({ productos: productosFinales, resumen: { opciones, ahorro_total: ahorroTotal, ahorro_total_str: '$' + ahorroTotal.toLocaleString('es-CL') } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener la lista de compras' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`));