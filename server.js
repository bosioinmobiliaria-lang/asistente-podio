// server.js
const express = require("express");
const axios = require("axios");
const qs = require("querystring");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----------------------------------------
// Helpers
// ----------------------------------------
function cleanDeep(obj) {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    const arr = obj.map(v => cleanDeep(v)).filter(v => v !== undefined && v !== null);
    return arr.length ? arr : undefined;
  }
  if (typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj)) {
      const v = cleanDeep(obj[k]);
      if (v !== undefined && v !== null) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return obj;
}

function splitDateTime(str) {
  if (typeof str !== "string") return null;
  const s = str.replace("T", " ").trim();
  const [date, time = "00:00:00"] = s.split(/\s+/);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { date, time };
}

function addHours(timeStr, hoursToAdd = 1) {
  const [H, M, S] = timeStr.split(":").map(x => parseInt(x, 10) || 0);
  const d = new Date(Date.UTC(2000, 0, 1, H, M, S));
  d.setUTCHours(d.getUTCHours() + hoursToAdd);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Construye objeto de fecha para Podio (single o rango) */
/** Construye objeto de fecha para Podio (solo fecha, sin hora) */
function buildPodioDateObject(input) {
  if (!input) return undefined;

  let startDate;

  if (input instanceof Date) {
    startDate = input.toISOString().substring(0, 10); // "AAAA-MM-DD"
  } else if (typeof input === "string") {
    const parts = splitDateTime(input);
    if (parts) {
      startDate = parts.date;
    }
  } else if (typeof input === "object" && input.start_date) {
    startDate = input.start_date;
  }

  if (!startDate) return undefined;

  // Devuelve solo la fecha de inicio, sin hora.
  return {
    start_date: startDate,
  };
}

// --- NUEVO AYUDANTE PARA CALCULAR DÍAS DESDE UNA FECHA ---
function calculateDaysSince(dateString) {
  if (!dateString) return 'N/A';
  try {
    const activityDate = new Date(dateString.replace(" ", "T") + "Z"); // Aseguramos formato ISO
    const today = new Date();
    
    // Diferencia en milisegundos
    const diffTime = Math.abs(today - activityDate);
    // Convertir a días
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'hoy';
    if (diffDays === 1) return 'hace 1 día';
    return `hace ${diffDays} días`;
  } catch (e) {
    console.error("Error al calcular días:", e);
    return 'N/A';
  }
}

// --- NUEVO AYUDANTE PARA FORMATEAR FECHAS DE PODIO ---
function formatPodioDate(dateString) {
  if (!dateString) return 'N/A';
  try {
    // La fecha de Podio viene en formato "AAAA-MM-DD HH:MM:SS" (UTC)
    const date = new Date(dateString + " UTC");
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0'); // Se suma 1 porque los meses empiezan en 0
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
  } catch (e) {
    return 'N/A';
  }
}

// ----------------------------------------
// Tokens por APP (grant_type=app)
// ----------------------------------------
const TOKENS = {
  contactos: { value: null, exp: 0 },
  leads: { value: null, exp: 0 },
  propiedades: { value: null, exp: 0 },
};

async function getAppAccessTokenFor(appName = "contactos") {
  const now = Date.now();
  if (TOKENS[appName].value && now < TOKENS[appName].exp - 30_000) {
    return TOKENS[appName].value;
  }
  const appId = appName === "leads" ? process.env.PODIO_LEADS_APP_ID : process.env.PODIO_CONTACTOS_APP_ID;
  const appToken = appName === "leads" ? process.env.PODIO_LEADS_APP_TOKEN : process.env.PODIO_CONTACTOS_APP_TOKEN;
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
      timeout: 30000 // Aumenta el tiempo de espera a 30 segundos
    });
    TOKENS[appName].value = data.access_token;
    TOKENS[appName].exp = Date.now() + (data.expires_in || 3600) * 1000;
    return TOKENS[appName].value;
  } catch (err) {
    console.error("TOKEN ERROR:", err.response?.status, err.response?.data || err.message);
    throw new Error("No se pudo obtener access_token de Podio");
  }
}

