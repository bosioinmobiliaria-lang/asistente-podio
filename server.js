// server.js
const express = require("express");
const axios = require("axios");
const qs = require("querystring");
require("dotenv").config();
const FormData = require("form-data");

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

// --- Validación celular Argentina: 10 dígitos (sin 0 ni 15) ---
function isValidArMobile(digits) {
  return /^\d{10}$/.test(digits);
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

/** Construye objeto de fecha para Podio (solo fecha, sin hora) */
function buildPodioDateObject(input) {
  if (!input) return undefined;
  let startDate;

  if (input instanceof Date) {
    startDate = input.toISOString().substring(0, 10);
  } else if (typeof input === "string") {
    const parts = splitDateTime(input);
    if (parts) startDate = parts.date;
  } else if (typeof input === "object" && input.start_date) {
    startDate = input.start_date;
  }

  if (!startDate) return undefined;
  return { start_date: startDate };
}

// --- AYUDANTE PARA CALCULAR DÍAS DESDE UNA FECHA ---
function calculateDaysSince(dateString) {
  if (!dateString) return "N/A";
  try {
    const activityDate = new Date(dateString.replace(" ", "T") + "Z");
    const today = new Date();
    const diffTime = Math.abs(today - activityDate);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return "hoy";
    if (diffDays === 1) return "hace 1 día";
    return `hace ${diffDays} días`;
  } catch (e) {
    console.error("Error al calcular días:", e);
    return "N/A";
  }
}

// --- FORMATEO FECHAS PODIO → DD/MM/AAAA ---
function formatPodioDate(dateString) {
  if (!dateString) return "N/A";
  try {
    const date = new Date(dateString + " UTC");
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
  } catch {
    return "N/A";
  }
}

// --- Timestamp "AAAA-MM-DD HH:MM:SS" (hora local del server) ---
function nowStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

// --- Línea PLANA para guardar en "seguimiento": [fecha] contenido ---
function formatSeguimientoEntry(plainText) {
  const text = (plainText || "").toString().trim();
  return `[${nowStamp()}] ${text}`;
}

// --- Utilidades para mostrar solo "fecha: contenido" (sin HTML) ---
function stripHtml(s) {
  return (s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
function ddmmyyyyFromStamp(stamp) {
  const [d] = (stamp || "").split(" ");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || "")) return stamp || "";
  const [Y, M, D] = d.split("-");
  return `${D}/${M}/${Y}`;
}
// Devuelve "DD/MM/AAAA: contenido" del último bloque del campo seguimiento
function extractLastSeguimientoLine(wholeText) {
  const clean = stripHtml((wholeText || "").replace(/\r/g, ""));
  if (!clean) return "—";

  // Buscamos TODAS las líneas que empiezan con [AAAA-MM-DD HH:MM:SS]
  const lines = clean.split("\n").map(s => s.trim()).filter(Boolean);
  let lastStamp = null;
  let lastContent = null;

  for (const s of lines) {
    const m = s.match(/^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
    if (m) {
      lastStamp = m[1];
      lastContent = m[2].trim();
    }
  }

  if (!lastStamp) return "—";

  // Formato DD/MM/AAAA
  const fecha = ddmmyyyyFromStamp(lastStamp);

  // Limpiamos restos de etiquetas antiguas si aparecieran
  const contenido = (lastContent || "")
    .replace(/^Nueva conversación:?/i, "")
    .replace(/^Resumen conversación:?/i, "")
    .replace(/^\(Origen:[^)]+\)/i, "")
    .trim();

  return `${fecha}: ${contenido || "—"}`;
}

// --- Resultados de propiedades (WhatsApp) ---
function formatResults(properties, startIndex, batchSize = 5) {
  const batch = properties.slice(startIndex, startIndex + batchSize);
  let message = startIndex === 0 ? `✅ ¡Encontré ${properties.length} propiedades disponibles!\n\n` : "";

  batch.forEach((prop, index) => {
    const title = prop.title;
    const valorField = prop.fields.find(f => f.external_id === "valor-de-la-propiedad");
    const localidadField = prop.fields.find(f => f.external_id === "localidad-texto-2");
    const linkField = prop.fields.find(f => f.external_id === "enlace-texto-2");

    const valor = valorField ? `💰 Valor: *u$s ${parseInt(valorField.values[0].value).toLocaleString("es-AR")}*` : "Valor no especificado";
    const localidadLimpia = localidadField ? localidadField.values[0].value.replace(/<[^>]*>?/gm, "") : "No especificada";
    const localidad = `📍 Localidad: *${localidadLimpia}*`;

    let link = "Sin enlace web";
    if (linkField && linkField.values[0].value) {
      const match = linkField.values[0].value.match(/href=["'](https?:\/\/[^"']+)["']/);
      if (match && match[1]) link = match[1];
    }

    message += `*${startIndex + index + 1}. ${title}*\n${valor}\n${localidad}\n${link}`;
    if (index < batch.length - 1) message += "\n\n----------\n\n";
  });

  const hasMore = startIndex + batchSize < properties.length;
  return { message: message.trim(), hasMore };
}

// --- Utilidades Lead / Podio ---
async function getLeadDetails(itemId) {
  const token = await getAppAccessTokenFor("leads");
  try {
    const { data } = await axios.get(`https://api.podio.com/item/${itemId}`, {
      headers: { Authorization: `OAuth2 ${token}` },
      timeout: 20000,
    });
    return data;
  } catch (err) {
    console.error("Error getLeadDetails:", err.response?.data || err.message);
    return null;
  }
}

function getTextFieldValue(item, externalId) {
  const f = (item?.fields || []).find(x => x.external_id === externalId);
  if (!f || !f.values || !f.values.length) return "";
  return (f.values[0].value || "").toString();
}

/** Guarda en 'seguimiento' SOLO "[fecha] contenido" (sin etiquetas extra) */
async function appendToLeadSeguimiento(itemId, newLinePlain) {
  try {
    const token = await getAppAccessTokenFor("leads");

    // 1) Leer item para traer el valor anterior y el field_id
    const item = await getLeadDetails(itemId);
    const segField = item?.fields?.find(f => f.external_id === "seguimiento");
    if (!segField) return { ok: false, error: "Campo 'seguimiento' no encontrado" };

    const prev = (segField.values?.[0]?.value || "").toString();
    const entry = formatSeguimientoEntry(newLinePlain); // "[YYYY-MM-DD HH:MM:SS] contenido"
    const merged = prev ? `${prev}\n${entry}` : entry;

    // 2) INTENTO 1: por external_id (forma más simple)
    try {
      await axios.put(
        `https://api.podio.com/item/${itemId}/value/seguimiento`,
        [{ value: merged }],
        { headers: { Authorization: `OAuth2 ${token}` }, timeout: 20000 }
      );
      return { ok: true };
    } catch (e1) {
      // 3) INTENTO 2: por field_id (fallback)
      try {
        await axios.put(
          `https://api.podio.com/item/${itemId}/value/${segField.field_id}`,
          [{ value: merged }], // *** importante: sin "type"
          { headers: { Authorization: `OAuth2 ${token}` }, timeout: 20000 }
        );
        return { ok: true };
      } catch (e2) {
        console.error("PUT seguimiento falló:", e2.response?.data || e2.message);
        return { ok: false, error: e2.response?.data || e2.message };
      }
    }
  } catch (err) {
    console.error("appendToLeadSeguimiento error:", err.response?.data || err.message);
    return { ok: false, error: err.response?.data || err.message };
  }
}



/** Busca lead por teléfono o por item_id */
async function findLeadByPhoneOrId(inputStr) {
  const onlyDigits = (inputStr || "").replace(/\D/g, "");
  if (!onlyDigits) return { ok: false, reason: "empty" };

  // Intentar por teléfono primero
  if (onlyDigits.length >= 9) {
    const found = await searchLeadByPhone(onlyDigits);
    if (found?.length) return { ok: true, leadItem: found[0] };
  }
  // Intentar como item_id
  if (onlyDigits.length >= 6) {
    const item = await getLeadDetails(Number(onlyDigits));
    if (item?.item_id) return { ok: true, leadItem: item };
  }
  return { ok: false, reason: "not_found" };
}

// --- OpenAI resumen (fallback si no hay crédito) ---
async function summarizeWithOpenAI(text) {
  const raw = (text || "").toString().trim();
  if (!raw) return "";

  if (!process.env.OPENAI_API_KEY) return raw; // sin key → guardar plano
  try {
    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: "Resume en español la conversación del cliente inmobiliario en 1–3 oraciones claras y puntuales." },
          { role: "user", content: raw }
        ]
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, timeout: 60000 }
    );
    const out = (data.choices?.[0]?.message?.content || "").trim();
    return out || raw;
  } catch (err) {
    console.error("OpenAI summarize error:", err.response?.data || err.message);
    return raw; // fallback por cuota o error
  }
}

