const pool = require('./db');

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

async function limpiarBaseDeDatos() {
    try {
        console.log('🔍 Buscando códigos con ceros a la izquierda en la base de datos...');
        
        // Buscamos productos con el código sucio
        const [productos] = await pool.query("SELECT id, codigo_barras, nombre FROM productos WHERE codigo_barras LIKE '0%'");
        
        if (productos.length === 0) {
            console.log('✅ No hay códigos con ceros. ¡Tu base de datos está limpia!');
            process.exit(0);
        }

        console.log(`🛠️ Se encontraron ${productos.length} productos. Verificando y arreglando...`);
        
        let arreglados = 0;
        let fusionados = 0;

        for (const prod of productos) {
            const codigoNuevo = normalizarEAN13(prod.codigo_barras);
            
            // 1. Revisamos si el código limpio YA EXISTE en otro producto de la base de datos
            const [duplicados] = await pool.query(
                "SELECT id FROM productos WHERE codigo_barras = ? AND id != ? LIMIT 1",
                [codigoNuevo, prod.id]
            );

            if (duplicados.length > 0) {
                // ¡El producto ya existía! Hay que fusionarlos.
                const idOriginal = duplicados[0].id;
                console.log(`⚠️ Fusión necesaria: El código ${codigoNuevo} ya lo tiene el ID ${idOriginal}. Uniendo con "${prod.nombre}"...`);

                // Movemos los precios y el historial de Lider al producto original (usando IGNORE por si ya había precio ese día)
                await pool.query("UPDATE IGNORE precios_productos SET producto_id = ? WHERE producto_id = ?", [idOriginal, prod.id]);
                await pool.query("UPDATE IGNORE historial_precios SET producto_id = ? WHERE producto_id = ?", [idOriginal, prod.id]);
                
                // Limpiamos la basura huérfana
                await pool.query("DELETE FROM precios_productos WHERE producto_id = ?", [prod.id]);
                await pool.query("DELETE FROM historial_precios WHERE producto_id = ?", [prod.id]);
                
                // Eliminamos el duplicado (el que tenía los 00)
                await pool.query("DELETE FROM productos WHERE id = ?", [prod.id]);
                fusionados++;

            } else {
                // 2. Si el código no existe en ningún otro lado, simplemente lo actualizamos
                await pool.query(
                    "UPDATE productos SET codigo_barras = ? WHERE id = ?", 
                    [codigoNuevo, prod.id]
                );
                console.log(`✅ ID ${prod.id} (${prod.nombre.substring(0, 15)}...): ${prod.codigo_barras} ➡️  ${codigoNuevo}`);
                arreglados++;
            }
        }
        
        console.log(`\n🚀 ¡Listo! Se actualizaron ${arreglados} códigos solos y se fusionaron ${fusionados} duplicados exitosamente.`);
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error al limpiar la base de datos:', error);
        process.exit(1);
    }
}

limpiarBaseDeDatos();