async function searchProperties(filters) {
  const appId = process.env.PODIO_PROPIEDADES_APP_ID;
  const token = await getAppAccessTokenFor("propiedades");

  // Filtro base: Siempre buscar solo las propiedades DISPONIBLES
  const podioFilters = {
    estado: [ ID_ESTADO_DISPONIBLE ]
  };

  // Agregamos los filtros que el usuario eligió
  if (filters.precio) {
    podioFilters['valor-de-la-propiedad'] = filters.precio;
  }
  if (filters.localidad) {
    podioFilters['localidad'] = [ filters.localidad ];
  }
  if (filters.tipo) {
    podioFilters['tipo-de-propiedad'] = [ filters.tipo ];
  }

  // ✅ "ESPÍA": Imprime en los logs de Render el filtro exacto que se envía a Podio
  console.log('--- FILTROS ENVIADOS A PODIO ---');
  console.log(JSON.stringify({ filters: podioFilters }, null, 2));
  console.log('---------------------------------');

  try {
    const response = await axios.post(
      `https://api.podio.com/item/app/${appId}/filter/`,
      {
        filters: podioFilters,
        limit: 5, // Traemos un máximo de 5 resultados para no saturar el chat
        sort_by: "created_on",
        sort_desc: true
      },
      { 
        headers: { Authorization: `OAuth2 ${token}` },
        timeout: 20000 
      }
    );
    return response.data.items;
  } catch (err) {
    console.error("Error al buscar propiedades en Podio:", err.response ? err.response.data : err.message);
    return [];
  }
}

async function createItemIn(appName, fields) {
  const appId = appName === "leads" ? process.env.PODIO_LEADS_APP_ID : process.env.PODIO_CONTACTOS_APP_ID;
  const token = await getAppAccessTokenFor(appName);
  const { data } = await axios.post(
    `https://api.podio.com/item/app/${appId}/`,
    { fields },
    { 
      headers: { Authorization: `OAuth2 ${token}` },
      timeout: 30000 // Aumenta el tiempo de espera a 30 segundos
    }
  );
  return data;
}

async function getAppMeta(appId, which = "contactos") {
  const token = await getAppAccessTokenFor(which);
  const { data } = await axios.get(`https://api.podio.com/app/${appId}`, {
    headers: { Authorization: `OAuth2 ${token}` },
  });
  return data;
}

async function getLeadsFieldsMeta() {
  const raw = await getAppMeta(process.env.PODIO_LEADS_APP_ID, "leads");
  return raw.fields || [];
}

// --- NUEVA FUNCIÓN DE BÚSQUEDA RÁPIDA EN LEADS ---
async function searchLeadByPhone(phoneNumber) {
  const appId = process.env.PODIO_LEADS_APP_ID;
  const token = await getAppAccessTokenFor("leads");
  
  try {
    const searchFieldExternalId = "telefono-busqueda"; 

    const response = await axios.post(
      `https://api.podio.com/item/app/${appId}/filter/`,
      {
        filters: {
          // ✅ SOLUCIÓN: Enviamos el número como texto simple, no como un objeto.
          [searchFieldExternalId]: phoneNumber
        }
      },
      { 
        headers: { Authorization: `OAuth2 ${token}` },
        timeout: 15000 
      }
    );
    return response.data.items;
  } catch (err) {
    console.error("Error al buscar lead en Podio:", err.response ? err.response.data : err.message);
    return [];
  }
}

// ----------------------------------------
// Contactos - meta & creación
// ----------------------------------------
app.get("/meta/fields", async (_req, res) => {
  try {
    const data = await getAppMeta(process.env.PODIO_CONTACTOS_APP_ID, "contactos");
    res.json({
      app: data.config?.name || "Contactos",
      fields: data.fields.map((f) => ({
        label: f.label,
        external_id: f.external_id,
        type: f.type,
        options: f.config?.settings?.options?.map((o) => ({ id: o.id, text: o.text })) || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message });
  }
});

app.post("/contactos", async (req, res) => {
  try {
    const {
      title, phone, email,
      tipo_de_contacto_option_id,
      origen_contacto_option_id,
      acompanante,
      telefono_acompanante,
      vendedor_asignado_option_id,
      fecha_creacion
    } = req.body;
    const fields = cleanDeep({
      title: title || "Contacto sin nombre",
      "tipo-de-contacto": tipo_de_contacto_option_id ? [tipo_de_contacto_option_id] : undefined,
      "contact-type": origen_contacto_option_id ? [origen_contacto_option_id] : undefined,
      "fecha-de-creacion": buildPodioDateObject(
        fecha_creacion || new Date().toISOString().slice(0, 19).replace("T", " "),
        false
      ),
      phone: phone ? [{ type: "mobile", value: phone }] : undefined,
      acompanante: acompanante || undefined,
      "telefono-del-acompanante": telefono_acompanante ? [{ type: "mobile", value: telefono_acompanante }] : undefined,
      "vendedor-asignado-2": vendedor_asignado_option_id ? [vendedor_asignado_option_id] : undefined,
      "email-2": email ? [{ type: "other", value: email }] : undefined,
    });
    const created = await createItemIn("contactos", fields);
    res.status(201).json({ ok: true, item_id: created.item_id, message: "Contacto creado en Podio" });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ ok: false, error: err?.response?.data || err.message });
  }
});

// ----------------------------------------
// Leads - meta
// ----------------------------------------
app.get("/meta/fields/leads", async (_req, res) => {
  try {
    const fields = await getLeadsFieldsMeta();
    const dateFields = fields
      .filter((f) => f.type === "date")
      .map((f) => ({
        label: f.label,
        external_id: f.external_id,
        required: !!f.config?.required,
        endMode: f.config?.settings?.end || "disabled",
        rangeEnabled: (f.config?.settings?.end || "disabled") !== "disabled",
      }));
    const chosen =
      process.env.PODIO_LEADS_DATE_EXTERNAL_ID ||
      (dateFields[0] ? dateFields[0].external_id : null);
    res.json({ app: "Leads", chosenDateExternalId: chosen, dateFields, fields });
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message });
  }
});