// --- Transcripción de audio WhatsApp (Adaptada para Meta) ---
async function transcribeAudioFromMeta(mediaId) {
  // TODO: Esta función requiere una implementación futura.
  // El proceso es: 1) Usar mediaId para obtener una media_url. 2) Descargar el audio de esa URL usando el Access Token. 3) Enviar el audio a OpenAI.
  console.log(`Función de transcripción para mediaId ${mediaId} no implementada.`);
  return { text: null, error: "not_implemented" };
}

/** Resumen compacto del Lead para WhatsApp (incluye último seguimiento limpio) */
function formatLeadInfoSummary(leadItem) {
  if (!leadItem) return "No encontré info del lead.";

  const nameField = (leadItem.fields || []).find(f => f.external_id === "contacto-2");
  const contacto = nameField ? nameField.values?.[0]?.value?.title : "Sin nombre";

  const assignedField = (leadItem.fields || []).find(f => f.external_id === "vendedor-asignado-2");
  const assignedTo = assignedField ? assignedField.values?.[0]?.value?.text : "No asignado";

  const estadoField = (leadItem.fields || []).find(f => f.external_id === "lead-status");
  const estado = estadoField ? estadoField.values?.[0]?.value?.text : "Sin estado";

  const ubicacion = getTextFieldValue(leadItem, "ubicacion");
  const detalle = getTextFieldValue(leadItem, "detalle");

  // Última línea limpia del campo seguimiento → "DD/MM/AAAA: contenido"
  const segField = (leadItem.fields || []).find(f => f.external_id === "seguimiento");
  const seguimientoUltimo = segField?.values?.[0]?.value
    ? extractLastSeguimientoLine(segField.values[0].value)
    : "—";

  const fechaCarga = formatPodioDate(leadItem.created_on);
  const lastAct = calculateDaysSince(leadItem.last_event_on);

  return [
    `👤 *Perfil*\n• Contacto: ${contacto}\n• Asesor: ${assignedTo}\n• Estado: ${estado}`,
    `🎯 *Interés*\n• Ubicación/zona: ${ubicacion || "—"}\n• Detalle: ${detalle || "—"}`,
    `🗂️ *Seguimiento (último)*\n${seguimientoUltimo}`,
    `⏱️ *Actividad*\n• Cargado: ${fechaCarga}\n• Última actividad: ${lastAct}`
  ].join("\n\n");
}


