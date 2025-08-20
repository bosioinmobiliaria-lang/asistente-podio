// actualizar-telefonos.js
const axios = require("axios");
const qs =require("querystring");
require("dotenv").config();

// --- Copiamos las funciones de ayuda que necesitamos de server.js ---
const TOKENS = { leads: { value: null, exp: 0 } };

async function getAppAccessTokenFor(appName = "leads") {
  const now = Date.now();
  if (TOKENS[appName].value && now < TOKENS[appName].exp - 30_000) {
    return TOKENS[appName].value;
  }
  const appId = process.env.PODIO_LEADS_APP_ID;
  const appToken = process.env.PODIO_LEADS_APP_TOKEN;
  const body = qs.stringify({
    grant_type: "app",
    client_id: process.env.PODIO_CLIENT_ID,
    client_secret: process.env.PODIO_CLIENT_SECRET,
    app_id: appId,
    app_token: appToken,
  });
  try {
    const { data } = await axios.post("https://podio.com/oauth/token", body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    TOKENS[appName].value = data.access_token;
    TOKENS[appName].exp = Date.now() + (data.expires_in || 3600) * 1000;
    return TOKENS[appName].value;
  } catch (err) {
    throw new Error("No se pudo obtener access_token de Podio");
  }
}

async function updateItem(itemId, fields) {
    const token = await getAppAccessTokenFor("leads");
    await axios.put(
        `https://api.podio.com/item/${itemId}`,
        { fields },
        { headers: { Authorization: `OAuth2 ${token}` } }
    );
}

// --- LÓGICA PRINCIPAL DEL SCRIPT ---
async function runUpdate() {
  console.log("Iniciando actualización de teléfonos en Podio...");
  const appId = process.env.PODIO_LEADS_APP_ID;
  const token = await getAppAccessTokenFor("leads");
  let offset = 0;
  const limit = 500;
  let updatedCount = 0;
  let totalProcessed = 0;

  try {
    while (true) {
      console.log(`Procesando lote de leads desde el item ${offset}...`);
      const response = await axios.post(
        `https://api.podio.com/item/app/${appId}/filter/`,
        { limit, offset },
        { headers: { Authorization: `OAuth2 ${token}` } }
      );

      const leads = response.data.items;
      if (leads.length === 0) {
        console.log("No hay más leads para procesar.");
        break;
      }

      for (const lead of leads) {
        totalProcessed++;
        const phoneField = lead.fields.find(f => f.external_id === 'telefono-2');
        const searchPhoneField = lead.fields.find(f => f.external_id === 'telefono-busqueda');
        
        if (phoneField && phoneField.values.length > 0) {
          const mainPhoneNumber = (phoneField.values[0].value || '').replace(/\D/g, '');
          const searchPhoneNumber = searchPhoneField ? (searchPhoneField.values[0].value || '') : '';

          if (mainPhoneNumber && mainPhoneNumber !== searchPhoneNumber) {
            console.log(`Actualizando Lead ID ${lead.item_id}: ${mainPhoneNumber}`);
            await updateItem(lead.item_id, {
              "telefono-busqueda": mainPhoneNumber
            });
            updatedCount++;
          }
        }
      }
      offset += leads.length;
    }
    console.log("\n--- ¡Actualización Completa! ---");
    console.log(`Total de leads procesados: ${totalProcessed}`);
    console.log(`Total de leads actualizados: ${updatedCount}`);

  } catch (err) {
    console.error("\n--- ERROR DURANTE LA ACTUALIZACIÓN ---");
    console.error(err.response ? err.response.data : err.message);
  }
}

runUpdate();