// ----------------------------------------
// Leads - creación
// ----------------------------------------
app.post("/leads", async (req, res) => {
  try {
    const {
      contacto_item_id,
      telefono,
      vendedor_option_id,
      lead_status_option_id,
      fecha,
      ubicacion,
      detalle,
      seguimiento,
      extras,
      force_range
    } = req.body;
    const meta = await getLeadsFieldsMeta();
    const dateFieldMeta = meta.find((f) => f.type === "date");
    const dateExternalId =
      process.env.PODIO_LEADS_DATE_EXTERNAL_ID ||
      (dateFieldMeta ? dateFieldMeta.external_id : null);
    const forceRangeFromEnv = String(process.env.PODIO_LEADS_FORCE_RANGE || "") === "1";
    const forceRangeFromReq =
      req.query.forceRange === "1" ||
      req.headers["x-force-range"] === "1" ||
      force_range === true;
    const apiSaysRange = (dateFieldMeta?.config?.settings?.end || "disabled") !== "disabled";
    const wantRange = forceRangeFromReq || forceRangeFromEnv || apiSaysRange;
    const fields = cleanDeep({
      "contacto-2": contacto_item_id ? [{ item_id: contacto_item_id }] : undefined,
      "telefono-2": telefono ? [{ type: "mobile", value: telefono }] : undefined,
      "vendedor-asignado-2": vendedor_option_id ? [vendedor_option_id] : undefined,
      "lead-status": lead_status_option_id ? [lead_status_option_id] : undefined,
      ubicacion: ubicacion || undefined,
      detalle: detalle || undefined,
      seguimiento: seguimiento || undefined,
      ...(extras && typeof extras === "object" ? extras : {}),
    });
    if (dateExternalId && fecha) {
      fields[dateExternalId] = buildPodioDateObject(fecha, wantRange);
    }
    const created = await createItemIn("leads", fields);
    res.status(201).json({ ok: true, item_id: created.item_id, message: "Lead creado en Podio" });
  } catch (err) {
    console.error("\n[LEADS ERROR] =>", err?.response?.data || err.message);
    res.status(500).json({ ok: false, error: err?.response?.data || err.message });
  }
});

// ----------------------------------------
// Debugs
// ----------------------------------------
app.post("/debug/leads/payload", async (req, res) => {
  try {
    const {
      contacto_item_id, telefono, vendedor_option_id, lead_status_option_id,
      fecha, ubicacion, detalle, seguimiento, extras, force_range
    } = req.body;
    const meta = await getLeadsFieldsMeta();
    const dateFieldMeta = meta.find((f) => f.type === "date");
    const dateExternalId =
      process.env.PODIO_LEADS_DATE_EXTERNAL_ID ||
      (dateFieldMeta ? dateFieldMeta.external_id : null);
    const forceRangeFromEnv = String(process.env.PODIO_LEADS_FORCE_RANGE || "") === "1";
    const forceRangeFromReq =
      req.query.forceRange === "1" ||
      req.headers["x-force-range"] === "1" ||
      force_range === true;
    const apiSaysRange = (dateFieldMeta?.config?.settings?.end || "disabled") !== "disabled";
    const wantRange = forceRangeFromReq || forceRangeFromEnv || apiSaysRange;
    const fields = cleanDeep({
      "contacto-2": contacto_item_id ? [{ item_id: contacto_item_id }] : undefined,
      "telefono-2": telefono ? [{ type: "mobile", value: telefono }] : undefined,
      "vendedor-asignado-2": vendedor_option_id ? [vendedor_option_id] : undefined,
      "lead-status": lead_status_option_id ? [lead_status_option_id] : undefined,
      ubicacion: ubicacion || undefined,
      detalle: detalle || undefined,
      seguimiento: seguimiento || undefined,
      ...(extras && typeof extras === "object" ? extras : {}),
    });
    if (dateExternalId && fecha) {
      fields[dateExternalId] = buildPodioDateObject(fecha, wantRange);
    }
    res.json({ wouldSend: { fields }, dateExternalId, wantRange });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.response?.data || err.message });
  }
});