// ----------------------------------------
// Tokens por APP (grant_type=app)
// ----------------------------------------
const TOKENS = {
  contactos: { value: null, exp: 0 },
  leads: { value: null, exp: 0 },
  propiedades: { value: null, exp: 0 },
};

async function getItemDetails(itemId) {
  // Esta función obtiene todos los detalles de un item específico.
  const token = await getAppAccessTokenFor("propiedades");
  try {
    const { data } = await axios.get(`https://api.podio.com/item/${itemId}`, {
      headers: { Authorization: `OAuth2 ${token}` },
    });
    return data;
  } catch (err) {
    console.error(`Error al obtener detalles del item ${itemId}:`, err.response ? err.response.data : err.message);
    return null; // Devolvemos null si hay un error con un item específico
  }
}

async function getAppAccessTokenFor(appName = "contactos") {
  const now = Date.now();
  const slot = TOKENS[appName] || (TOKENS[appName] = { value: null, exp: 0 });

  if (slot.value && now < slot.exp - 30_000) {
    return slot.value;
  }

  // Mapeo correcto por app
  const creds = (() => {
    switch (appName) {
      case "leads":
        return {
          appId: process.env.PODIO_LEADS_APP_ID,
          appToken: process.env.PODIO_LEADS_APP_TOKEN,
        };
      case "propiedades":
        return {
          appId: process.env.PODIO_PROPIEDADES_APP_ID,
          appToken: process.env.PODIO_PROPIEDADES_APP_TOKEN,
        };
      default:
        return {
          appId: process.env.PODIO_CONTACTOS_APP_ID,
          appToken: process.env.PODIO_CONTACTOS_APP_TOKEN,
        };
    }
  })();

  if (!creds.appId || !creds.appToken) {
    throw new Error(`[Podio] Faltan credenciales de app para "${appName}"`);
  }

  const body = qs.stringify({
    grant_type: "app",
    client_id: process.env.PODIO_CLIENT_ID,
    client_secret: process.env.PODIO_CLIENT_SECRET,
    app_id: creds.appId,
    app_token: creds.appToken,
  });

  // Retry exponencial simple (maneja 503/no_response/timeouts/transient)
  const MAX_RETRIES = 3;
  const BASE_DELAY = 600; // ms

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { data } = await axios.post("https://podio.com/oauth/token", body, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 45000, // +tiempo
      });
      slot.value = data.access_token;
      slot.exp = Date.now() + (data.expires_in || 3600) * 1000;
      return slot.value;
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.error || err?.code;
      console.error("TOKEN ERROR:", status, err?.response?.data || err.message);

      const retriable =
        status === 503 ||
        code === "no_response" ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        err.message?.includes("timeout");

      if (!retriable || attempt === MAX_RETRIES) {
        throw new Error("No se pudo obtener access_token de Podio");
      }

      const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// 🚀 NUEVA FUNCIÓN PARA ENVIAR MENSAJES CON META (VERSIÓN COMPATIBLE)
