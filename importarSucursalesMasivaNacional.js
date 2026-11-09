const pool = require('./db');

async function registrarSucursalesMasivoNacional() {
    try {
        console.log('🌍 Iniciando el registro masivo de sucursales a nivel nacional...');

        // 1. Asegurar la existencia de las 5 cadenas
        const cadenas = [
            { nombre: 'Lider', logo: 'https://www.google.com/s2/favicons?domain=lider.cl&sz=128' },
            { nombre: 'Jumbo', logo: 'https://www.google.com/s2/favicons?domain=jumbo.cl&sz=128' },
            { nombre: 'Santa Isabel', logo: 'https://www.google.com/s2/favicons?domain=santaisabel.cl&sz=128' },
            { nombre: 'Unimarc', logo: 'https://www.google.com/s2/favicons?domain=unimarc.cl&sz=128' },
            { nombre: 'Tottus', logo: 'https://www.google.com/s2/favicons?domain=tottus.cl&sz=128' }
        ];

        const idsSuper = {};
        for (const cadena of cadenas) {
            const [existe] = await pool.query("SELECT id FROM supermercados WHERE LOWER(nombre) = ?", [cadena.nombre.toLowerCase()]);
            if (existe.length > 0) {
                idsSuper[cadena.nombre] = existe[0].id;
            } else {
                const [nuevo] = await pool.query("INSERT INTO supermercados (nombre, url_logo) VALUES (?, ?)", [cadena.nombre, cadena.logo]);
                idsSuper[cadena.nombre] = nuevo.insertId;
            }
        }

        // 2. Catálogo Nacional Masivo
        const sucursalesPais = [
            // --- ZONA NORTE ---
            { super: 'Lider', local: 'Lider Arica', dir: 'Diego Portales 1402, Arica', lat: -18.4682, lon: -70.3015 },
            { super: 'Jumbo', local: 'Jumbo Iquique', dir: 'Av. Héroes de la Concepción 2653, Iquique', lat: -20.2415, lon: -70.1342 },
            { super: 'Lider', local: 'Lider Iquique Sur', dir: 'Av. Arturo Prat 2739, Iquique', lat: -20.2520, lon: -70.1305 },
            { super: 'Jumbo', local: 'Jumbo Antofagasta (Angamos)', dir: 'Av. Angamos 745, Antofagasta', lat: -23.6705, lon: -70.4072 },
            { super: 'Lider', local: 'Lider Antofagasta', dir: 'Zenteno 21, Antofagasta', lat: -23.6335, lon: -70.3952 },
            { super: 'Tottus', local: 'Tottus Mall Antofagasta', dir: 'Av. Balmaceda 2355, Antofagasta', lat: -23.6461, lon: -70.3995 },
            { super: 'Unimarc', local: 'Unimarc Calama', dir: 'Av. Balmaceda 3242, Calama', lat: -22.4645, lon: -68.9242 },
            { super: 'Lider', local: 'Lider Calama', dir: 'Av. Granaderos 2831, Calama', lat: -22.4556, lon: -68.9261 },
            { super: 'Jumbo', local: 'Jumbo Copiapó', dir: 'Av. Copayapu 2406, Copiapó', lat: -27.3775, lon: -70.3204 },
            { super: 'Lider', local: 'Lider La Serena', dir: 'Francisco de Aguirre 2, La Serena', lat: -29.9045, lon: -71.2612 },
            { super: 'Jumbo', local: 'Jumbo La Serena', dir: 'Av. El Santo 1655, La Serena', lat: -29.9142, lon: -71.2582 },
            { super: 'Unimarc', local: 'Unimarc Coquimbo', dir: 'Av. Videla 318, Coquimbo', lat: -29.9610, lon: -71.3361 },

            // --- VALPARAÍSO Y VIÑA DEL MAR ---
            { super: 'Jumbo', local: 'Jumbo Viña del Mar', dir: '1 Norte 2901, Viña del Mar', lat: -33.0153, lon: -71.5478 },
            { super: 'Tottus', local: 'Tottus Marina Arauco', dir: 'Av. Libertad 1348, Viña del Mar', lat: -33.0084, lon: -71.5489 },
            { super: 'Lider', local: 'Lider 15 Norte', dir: 'Av. Benidorm 961, Viña del Mar', lat: -33.0088, lon: -71.5432 },
            { super: 'Lider', local: 'Lider Barón', dir: 'Av. Argentina 555, Valparaíso', lat: -33.0456, lon: -71.6012 },
            { super: 'Jumbo', local: 'Jumbo Valparaíso', dir: 'Av. Argentina 51, Valparaíso', lat: -33.0485, lon: -71.6041 },
            { super: 'Santa Isabel', local: 'Santa Isabel Quilpué', dir: 'Claudio Vicuña 815, Quilpué', lat: -33.0487, lon: -71.4422 },

            // --- SANTIAGO (Principales Hubs) ---
            { super: 'Jumbo', local: 'Jumbo Costanera', dir: 'Av. Andrés Bello 2425, Providencia', lat: -33.4172, lon: -70.6067 },
            { super: 'Jumbo', local: 'Jumbo Bilbao', dir: 'Av. Francisco Bilbao 4149, Las Condes', lat: -33.4287, lon: -70.5732 },
            { super: 'Jumbo', local: 'Jumbo Florida Center', dir: 'Av. Vicuña Mackenna 6100, La Florida', lat: -33.5187, lon: -70.6001 },
            { super: 'Jumbo', local: 'Jumbo Maipú', dir: 'Av. Américo Vespucio 1001, Maipú', lat: -33.4831, lon: -70.7513 },
            { super: 'Lider', local: 'Lider General Velásquez', dir: 'Av. General Velásquez 60, Estación Central', lat: -33.4561, lon: -70.6781 },
            { super: 'Lider', local: 'Lider Puente Alto', dir: 'Av. Concha y Toro 1149, Puente Alto', lat: -33.5821, lon: -70.5756 },
            { super: 'Lider', local: 'Lider La Reina', dir: 'Av. Ossa 721, La Reina', lat: -33.4478, lon: -70.5583 },
            { super: 'Lider', local: 'Lider Maipú', dir: 'Av. Pajaritos 1944, Maipú', lat: -33.4987, lon: -70.7554 },
            { super: 'Tottus', local: 'Tottus Nataniel', dir: 'Nataniel Cox 620, Santiago Centro', lat: -33.4489, lon: -70.6550 },
            { super: 'Tottus', local: 'Tottus Kennedy', dir: 'Av. Pdte. Kennedy Lateral 5500, Vitacura', lat: -33.4021, lon: -70.5768 },
            { super: 'Tottus', local: 'Tottus Plaza Vespucio', dir: 'Av. Vicuña Mackenna 7110, La Florida', lat: -33.5198, lon: -70.5982 },
            { super: 'Unimarc', local: 'Unimarc Providencia', dir: 'Av. Providencia 1333, Providencia', lat: -33.4281, lon: -70.6221 },
            { super: 'Unimarc', local: 'Unimarc Ñuñoa', dir: 'Av. Irarrázaval 3350, Ñuñoa', lat: -33.4561, lon: -70.5934 },
            { super: 'Santa Isabel', local: 'Santa Isabel Los Leones', dir: 'Av. Suecia 0118, Providencia', lat: -33.4243, lon: -70.6074 },
            { super: 'Santa Isabel', local: 'Santa Isabel Santiago Centro', dir: 'San Diego 134, Santiago', lat: -33.4472, lon: -70.6511 },

            // --- ZONA CENTRO Y MAULE ---
            { super: 'Jumbo', local: 'Jumbo Rancagua', dir: 'Carretera Ruta 5 Sur Km. 88, Rancagua', lat: -34.1701, lon: -70.7405 },
            { super: 'Lider', local: 'Lider Rancagua Express', dir: 'Av. Membrillar 50, Rancagua', lat: -34.1623, lon: -70.7389 },
            { super: 'Tottus', local: 'Tottus Rancagua', dir: 'Av. Kennedy 2900, Rancagua', lat: -34.1564, lon: -70.7251 },
            { super: 'Lider', local: 'Lider Curicó', dir: 'Av. Freire 185, Curicó', lat: -34.9832, lon: -71.2385 },
            { super: 'Jumbo', local: 'Jumbo Curicó', dir: 'Av. O\'Higgins 201, Curicó', lat: -34.9912, lon: -71.2290 },
            { super: 'Santa Isabel', local: 'Santa Isabel Centro', dir: 'Peña 745, Curicó', lat: -34.9855, lon: -71.2415 },
            { super: 'Unimarc', local: 'Unimarc Curicó', dir: 'Av. Camilo Henríquez, Curicó', lat: -34.9790, lon: -71.2440 },
            { super: 'Tottus', local: 'Tottus Curicó', dir: 'Av. Freire 70, Curicó', lat: -34.9839, lon: -71.2335 },
            { super: 'Jumbo', local: 'Jumbo Talca', dir: 'Calle 1 Norte 3240, Talca', lat: -35.4264, lon: -71.6554 },
            { super: 'Lider', local: 'Lider Talca Sur', dir: 'Av. Circunvalación Norte 1050, Talca', lat: -35.4192, lon: -71.6621 },
            { super: 'Santa Isabel', local: 'Santa Isabel Talca Centro', dir: '1 Sur 1830, Talca', lat: -35.4289, lon: -71.6689 },
            { super: 'Unimarc', local: 'Unimarc Talca', dir: '2 Sur 1150, Talca', lat: -35.4312, lon: -71.6582 },

            // --- ZONA SUR (Biobío a Magallanes) ---
            { super: 'Jumbo', local: 'Jumbo Chillán', dir: 'Longitudinal Sur 134, Chillán', lat: -36.5921, lon: -72.0911 },
            { super: 'Lider', local: 'Lider Chillán', dir: 'Collín 698, Chillán', lat: -36.6111, lon: -72.1022 },
            { super: 'Jumbo', local: 'Jumbo Concepción', dir: 'Av. Kennedy 2000, Concepción', lat: -36.8261, lon: -73.0498 },
            { super: 'Lider', local: 'Lider El Trébol', dir: 'Autopista Concepción Talcahuano 8900, Talcahuano', lat: -36.7845, lon: -73.0612 },
            { super: 'Tottus', local: 'Tottus El Trébol', dir: 'Av. Jorge Alessandri 3177, Talcahuano', lat: -36.7862, lon: -73.0594 },
            { super: 'Unimarc', local: 'Unimarc Concepción', dir: 'Barros Arana 931, Concepción', lat: -36.8275, lon: -73.0503 },
            { super: 'Jumbo', local: 'Jumbo Los Ángeles', dir: 'Ercilla 195, Los Ángeles', lat: -37.4645, lon: -72.3551 },
            { super: 'Lider', local: 'Lider Temuco', dir: 'Av. Prieto Norte 320, Temuco', lat: -38.7351, lon: -72.5971 },
            { super: 'Jumbo', local: 'Jumbo Los Pablos', dir: 'Av. Los Pablos 1990, Temuco', lat: -38.7495, lon: -72.6301 },
            { super: 'Unimarc', local: 'Unimarc Temuco Centro', dir: 'Manuel Montt 970, Temuco', lat: -38.7410, lon: -72.5898 },
            { super: 'Jumbo', local: 'Jumbo Valdivia', dir: 'Errázuriz 1040, Valdivia', lat: -39.8182, lon: -73.2384 },
            { super: 'Lider', local: 'Lider Valdivia', dir: 'Bueras 1400, Valdivia', lat: -39.8251, lon: -73.2355 },
            { super: 'Jumbo', local: 'Jumbo Osorno', dir: 'Av. César Ercilla 1300, Osorno', lat: -40.5752, lon: -73.1198 },
            { super: 'Jumbo', local: 'Jumbo Puerto Montt', dir: 'Illapel 10, Puerto Montt', lat: -41.4693, lon: -72.9351 },
            { super: 'Lider', local: 'Lider Puerto Montt', dir: 'Av. Parque Industrial 400, Puerto Montt', lat: -41.4582, lon: -72.9542 },
            { super: 'Unimarc', local: 'Unimarc Punta Arenas', dir: 'Bories 647, Punta Arenas', lat: -53.1610, lon: -70.9068 },
            { super: 'Lider', local: 'Lider Punta Arenas', dir: 'Av. Eduardo Frei Montalva 1110, Punta Arenas', lat: -53.1422, lon: -70.8931 }
        ];

        let insertados = 0;
        let existentes = 0;

        for (const s of sucursalesPais) {
            const supId = idsSuper[s.super];
            if (supId) {
                const [existe] = await pool.query(
                    "SELECT id FROM sucursales WHERE supermercado_id = ? AND LOWER(nombre_local) = LOWER(?)",
                    [supId, s.local]
                );

                if (existe.length === 0) {
                    await pool.query(
                        "INSERT INTO sucursales (supermercado_id, nombre_local, direccion, latitud, longitud) VALUES (?, ?, ?, ?, ?)",
                        [supId, s.local, s.dir, s.lat, s.lon]
                    );
                    insertados++;
                } else {
                    existentes++;
                }
            }
        }

        console.log(`\n🎉 ¡REGISTRO MASIVO COMPLETADO!`);
        console.log(`   - 🆕 Sucursales añadidas: ${insertados}`);
        console.log(`   - 📌 Sucursales que ya estaban registradas: ${existentes}`);
        process.exit(0);

    } catch (error) {
        console.error('❌ Error crítico en el registro masivo:', error.message);
        process.exit(1);
    }
}

registrarSucursalesMasivoNacional();