app.get("/debug/env", (_req, res) => {
  res.json({
    PORT: process.env.PORT,
    PODIO_CLIENT_ID: process.env.PODIO_CLIENT_ID,
    PODIO_CONTACTOS_APP_ID: process.env.PODIO_CONTACTOS_APP_ID,
    PODIO_LEADS_APP_ID: process.env.PODIO_LEADS_APP_ID,
    PODIO_LEADS_FORCE_RANGE: process.env.PODIO_LEADS_FORCE_RANGE,
    PODIO_LEADS_DATE_EXTERNAL_ID: process.env.PODIO_LEADS_DATE_EXTERNAL_ID || "(auto)",
  });
});

app.get("/", (_req, res) =>
  res.send("OK • GET /meta/fields, POST /contactos, GET /meta/fields/leads, POST /leads, POST /debug/leads/payload, GET /debug/env")
);

// ----------------------------------------
// Webhook para WhatsApp (LÓGICA CONVERSACIONAL Y RÁPIDA v11.0)
// ----------------------------------------
const twilio = require("twilio");
const MessagingResponse = twilio.twiml.MessagingResponse;

const userStates = {}; // "Memoria" del bot

// --- Mapas para las opciones de Podio (sin cambios) ---
const VENDEDORES_LEADS_MAP = {
  'whatsapp:+5493571605532': 1,  // Diego Rodriguez
  'whatsapp:+5493546560311': 9,  // Esteban Bosio
  'whatsapp:+5493546490249': 2,  // Esteban Coll
  'whatsapp:+5493546549847': 3,  // Maximiliano Perez
  'whatsapp:+5493546452443': 10, // Gabriel Perez
  'whatsapp:+5493546545121': 7,  // Carlos Perez
  'whatsapp:+5493546513759': 8   // Santiago Bosio
};

// ✅ NUEVO: IDs para la App de CONTACTOS (extraídos de tu captura)
const VENDEDORES_CONTACTOS_MAP = {
  'whatsapp:+5493571605532': 1,  // Diego Rodriguez
  'whatsapp:+5493546560311': 8,  // Esteban Bosio
  'whatsapp:+5493546490249': 5,  // Esteban Coll
  'whatsapp:+5493546549847': 2,  // Maximiliano Perez
  'whatsapp:+5493546452443': 10, // Gabriel Perez
  'whatsapp:+5493546545121': 4,  // Carlos Perez
  'whatsapp:+5493546513759': 9   // Santiago Bosio
};
const VENDEDOR_POR_DEFECTO_ID = 8; // Usamos el ID de Esteban como default
const TIPO_CONTACTO_MAP = { '1': 1, '2': 2 }; 
const ORIGEN_CONTACTO_MAP = {
  '1': 6, '2': 1, '3': 2, '4': 8, '5': 7, '6': 3, '7': 5, '8': 9, '9': 11, '10': 10, '11': 12
};

const PRECIO_RANGOS_MAP = {
    '1': { from: 0, to: 10000 },
    '2': { from: 10000, to: 20000 },
    '3': { from: 20000, to: 40000 },
    '4': { from: 40000, to: 60000 },
    '5': { from: 80000, to: 90000 },
    '6': { from: 90000, to: 110000 },
    '7': { from: 110000, to: 150000 },
    '8': { from: 150000, to: 200000 },
    '9': { from: 200000, to: 300000 },
    '10': { from: 300000, to: 500000 },
    '11': { from: 500000, to: 99999999 },
};

