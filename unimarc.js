const fs = require("fs");

const query = `
[out:json][timeout:180];
area["ISO3166-1"="CL"]->.cl;
(
  nwr["shop"~"supermarket|department_store|convenience"]["name"~"Unimarc|Lider|Líder|Santa Isabel|Jumbo|Tottus",i](area.cl);
  nwr["shop"~"supermarket|department_store|convenience"]["brand"~"Unimarc|Lider|Líder|Santa Isabel|Jumbo|Tottus",i](area.cl);
);
out center tags;
`;

// nombre exacto como está en tu tabla "supermercados"
const CADENAS = [
  { nombre: "Santa Isabel", clave: "santa isabel" },
  { nombre: "Unimarc", clave: "unimarc" },
  { nombre: "Tottus", clave: "tottus" },
  { nombre: "Jumbo", clave: "jumbo" },
  { nombre: "Lider", clave: "lider" },
];

const esc = (s) => (s || "").replace(/'/g, "''");
const normalizar = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

async function main() {
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "User-Agent": "backend-precios/1.0 (proyecto personal)",
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Error ${res.status}`);
  const { elements } = await res.json();

  const vistos = new Set();
  const conteo = {};
  const filas = [];

  for (const e of elements) {
    const llave = `${e.type}/${e.id}`;
    if (vistos.has(llave)) continue;
    vistos.add(llave);

    const t = e.tags || {};
    const texto = normalizar(`${t.name || ""} ${t.brand || ""}`);
    const cadena = CADENAS.find((c) => texto.includes(c.clave));
    if (!cadena) continue;

    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat == null || lon == null) continue;

    const calle = `${t["addr:street"] || ""} ${t["addr:housenumber"] || ""}`.trim();
    const direccion = [calle, t["addr:city"]].filter(Boolean).join(", ");

    conteo[cadena.nombre] = (conteo[cadena.nombre] || 0) + 1;
    filas.push(
      `((SELECT id FROM supermercados WHERE nombre = '${esc(cadena.nombre)}' LIMIT 1), ` +
        `'${esc(t.name || cadena.nombre)}', '${esc(direccion)}', ${lat}, ${lon})`
    );
  }

  const sql =
    "INSERT INTO sucursales (supermercado_id, nombre_local, direccion, latitud, longitud) VALUES\n" +
    filas.join(",\n") +
    ";";

  fs.writeFileSync("sucursales.sql", sql, "utf8");
  console.log(conteo);
  console.log(`${filas.length} locales guardados en sucursales.sql`);
}

main().catch(console.error);