async function sendMessage(to, messageData) {
    const API_VERSION = 'v19.0';
    const url = `https://graph.facebook.com/${API_VERSION}/${process.env.META_PHONE_NUMBER_ID}/messages`;
    
    // CAMBIO: Se construye el payload de una forma más tradicional para mayor compatibilidad.
    const basePayload = {
        messaging_product: "whatsapp",
        to: to
    };
    const payload = Object.assign(basePayload, messageData);

    console.log("Enviando mensaje a Meta:", JSON.stringify(payload, null, 2));

    // El resto de la función es idéntica
    try {
        await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log("Mensaje enviado con éxito.");
    } catch (error) {
        console.error("❌ Error al enviar mensaje:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    }
}

// === MENÚ PRINCIPAL (con header y footer) ===
async function sendMainMenu(to) {
  await sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      header: {                    // ← nuevo header
        type: "text",
        text: "🤖 Bosi — tu asistente personal"
      },
      body: {                      // ← copy más cálido
        text: "Hola, soy *Bosi* 👋 ¿qué te gustaría hacer?"
      },
      footer: {                    // ← pista mínima
        text: "Tip: escribí *cancelar* para volver al menú"
      },
      action: {
        buttons: [
          { type: "reply", reply: { id: "menu_verificar",  title: "✅ Verificar Lead" } },
          { type: "reply", reply: { id: "menu_buscar",     title: "🔎 Buscar Propiedad" } },
          { type: "reply", reply: { id: "menu_actualizar", title: "✏️ Actualizar Lead" } }
        ]
      }
    }
  });
}

async function sendMenuGeneral(to) { return sendMainMenu(to); }


