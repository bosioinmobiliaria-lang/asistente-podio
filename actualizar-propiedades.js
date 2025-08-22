// actualizar-propiedades.js (Versión Robusta)
const axios = require('axios');
const qs = require('querystring');
const fs = require('fs');
require('dotenv').config();

// --- CONFIGURACIÓN ---
const PROPIEDADES_APP_ID = process.env.PODIO_PROPIEDADES_APP_ID;
const PROPIEDADES_APP_TOKEN = process.env.PODIO_PROPIEDADES_APP_TOKEN;
const CLIENT_ID = process.env.PODIO_CLIENT_ID;
const CLIENT_SECRET = process.env.PODIO_CLIENT_SECRET;

const PROGRESS_FILE = 'progreso-propiedades.json';

// --- FUNCIONES DE AYUDA ---

async function getPodioToken() {
  console.log('Obteniendo token de autenticación...');
  try {
    const body = qs.stringify({
      grant_type: 'app',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      app_id: PROPIEDADES_APP_ID,
      app_token: PROPIEDADES_APP_TOKEN,
    });
    const { data } = await axios.post('https://podio.com/oauth/token', body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    console.log('Token obtenido con éxito.');
    return data.access_token;
  } catch (err) {
    console.error("ERROR GRAVE: No se pudo obtener el token de Podio. Revisa las variables .env y los permisos del token.");
    console.error(err.response ? err.response.data : err.message);
    process.exit(1);
  }
}

function leerProgreso() {
  if (fs.existsSync(PROGRESS_FILE)) {
    const data = fs.readFileSync(PROGRESS_FILE);
    return JSON.parse(data);
  }
  return { offset: 0, actualizados: 0, fallidos: 0 };
}

function guardarProgreso(offset, actualizados, fallidos) {
  const data = JSON.stringify({ offset, actualizados, fallidos });
  fs.writeFileSync(PROGRESS_FILE, data);
}

// --- LÓGICA PRINCIPAL ---

async function iniciarActualizacion() {
  const token = await getPodioToken();
  let { offset, actualizados, fallidos } = leerProgreso();
  
  console.log(`\n--- INICIANDO SINCRONIZACIÓN ---`);
  console.log(`Resumiendo desde la propiedad número: ${offset}`);

  try {
    while (true) {
      console.log(`\nBuscando lote de propiedades desde el offset ${offset}...`);
      const response = await axios.post(
        `https://api.podio.com/item/app/${PROPIEDADES_APP_ID}/filter/`,
        { limit: 100, offset: offset },
        { headers: { Authorization: `OAuth2 ${token}` } }
      );

      const items = response.data.items;
      if (items.length === 0) {
        console.log('\n¡Proceso completado!');
        console.log(`Total actualizados: ${actualizados}`);
        console.log(`Total fallidos: ${fallidos}`);
        break;
      }
      console.log(`Se encontraron ${items.length} propiedades. Procesando...`);

      for (const item of items) {
        const itemId = item.item_id;
        const fieldsToUpdate = {};

        const localidadField = item.fields.find(f => f.external_id === 'localiadad');
        if (localidadField && localidadField.values.length > 0) {
          fieldsToUpdate['localidad-texto-2'] = localidadField.values[0].value.text;
        }

        const linkField = item.fields.find(f => f.external_id === 'enlace-de-la-propiedad');
        if (linkField && linkField.values.length > 0 && linkField.values[0].embed) {
          fieldsToUpdate['enlace-texto-2'] = linkField.values[0].embed.url;
        }

        if (Object.keys(fieldsToUpdate).length > 0) {
          try {
            await axios.put(
              `https://api.podio.com/item/${itemId}`,
              { fields: fieldsToUpdate },
              { headers: { Authorization: `OAuth2 ${token}` } }
            );
            actualizados++;
            console.log(`(${offset + 1}) Propiedad #${itemId} actualizada con éxito.`);
          } catch (updateError) {
            fallidos++;
            console.error(`(${offset + 1}) ⚠️  ERROR al actualizar Propiedad #${itemId}. Saltando...`);
            console.error(`   Motivo: ${updateError.response ? updateError.response.data.error_description : updateError.message}`);
          }
        }
        
        offset++;
        guardarProgreso(offset, actualizados, fallidos);
      }
    }
  } catch (err) {
    // ... (manejo de rate limit y otros errores)
  }
}

iniciarActualizacion();
