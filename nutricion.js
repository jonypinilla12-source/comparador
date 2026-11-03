const pool = require('./db');

async function actualizarNutricion() {
    try {
        console.log('1. Buscando productos sin información nutricional...');
        
        const [productos] = await pool.query(
            "SELECT id, nombre, codigo_barras FROM productos WHERE info_nutricional IS NULL AND codigo_barras IS NOT NULL"
        );

        if (productos.length === 0) {
            console.log('✅ Todos los productos ya tienen su información nutricional o no hay códigos de barra.');
            process.exit(0);
        }

        console.log(`¡Se encontraron ${productos.length} productos! Consultando a la API de Open Food Facts...\n`);

        for (const prod of productos) {
            // EL TRUCO MÁGICO: Le quitamos todos los "0" que estén al principio del código
            // Transforma "00780261500657" en "780261500657"
            const codigoLimpio = prod.codigo_barras.replace(/^0+/, '');
            
            const apiUrl = `https://world.openfoodfacts.org/api/v0/product/${codigoLimpio}.json`;
            
            try {
                // Le pasamos un "Carnet de Identidad" para que la API no nos bloquee
                const respuesta = await fetch(apiUrl, {
                    headers: {
                        'User-Agent': 'ProyectoCompraInteligente - Node Script - Chile'
                    }
                });
                
                // Escudo protector
                if (!respuesta.ok) {
                    console.log(`⚠️ [ERROR API] El servidor rechazó el código ${codigoLimpio} (Código HTTP: ${respuesta.status}). Saltando...`);
                    continue;
                }

                // Ahora sí sabemos que es seguro transformarlo a JSON
                const data = await respuesta.json();

                if (data.status === 1 && data.product && data.product.nutriments) {
                    const nutrientes = data.product.nutriments;
                    
                    const infoGuardar = {
                        calorias_100g: nutrientes['energy-kcal_100g'] || 0,
                        proteinas_100g: nutrientes.proteins_100g || 0,
                        carbohidratos_100g: nutrientes.carbohydrates_100g || 0,
                        grasas_100g: nutrientes.fat_100g || 0,
                        azucares_100g: nutrientes.sugars_100g || 0,
                        sodio_100g: nutrientes.sodium_100g || 0,
                        ingredientes: data.product.ingredients_text_es || data.product.ingredients_text || "No especificado"
                    };

                    await pool.query(
                        "UPDATE productos SET info_nutricional = ? WHERE id = ?",
                        [JSON.stringify(infoGuardar), prod.id]
                    );
                    console.log(`✅ [ÉXITO] Nutrientes guardados para: ${prod.nombre}`);
                } else {
                    console.log(`⚠️ [NO ENCONTRADO] El código ${codigoLimpio} no está en la base mundial.`);
                }
            } catch (err) {
                // Si aún así ocurre un error raro, lo atrapamos sin detener todo
                console.error(`❌ Error procesando el código ${codigoLimpio}: La API no devolvió datos válidos.`);
            }
            
            // Pausa de 1 segundo
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log('\n🚀 ¡Proceso de actualización nutricional terminado!');
        process.exit(0);

    } catch (error) {
        console.error('❌ Error general:', error);
        process.exit(1);
    }
}

actualizarNutricion();