// Lista de orígenes con emoji (≤ 24 chars por fila)
async function sendOriginList(to) {
  await sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "🧭 Elegí el *origen del contacto*:" },
      action: {
        button: "Elegir origen",
        sections: [{
          title: "Orígenes",
          rows: [
            { id: "origin_1",  title: "✅ Inmobiliaria" },
            { id: "origin_2",  title: "✅ Facebook (Pers.)" },
            { id: "origin_3",  title: "✅ Instagram (Pers.)" },
            { id: "origin_4",  title: "✅ Cartelería (Cel.Inm)" },
            { id: "origin_5",  title: "✅ Página Web" },
            { id: "origin_6",  title: "✅ 0810" },
            { id: "origin_7",  title: "✅ Referido" },
            { id: "origin_8",  title: "✅ Instagram (Inmob.)" },
            { id: "origin_9",  title: "✅ Publicador externo" },
            { id: "origin_10", title: "✅ Cliente Antiguo" }
          ]
        }]
      }
    }
  });
}

async function searchProperties(filters) {
  const appId = process.env.PODIO_PROPIEDADES_APP_ID;
  const token = await getAppAccessTokenFor("propiedades");

  const podioFilters = { estado: [ ID_ESTADO_DISPONIBLE ] };

  if (filters.precio) podioFilters['valor-de-la-propiedad'] = filters.precio;
  if (filters.localidad) podioFilters['localidad'] = [ filters.localidad ];
  if (filters.tipo) podioFilters['tipo-de-propiedad'] = [ filters.tipo ];

  console.log('--- FILTROS ENVIADOS A PODIO ---');
  console.log(JSON.stringify({ filters: podioFilters }, null, 2));
  console.log('---------------------------------');

  try {
    const response = await axios.post(
      `https://api.podio.com/item/app/${appId}/filter/`,
      {
        filters: podioFilters,
        limit: 20, // ✅ LÍMITE AUMENTADO A 20
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
  '1': 6,   // Inmobiliaria
  '2': 1,   // Facebook (Personal)
  '3': 9,   // Instagram (Personal)  (antes opción 8)
  '4': 2,   // Carteleria (Celu inmobiliaria)
  '5': 8,   // Pagina Web
  '6': 3,   // 0810
  '7': 5,   // Referido
  '8': 11,  // Instagram (Inmobiliaria) (antes opción 9)
  '9': 10,  // Publicador externo
  '10': 12  // Cliente Antiguo
};

const PRECIO_RANGOS_MAP = {
    '1': { from: 0, to: 10000 },
    '2': { from: 10000, to: 20000 },
    '3': { from: 20000, to: 40000 },
    '4': { from: 40000, to: 60000 },
    '5': { from: 60000, to: 80000 },
    '6': { from: 80000, to: 100000 },
    '7': { from: 100000, to: 130000 },
    '8': { from: 130000, to: 160000 },
    '9': { from: 160000, to: 200000 },
    '10': { from: 200000, to: 300000 },
    '11': { from: 300000, to: 500000 },
    '12': { from: 500000, to: 99999999 },
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

// ===============================================
// NUEVO WEBHOOK PARA WHATSAPP CLOUD API (META)
// ===============================================

// --- 1. Verificación del Webhook (GET) ---
app.get("/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token && mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
        console.log("✅ Webhook verificado con éxito.");
        res.status(200).send(challenge);
    } else {
        console.error("❌ Falló la verificación del webhook.");
        res.sendStatus(403);
    }
});

// --- 2. Recepción de Mensajes (POST) ---
app.post("/whatsapp", async (req, res) => {
    // CAMBIO 1: Respondemos a Meta inmediatamente para evitar timeouts.
    res.sendStatus(200);

    try {
        const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!message) return;

        const from = message.from;
        const numeroRemitente = `whatsapp:+${from}`;
        let currentState = userStates[numeroRemitente];

        // --- INICIO DEL BLOQUE CORREGIDO ---
        let userInput = '';
        let interactiveReplyId = null;

        if (message.type === 'text') {
            userInput = message.text.body.trim();
        } else if (message.type === 'interactive') {
            const interactive = message.interactive;
            if (interactive.type === 'button_reply') {
                interactiveReplyId = interactive.button_reply.id;
            } else if (interactive.type === 'list_reply') {
                // Lo dejamos preparado para futuros menús de lista
                interactiveReplyId = interactive.list_reply.id;
            }
        }
        
        const input = interactiveReplyId || userInput;

        // CAMBIO 3: La variable "respuesta" se elimina. Cada respuesta se envía directamente.
        // const twiml = new MessagingResponse();
        // let respuesta = "";

        // Menú general (para todos) - Ahora es una función para enviar el menú
        async function sendMenuGeneral() {
            const menuText = "Hola 👋.\n\n" +
                "*1.* ✅ Verificar Teléfono en Leads\n" +
                "*2.* 🔎 Buscar una propiedad\n" +
                "*3.* ✏️ Actualizar un LEADS\n\n" +
                "Escribe *cancelar* para volver.";
            await sendMessage(from, { type: 'text', text: { body: menuText } });
        }

        // Cancelar y volver al menú
            const low = (input || "").toLowerCase(); // ← evita crash si input es undefined
        if (low === "cancelar" || low === "volver") {
            delete userStates[numeroRemitente];
            await sendMainMenu(from);
        } else if (currentState) {
            // --------------------
            // Flujo con estado (LA LÓGICA INTERNA NO CAMBIA, SOLO EL ENVÍO)
            // --------------------
            switch (currentState.step) {

      case "awaiting_name_only": {
  const nombre = (input || "").trim();
  if (!nombre || nombre.length < 3) {
    await sendMessage(from, { type: 'text', text: { body: "🤏 Nombre muy corto. Probá de nuevo (Nombre y Apellido)." } });
    break;
  }
  currentState.data = currentState.data || {};
  currentState.data.title = nombre;

  // Pasamos a elegir tipo con botones
  currentState.step = "awaiting_contact_type";
  await sendMessage(from, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "👤 ¿Qué tipo de contacto es?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "type_buyer", title: "🛒 Comprador" } },
          { type: "reply", reply: { id: "type_owner", title: "🏠 Propietario" } }
        ]
      }
    }
  });
  break;
}

case "awaiting_contact_type": {
  let tipoId = null, tipoTexto = "";
  if (input === "type_buyer") { tipoId = TIPO_CONTACTO_MAP['1']; tipoTexto = "Comprador"; }
  if (input === "type_owner") { tipoId = TIPO_CONTACTO_MAP['2']; tipoTexto = "Propietario"; }

  if (!tipoId) {
    await sendMessage(from, { type: 'text', text: { body: "Elegí una opción 👆 o escribí *cancelar*." } });
    break;
  }

  currentState.data["tipo-de-contacto"] = [tipoId];

  const telefono = (currentState.data.phone?.[0]?.value) || "—";
  const nombre = currentState.data.title || "—";

  // Resumen corto + pasamos a origen (con LISTA interactiva)
  await sendMessage(from, { type: 'text', text: { body: `✅ Datos ok\n\n• Nombre: ${nombre}\n• Tel.: ${telefono}\n• Tipo: ${tipoTexto}` } });

  // Mostrar lista de orígenes
  currentState.step = "awaiting_origin";
  await sendOriginList(from);
  break;
}


                // ===== 1) Verificar teléfono en Leads =====
                case "awaiting_phone_to_check": {
    console.log("==> PASO 1: Entrando al flujo 'awaiting_phone_to_check'.");
    const phoneToCheck = input.replace(/\D/g, "");

    // 1. MEJORA DEL MENSAJE DE ERROR
        if (!isValidArMobile(phoneToCheck)) {
        await sendMessage(from, { type: 'text', text: { body: "😕 Número inválido. Envíalo de nuevo *sin 0 ni 15* (10 dígitos)." } });
        break;
      }

    console.log(`==> PASO 2: Buscando el teléfono: ${phoneToCheck} en Podio...`);
    const existingLeads = await searchLeadByPhone(phoneToCheck);
    console.log(`==> PASO 3: Búsqueda en Podio finalizada. Se encontraron ${existingLeads.length} leads.`);

    if (existingLeads.length > 0) {
        // --- SI ENCUENTRA EL LEAD ---
        console.log("==> PASO 4: Lead encontrado. Enviando resumen.");
        const lead = existingLeads[0];
        const leadTitleField = lead.fields.find(f => f.external_id === "contacto-2");
        const leadTitle = leadTitleField ? leadTitleField.values[0].value.title : "Sin nombre";
        const assignedField = lead.fields.find(f => f.external_id === "vendedor-asignado-2");
        const assignedTo = assignedField ? assignedField.values[0].value.text : "No asignado";
        const creationDate = formatPodioDate(lead.created_on);
        const lastActivityDays = calculateDaysSince(lead.last_event_on);
        const responseText = `✅ *Lead Encontrado*\n\n` +
            `*Contacto:* ${leadTitle}\n*Asesor:* ${assignedTo}\n*Fecha de Carga:* ${creationDate}\n*Última Actividad:* ${lastActivityDays}`;
        
        await sendMessage(from, { type: 'text', text: { body: responseText } });
        delete userStates[numeroRemitente];

    } else {
        // --- NO ENCUENTRA EL LEAD ---
        console.log("==> PASO 4: Lead no encontrado. Ofreciendo crear contacto.");
        currentState.step = "awaiting_creation_confirmation";
        currentState.data = {
            phone: [{ type: "mobile", value: phoneToCheck }],
            "telefono-busqueda": phoneToCheck,
        };
        await sendMessage(from, {
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: `⚠️ El número *${phoneToCheck}* no existe en Leads.\n\n¿Deseas crear un nuevo Contacto?` },
                action: {
                    buttons: [
                        { type: "reply", reply: { id: "confirm_create_yes", title: "Sí, crear ahora" } },
                        { type: "reply", reply: { id: "confirm_create_no", title: "No, cancelar" } }
                    ]
                }
            }
        });
    }
    console.log("==> PASO 5: Flujo 'awaiting_phone_to_check' completado.");
    break;
}

                case "awaiting_creation_confirmation": {
  if (input === "confirm_create_yes") {
    currentState.step = "awaiting_name_only";
    await sendMessage(from, { type: 'text', text: { body: "✍️ Decime *Nombre y Apellido*." } });
  } else if (input === "confirm_create_no" || low === "cancelar") {
    delete userStates[numeroRemitente];
    await sendMessage(from, { type: 'text', text: { body: "Operación cancelada. Volvemos al menú." } });
    await sendMainMenu(from);
  } else {
    await sendMessage(from, { type: 'text', text: { body: "Tocá un botón para continuar o escribí *cancelar*." } });
  }
  break;
}


                case "awaiting_name_and_type": {
                    const info = (input || "").split("\n").map(line => line.trim());
                    if (info.length < 2) {
                        await sendMessage(from, { type: 'text', text: { body: "❌ Faltan datos. Primera línea: Nombre. Segunda línea: Tipo (1 o 2)." } });
                        break;
                    }

                    const [nombre, tipoInputRaw] = info;
                    const tipoInput = (tipoInputRaw || "").trim();
                    const tipoId = TIPO_CONTACTO_MAP[tipoInput.charAt(0)];

                    if (!nombre || !tipoId) {
                        let errorMsg = "❌ Hay un error en los datos.\n";
                        if (!nombre) errorMsg += "El *Nombre* no puede estar vacío.\n";
                        if (!tipoId) errorMsg += "El *Tipo* debe ser 1 o 2.\n";
                        await sendMessage(from, { type: 'text', text: { body: errorMsg + "\nPor favor, intentá de nuevo." } });
                        break;
                    }

                    currentState.data.title = nombre;
                    currentState.data["tipo-de-contacto"] = [tipoId];

                    const telefono = currentState.data.phone[0].value;
                    const tipoTexto = tipoId === 1 ? "Comprador" : "Propietario";

                    const responseText = `✅ *Datos recibidos:*\n\n*Nombre:* ${nombre}\n*Teléfono:* ${telefono}\n*Tipo:* ${tipoTexto}\n\n` +
                        "🌎 Elegí el *origen del contacto*:\n\n" +
                        "*1.* Inmobiliaria\n*2.* Facebook\n*3.* Cartelería\n*4.* Página Web\n*5.* Showroom\n*6.* 0810\n*7.* Referido\n*8.* Instagram (Personal)\n*9.* Instagram (Inmobiliaria)\n*10.* Publicador externo\n*11.* Cliente antiguo";
                    await sendMessage(from, { type: 'text', text: { body: responseText } });
                    currentState.step = "awaiting_origin";
                    break;
                }

                case "awaiting_origin": {
  // Esperamos un list_reply con ids "origin_#"
  const m = /^origin_(\d+)$/.exec(input || "");
  if (!m) {
    await sendOriginList(from);
    break;
  }
  const key = m[1]; // "1" .. "11"
  const origenId = ORIGEN_CONTACTO_MAP[key];
  if (!origenId) {
    await sendOriginList(from);
    break;
  }

  currentState.data["contact-type"] = [origenId];
  const vendedorId = VENDEDORES_CONTACTOS_MAP[numeroRemitente] || VENDEDOR_POR_DEFECTO_ID;
  currentState.data["vendedor-asignado-2"] = [vendedorId];
  currentState.data["fecha-de-creacion"] = buildPodioDateObject(new Date());
  delete currentState.data["telefono-busqueda"];

  try {
    await createItemIn("contactos", currentState.data);
    await sendMessage(from, { type: 'text', text: { body: "🎉 Contacto creado y asignado." } });
  } catch (e) {
    await sendMessage(from, { type: 'text', text: { body: "⚠️ No pude crear el contacto. Probá más tarde." } });
  }
  delete userStates[numeroRemitente];
  break;
}

                
                // ... Y así sucesivamente para todos los demás `case` ...
                // Simplemente reemplaza `respuesta =` por `await sendMessage(from, { type: 'text', text: { body: ... } });`

                // ===== COPIA Y PEGA EL RESTO DE TUS `case` AQUÍ, REALIZANDO EL CAMBIO MENCIONADO =====

                // ------- fallback -------
                default: {
                    delete userStates[numeroRemitente];
                    await sendMenuGeneral();
                    break;
                }
            } // end switch con estado

        } else {
              // Sin estado: menú inicial
                  if (input === "menu_verificar") {
                    userStates[numeroRemitente] = { step: "awaiting_phone_to_check" };
                    const responseText = "✅ ¡Entendido! Enviame el número de celular que quieres consultar 📱";
                    await sendMessage(from, { type: 'text', text: { body: responseText } });
              } else if (input === "menu_buscar") {
                    userStates[numeroRemitente] = { step: "awaiting_property_type", filters: {} };
                    // Aquí irá el código para enviar el siguiente menú de botones (lo hacemos después)
                    await sendMessage(from, { type: 'text', text: { body: "Ok, empecemos a buscar una propiedad..." } }); 
              } else if (input === "menu_actualizar") { // <-- CAMBIO
                    userStates[numeroRemitente] = { step: "update_lead_start" };
                    await sendMessage(from, { type: 'text', text: { body: "🔧 *Actualizar LEAD*\nEnviame el *teléfono* (sin 0/15) o el *ID del item* de Podio del Lead que querés actualizar." } });
              } else {
                    await sendMainMenu(from); // <-- CAMBIO: Llama a la nueva función con botones
                }
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
        // Opcional: Notificar al usuario del error
        // const from = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
        // if (from) {
        //     await sendMessage(from, { type: 'text', text: { body: "❌ Ocurrió un error inesperado. La operación ha sido cancelada. Por favor, informa al administrador." } });
        // }
    }

    // CAMBIO 4: El final del método ya no envía respuesta TwiML.
    // twiml.message(respuesta);
    // res.writeHead(200, { "Content-Type": "text/xml" });
    // res.end(twiml.toString());
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