// ✅ IDs REALES (extraídos de tus capturas)
const LOCALIDAD_MAP = {
    '1': 1, // Villa del Dique
    '2': 2, // Villa Rumipal
    '3': 3, // Santa Rosa
    '4': 4, // Amboy
    '5': 5, // San Ignacio
};

const TIPO_PROPIEDAD_MAP = {
    '1': 1, // Lote
    '2': 2, // Casa
    '3': 3, // Chalet
    '4': 4, // Departamento
    '5': 5, // PH
    '6': 6, // Galpon
    '7': 7, // Cabañas
    '8': 8, // Locales comerciales
};

// ✅ ID REAL (extraído de tus capturas)
const ID_ESTADO_DISPONIBLE = 1; // ID de la opción "Disponible" del campo "Estado"
// 

// ✅ TU NÚMERO PARA ACTIVAR EL MODO DE PRUEBA
const NUMERO_DE_PRUEBA = 'whatsapp:+5493546560311';

app.post("/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();
  let respuesta = "";

  try {
    const mensajeRecibido = (req.body.Body || "").trim();
    const numeroRemitente = req.body.From || "";
    let currentState = userStates[numeroRemitente];

    // ✅ PASO 1: Agregamos el "espía" para ver los números en el log de Render
    console.log(`--- COMPARANDO NÚMEROS ---`);
    console.log(`Número Recibido: [${numeroRemitente}]`);
    console.log(`Número de Prueba Esperado: [${NUMERO_DE_PRUEBA}]`);
    console.log(`¿Coinciden?: ${numeroRemitente === NUMERO_DE_PRUEBA}`);
    console.log(`--------------------------`);

    // --- LÓGICA DEL "PORTERO": Revisa si sos vos o un asesor ---
    if (numeroRemitente === NUMERO_DE_PRUEBA) {
    // ===============================================================
    // ===== MODO PRUEBA: FLUJO MEJORADO (v3) =======================
    // ===============================================================
    if (mensajeRecibido.toLowerCase() === 'cancelar' || mensajeRecibido.toLowerCase() === 'volver') {
        delete userStates[numeroRemitente];
        // Mandamos al menú principal del modo prueba
        respuesta = "Hola 👋, (MODO PRUEBA).\n\n*1.* Verificar Teléfono\n*2.* 🔎 Buscar una propiedad (NUEVO)\n\nEscribe *cancelar* para volver.";
    
    } else if (currentState) {
        switch (currentState.step) {
            case 'awaiting_property_type':
                const tipoId = TIPO_PROPIEDAD_MAP[mensajeRecibido];
                if (!tipoId) {
                    respuesta = "Opción no válida. Por favor, elegí un número de la lista o escribí 'volver'.";
                    break;
                }
                currentState.filters.tipo = tipoId;
                currentState.step = 'awaiting_filter_choice';
                respuesta = `Perfecto. ¿Cómo querés filtrar?\n\n*1.* Por Localidad\n*2.* Por Precio\n*3.* Volver al menú anterior`;
                break;

            case 'awaiting_filter_choice':
                const filterChoice = mensajeRecibido;
                if (filterChoice === '1') { // Localidad
                    currentState.step = 'awaiting_final_filter';
                    currentState.finalFilterType = 'localidad';
                    respuesta = `📍 Muy bien, elegí la localidad:\n\n*1.* Villa del Dique\n*2.* Villa Rumipal\n*3.* Santa Rosa\n*4.* Amboy\n*5.* San Ignacio`;
                } else if (filterChoice === '2') { // Precio
                    currentState.step = 'awaiting_final_filter';
                    currentState.finalFilterType = 'precio';
                    respuesta = `💰 Entendido, elegí un rango de precios (en USD):\n\n*1.* 0 - 10k\n*2.* 10k - 20k\n*3.* 20k - 40k\n*4.* 40k - 60k\n*5.* 80k - 90k\n*6.* 90k - 110k\n*7.* 110k - 150k\n*8.* 150k - 200k\n*9.* 200k - 300k\n*10.* 300k - 500k\n*11.* +500k`;
                } else {
                    respuesta = "Opción no válida. Por favor, elegí 1 o 2.";
                }
                break;

            case 'awaiting_final_filter':
                if (currentState.finalFilterType === 'localidad') {
                    const localidadId = LOCALIDAD_MAP[mensajeRecibido];
                    if (!localidadId) {
                        respuesta = "Opción no válida. Por favor, elegí un número de la lista de localidades.";
                        break;
                    }
                    currentState.filters.localidad = localidadId;
                } else { // precio
                    const precioRango = PRECIO_RANGOS_MAP[mensajeRecibido];
                    if (!precioRango) {
                        respuesta = "Opción no válida. Por favor, elegí un número de la lista de precios.";
                        break;
                    }
                    currentState.filters.precio = precioRango;
                }
                
                respuesta = "🔎 Buscando propiedades... un momento por favor.";
                const properties = await searchProperties(currentState.filters);
                
                if (properties.length > 0) {
                    let results = `✅ ¡Encontré ${properties.length} propiedades disponibles!\n\n`;
                    properties.forEach((prop, index) => {
                        const title = prop.title;
                        const linkField = prop.fields.find(f => f.external_id === 'enlace-de-la-propiedad');
                        const localidadField = prop.fields.find(f => f.external_id === 'localidad');

                        // ✅ MEJORA 1: Agregamos la localidad al texto
                        let localidadText = '';
                        if (localidadField && localidadField.values && localidadField.values[0]) {
                            localidadText = ` (${localidadField.values[0].value.text})`;
                        }
                        
                        // ✅ MEJORA 2: Espía potente para el enlace
                        let link = 'Sin enlace web';
                        if (linkField) {
                            console.log('--- ENCONTRADO CAMPO DE ENLACE ---');
                            console.log(JSON.stringify(linkField, null, 2));
                            console.log('---------------------------------');
                            if (linkField.values && linkField.values[0] && linkField.values[0].value && linkField.values[0].value.embed) {
                                link = linkField.values[0].value.embed.url;
                            }
                        }
                        
                        results += `*${index + 1}. ${title}${localidadText}*\n${link}\n\n`;
                    });
                    respuesta = results;
                } else {
                    respuesta = "Lo siento, no encontré propiedades disponibles que coincidan con tu búsqueda. 😔 Podés probar con otros filtros.";
                }
                delete userStates[numeroRemitente];
                break;
        }
    } else {
        const menuDePrueba = "Hola 👋, (MODO PRUEBA).\n\n*1.* Verificar Teléfono\n*2.* 🔎 Buscar una propiedad (NUEVO)\n\nEscribe *cancelar* para volver.";
        if (mensajeRecibido === '2') {
            userStates[numeroRemitente] = { step: 'awaiting_property_type', filters: {} };
            // ✅ MEJORA 3: Nuevo menú más completo
            respuesta = `🏡 Perfecto, empecemos. ¿Qué tipo de propiedad buscás?\n\n*1.* 🌳 Lote\n*2.* 🏠 Casa\n*3.* 🏡 Chalet\n*4.* 🏢 Departamento\n*5.* 🏘️ PH\n*6.* 🏭 Galpón\n*7.* 🛖 Cabañas\n*8.* 🏪 Locales comerciales\n\nEscribe *volver* para ir al menú anterior.`;
        } else {
            // Lógica del "Verificar Teléfono" iría aquí
            respuesta = menuDePrueba;
        }
    }
} else {
    // ... (El código de los asesores en el bloque ELSE se mantiene igual)
}
  } catch (err) {
    console.error("\n--- ERROR DETALLADO EN WEBHOOK ---");
    if (err.response) {
        console.error("Status Code:", err.response.status);
        console.error("Respuesta de Podio:", JSON.stringify(err.response.data, null, 2));
    } else {
        console.error("Error no relacionado con la API:", err.message);
        console.error(err.stack);
    }
    respuesta = "❌ Ocurrió un error inesperado. La operación ha sido cancelada. Por favor, informa al administrador.";
  }

  twiml.message(respuesta);
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});



// ----------------------------------------
// RED DE SEGURIDAD: Atrapa errores fatales
// ----------------------------------------
process.on('uncaughtException', (err, origin) => {
  console.error('!!!!!!!!!! ERROR FATAL DETECTADO !!!!!!!!!!!');
  console.error('Fecha:', new Date().toISOString());
  console.error('Error:', err.stack || err);
  console.error('Origen:', origin);
  process.exit(1); // Cierra el proceso después de registrar el error
});

// ----------------------------------------
// Iniciar el Servidor
// ----------------------------------------
app.listen(process.env.PORT, () => {
  console.log(`Servidor en http://localhost:${process.env.PORT}`);
  console.log(`[CFG] PODIO_LEADS_FORCE_RANGE=${process.env.PODIO_LEADS_FORCE_RANGE || "0"} | PODIO_LEADS_DATE_EXTERNAL_ID=${process.env.PODIO_LEADS_DATE_EXTERNAL_ID || "(auto)"}`);
});
