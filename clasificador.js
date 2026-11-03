const pool = require('./db');

// Usamos un Array para GARANTIZAR el orden de evaluación.
// Las categorías más específicas van primero. Las más generales (como Despensa) van al final.
const reglasCategorias = [
    {
        categoria: 'Snacks y Dulces', 
        palabras: ['galleta', 'chocolate', 'papas fritas', 'ramitas', 'maní', 'mani', 'caramelo', 'alfajor', 'chicle', 'gomitas', 'cereal', 'barrita']
    },
    {
        categoria: 'Cuidado Personal', 
        palabras: ['shampoo', 'acondicionador', 'jabón', 'jabon', 'pasta dental', 'desodorante', 'crema', 'toallas femeninas', 'pañales', 'toallitas']
    },
    {
        categoria: 'Limpieza y Aseo', 
        palabras: ['detergente', 'lavalozas', 'lavaloza', 'cloro', 'papel higiénico', 'toalla de papel', 'toalla nova', 'limpiador', 'suavizante', 'desengrasante', 'basura', 'esponja']
    },
    {
        categoria: 'Mascotas', 
        palabras: ['perro', 'gato', 'mascota', 'dog chow', 'cat chow', 'purina', 'master dog', 'whiskas', 'pedigree', 'champion dog']
    },
    {
        categoria: 'Carnes y Pescados', 
        palabras: ['vacuno', 'pollo', 'cerdo', 'pavo', 'posta', 'lomo', 'pechuga', 'trutro', 'carne', 'chuleta', 'salchicha', 'vienesa', 'hamburguesa', 'longaniza']
    },
    {
        categoria: 'Lácteos', 
        palabras: ['leche', 'queso', 'yoghurt', 'yogur', 'mantequilla', 'margarina', 'probiotico']
    },
    {
        categoria: 'Bebidas y Licores', 
        palabras: ['bebida', 'jugo', 'cerveza', 'vino', 'pisco', 'ron', 'vodka', 'agua mineral', 'agua saborizada', 'néctar', 'nectar', 'licor', 'energetica', 'isotonica']
    },
    // Despensa va al final. Si es "Galleta de arroz", ya fue atrapado por "Snacks" en el paso 1.
    {
        categoria: 'Despensa', 
        palabras: ['arroz', 'fideo', 'pasta', 'tallarin', 'espiral', 'aceite', 'salsa', 'sal', 'azúcar', 'azucar', 'harina', 'atún', 'atun', 'jurel', 'lenteja', 'poroto', 'garbanzo', 'ketchup', 'mayonesa', 'sopa', 'caldo', 'te', 'té', 'café', 'cafe']
    }
];

async function categorizarProductos() {
    try {
        console.log('🔍 Buscando productos para categorizar en la base de datos...');
        
        // Traemos los productos (puedes quitar el WHERE si quieres recategorizar todo de cero)
        const [productos] = await pool.query("SELECT id, nombre FROM productos WHERE categoria IS NULL OR categoria = 'Otros'");
        
        if (productos.length === 0) {
            console.log('✅ Todos tus productos ya tienen categoría.');
            process.exit(0);
        }

        console.log(`🛠️ Se encontraron ${productos.length} productos. Iniciando clasificación inteligente...`);
        
        let clasificados = 0;

        for (const prod of productos) {
            // Pasamos el nombre a minúsculas para compararlo fácilmente
            const nombreLimpio = prod.nombre.toLowerCase();
            let categoriaAsignada = 'Otros';

            // Recorremos el arreglo EN ORDEN
            for (const regla of reglasCategorias) {
                // Verificamos si alguna palabra de esta categoría está en el nombre
                const coincidencia = regla.palabras.some(palabra => nombreLimpio.includes(palabra));
                
                if (coincidencia) {
                    categoriaAsignada = regla.categoria;
                    break; // ¡CLAVE! Al encontrar la primera coincidencia, se detiene y no sigue buscando
                }
            }

            if (categoriaAsignada !== 'Otros') {
                await pool.query(
                    "UPDATE productos SET categoria = ? WHERE id = ?", 
                    [categoriaAsignada, prod.id]
                );
                clasificados++;
                
                if (clasificados % 500 === 0) {
                    console.log(`⚡ Progreso: ${clasificados} clasificados...`);
                }
            }
        }
        
        console.log(`\n🚀 ¡Listo! Se clasificaron automáticamente ${clasificados} productos.`);
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error al categorizar:', error);
        process.exit(1);
    }
}

categorizarProductos();