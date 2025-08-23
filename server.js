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
const FormData = require("form-data"); // (si ya lo tenés arriba, podés borrarlo de acá)

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
  const clean = stripHtml(wholeText).replace(/\r/g, "");
  if (!clean) return "—";
  const parts = clean.split(/\n?-{3,}\n?/); // por si quedó separador histórico
  const last = parts[parts.length - 1].trim();
  const m = last.match(/\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]/);
  const stamp = m ? m[1] : null;
  let after = stamp ? last.slice(last.indexOf("]") + 1).trim() : last;
  after = after
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !/^Nueva conversación/i.test(s))
    .filter(s => !/^Resumen conversación/i.test(s))
    .filter(s => !/^\(Origen:/i.test(s))
    .filter(s => !/^Para descargar/i.test(s))[0] || "—";
  return stamp ? `${ddmmyyyyFromStamp(stamp)}: ${after}` : after;
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

    // Leer item para obtener field_id del campo 'seguimiento' y el valor actual
    const item = await getLeadDetails(itemId);
    const segField = item?.fields?.find(f => f.external_id === "seguimiento");
    if (!segField) return { ok: false, error: "Campo 'seguimiento' no encontrado" };

    const prev = segField.values?.[0]?.value || "";
    const entry = formatSeguimientoEntry(newLinePlain);
    const merged = prev ? `${prev}\n${entry}` : entry;

    // Actualizar SOLO ese field por field_id
    await axios.put(
      `https://api.podio.com/item/${itemId}/value/${segField.field_id}`,
      [{ type: "text", value: merged }],
      { headers: { Authorization: `OAuth2 ${token}` }, timeout: 20000 }
    );

    return { ok: true };
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

// --- Transcripción de audio WhatsApp (Twilio MediaUrl0) ---
async function transcribeAudioFromTwilioMediaUrl(mediaUrl) {
  if (!mediaUrl) return { text: null, error: "no_media_url" };
  try {
    const audioResp = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
      timeout: 60000,
    });

    if (!process.env.OPENAI_API_KEY) return { text: null, error: "no_openai_key" };

    const form = new FormData();
    form.append("file", Buffer.from(audioResp.data), { filename: "audio.ogg" });
    form.append("model", "whisper-1");
    form.append("language", "es");

    const { data } = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, timeout: 60000 }
    );

    return { text: (data.text || "").trim(), error: null };
  } catch (err) {
    const code = err?.response?.data?.error?.code || err?.code || "unknown";
    console.error("Transcripción falló:", err?.response?.data || err?.message);
    return { text: null, error: code };
  }
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

  // Seguimiento (última línea → "DD/MM/AAAA: contenido")
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
  '1': 6, '2': 1, '3': 2, '4': 8, '5': 7, '6': 3, '7': 5, '8': 9, '9': 11, '10': 10, '11': 12
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

// ==============================
// WhatsApp Webhook (menú único)
// ==============================
app.post("/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();
  let respuesta = "";

  try {
    const mensajeRecibido = (req.body.Body || "").trim();
    const numeroRemitente = req.body.From || "";
    let currentState = userStates[numeroRemitente];

    // Menu general (para todos)
    const menuGeneral =
      "Hola 👋.\n\n" +
      "*1.* ✅ Verificar Teléfono en Leads\n" +
      "*2.* 🔎 Buscar una propiedad\n" +
      "*3.* ✏️ Actualizar un LEADS\n\n" +
      "Escribe *cancelar* para volver.";

    // Cancelar y volver al menú
    if (["cancelar", "volver"].includes(mensajeRecibido.toLowerCase())) {
      delete userStates[numeroRemitente];
      respuesta = menuGeneral;

    } else if (currentState) {
      // --------------------
      // Flujo con estado
      // --------------------
      switch (currentState.step) {
        // ===== 1) Verificar teléfono en Leads =====
        case "awaiting_phone_to_check": {
          const phoneToCheck = mensajeRecibido.replace(/\D/g, "");
          if (phoneToCheck.length < 9) {
            respuesta = "El número parece muy corto. Enviá sin 0 y sin 15 (ej: 351... ó 3546...).";
            break;
          }

          const existingLeads = await searchLeadByPhone(phoneToCheck);

          if (existingLeads.length > 0) {
            const lead = existingLeads[0];
            const leadTitleField = lead.fields.find(f => f.external_id === "contacto-2");
            const leadTitle = leadTitleField ? leadTitleField.values[0].value.title : "Sin nombre";
            const assignedField = lead.fields.find(f => f.external_id === "vendedor-asignado-2");
            const assignedTo = assignedField ? assignedField.values[0].value.text : "No asignado";
            const creationDate = formatPodioDate(lead.created_on);
            const lastActivityDays = calculateDaysSince(lead.last_event_on);

            respuesta =
              `✅ *Lead Encontrado*\n\n` +
              `*Contacto:* ${leadTitle}\n*Asesor:* ${assignedTo}\n*Fecha de Carga:* ${creationDate}\n*Última Actividad:* ${lastActivityDays}`;
            delete userStates[numeroRemitente];
          } else {
            currentState.step = "awaiting_creation_confirmation";
            currentState.data = {
              phone: [{ type: "mobile", value: phoneToCheck }],
              "telefono-busqueda": phoneToCheck,
            };
            respuesta =
              `⚠️ El número *${phoneToCheck}* no existe en Leads.\n\n` +
              `¿Querés crear un nuevo *Contacto*?\n\n*1.* Sí, crear ahora\n*2.* No, cancelar`;
          }
          break;
        }

        case "awaiting_creation_confirmation": {
          if (mensajeRecibido === "1") {
            currentState.step = "awaiting_name_and_type";
            respuesta =
              "📝 Enviame estos datos, *cada uno en una nueva línea*:\n\n" +
              "*1.* Nombre y Apellido\n*2.* Tipo de Contacto\n(*1.* Comprador, *2.* Propietario)";
          } else {
            delete userStates[numeroRemitente];
            respuesta = "Ok, operación cancelada. Volviendo al menú principal.";
          }
          break;
        }

        case "awaiting_name_and_type": {
          const info = mensajeRecibido.split("\n").map(line => line.trim());
          if (info.length < 2) {
            respuesta = "❌ Faltan datos. Primera línea: Nombre. Segunda línea: Tipo (1 o 2).";
            break;
          }

          const [nombre, tipoInputRaw] = info;
          const tipoInput = (tipoInputRaw || "").trim();
          const tipoId = TIPO_CONTACTO_MAP[tipoInput.charAt(0)];

          if (!nombre || !tipoId) {
            let errorMsg = "❌ Hay un error en los datos.\n";
            if (!nombre) errorMsg += "El *Nombre* no puede estar vacío.\n";
            if (!tipoId) errorMsg += "El *Tipo* debe ser 1 o 2.\n";
            respuesta = errorMsg + "\nPor favor, intentá de nuevo.";
            break;
          }

          currentState.data.title = nombre;
          currentState.data["tipo-de-contacto"] = [tipoId];

          const telefono = currentState.data.phone[0].value;
          const tipoTexto = tipoId === 1 ? "Comprador" : "Propietario";

          respuesta =
            `✅ *Datos recibidos:*\n\n*Nombre:* ${nombre}\n*Teléfono:* ${telefono}\n*Tipo:* ${tipoTexto}\n\n` +
            "🌎 Elegí el *origen del contacto*:\n\n" +
            "*1.* Inmobiliaria\n*2.* Facebook\n*3.* Cartelería\n*4.* Página Web\n*5.* Showroom\n*6.* 0810\n*7.* Referido\n*8.* Instagram (Personal)\n*9.* Instagram (Inmobiliaria)\n*10.* Publicador externo\n*11.* Cliente antiguo";
          currentState.step = "awaiting_origin";
          break;
        }

        case "awaiting_origin": {
          const origenId = ORIGEN_CONTACTO_MAP[mensajeRecibido];
          if (!origenId) {
            respuesta = "Opción no válida. Respondé con uno de los números de la lista.";
            break;
          }

          currentState.data["contact-type"] = [origenId];
          const vendedorId = VENDEDORES_CONTACTOS_MAP[numeroRemitente] || VENDEDOR_POR_DEFECTO_ID;
          currentState.data["vendedor-asignado-2"] = [vendedorId];
          currentState.data["fecha-de-creacion"] = buildPodioDateObject(new Date());
          delete currentState.data["telefono-busqueda"];

          await createItemIn("contactos", currentState.data);

          respuesta = `✅ ¡Genial! Contacto *"${currentState.data.title}"* creado y asignado correctamente.`;
          delete userStates[numeroRemitente];
          break;
        }

        // ===== 2) Buscar propiedad =====
        case "awaiting_property_type": {
          const tipoId = TIPO_PROPIEDAD_MAP[mensajeRecibido];
          if (!tipoId) {
            respuesta = "Opción no válida. Por favor, elegí un número de la lista o escribí 'volver'.";
            break;
          }
          currentState.filters.tipo = tipoId;
          currentState.step = "awaiting_filter_choice";
          respuesta =
            "Perfecto. ¿Cómo querés filtrar?\n\n" +
            "*1.* 📍 Por Localidad\n*2.* 💰 Por Precio\n*3.* ↩️ Volver al menú anterior";
          break;
        }

        case "awaiting_filter_choice": {
          const filterChoice = mensajeRecibido;
          if (filterChoice === "1") {
            currentState.step = "awaiting_final_filter";
            currentState.finalFilterType = "localidad";
            respuesta =
              "📍 Muy bien, elegí la localidad:\n\n" +
              "*1.* Villa del Dique\n*2.* Villa Rumipal\n*3.* Santa Rosa\n*4.* Amboy\n*5.* San Ignacio";
          } else if (filterChoice === "2") {
            currentState.step = "awaiting_final_filter";
            currentState.finalFilterType = "precio";
            respuesta =
              "💰 Entendido, elegí un rango de precios (en USD):\n\n" +
              "*1.* 0 - 10k\n*2.* 10k - 20k\n*3.* 20k - 40k\n*4.* 40k - 60k\n*5.* 60k - 80k\n*6.* 80k - 100k\n" +
              "*7.* 100k - 130k\n*8.* 130k - 160k\n*9.* 160k - 200k\n*10.* 200k - 300k\n*11.* 300k - 500k\n*12.* +500k";
          } else {
            respuesta = "Opción no válida. Por favor, elegí 1 o 2.";
          }
          break;
        }

        case "awaiting_final_filter": {
          if (currentState.finalFilterType === "localidad") {
            const localidadId = LOCALIDAD_MAP[mensajeRecibido];
            if (!localidadId) { respuesta = "Opción no válida..."; break; }
            currentState.filters.localidad = localidadId;
          } else {
            const precioRango = PRECIO_RANGOS_MAP[mensajeRecibido];
            if (!precioRango) { respuesta = "Opción no válida..."; break; }
            currentState.filters.precio = precioRango;
          }

          respuesta = "🔎 Buscando propiedades...";
          const properties = await searchProperties(currentState.filters);

          if (properties.length > 0) {
            currentState.searchResults = properties;
            currentState.searchIndex = 0;

            const { message, hasMore } = formatResults(currentState.searchResults, currentState.searchIndex);
            respuesta = message;

            if (hasMore) {
              respuesta +=
                "\n\n🤔 ¿Qué querés hacer ahora?\n\n" +
                "*1.* 👉 Ver siguientes\n*2.* 🏁 Finalizar búsqueda\n*3.* 💵 Nueva búsqueda (otro valor)\n" +
                "*4.* 🗺️ Nueva búsqueda (otro filtro)\n*5.* 🏠 Volver al menú principal";
              currentState.step = "awaiting_more_results";
            } else {
              delete userStates[numeroRemitente];
            }
          } else {
            respuesta = "Lo siento, no encontré propiedades disponibles que coincidan con tu búsqueda. 😔";
            delete userStates[numeroRemitente];
          }
          break;
        }

        case "awaiting_more_results": {
          const moreChoice = mensajeRecibido;
          if (moreChoice === "1") {
            currentState.searchIndex += 5;
            const { message, hasMore } = formatResults(currentState.searchResults, currentState.searchIndex);
            respuesta = message;

            if (hasMore) {
              respuesta +=
                "\n\n🤔 ¿Qué querés hacer ahora?\n\n" +
                "*1.* 👉 Ver siguientes\n*2.* 🏁 Finalizar búsqueda\n*3.* 💵 Nueva búsqueda (otro valor)\n" +
                "*4.* 🗺️ Nueva búsqueda (otro filtro)\n*5.* 🏠 Volver al menú principal";
            } else {
              respuesta += "\n\nNo hay más propiedades para mostrar.";
              delete userStates[numeroRemitente];
            }
          } else if (moreChoice === "2") {
            respuesta = "Ok, búsqueda finalizada. ¡Éxitos! 👍";
            delete userStates[numeroRemitente];
          } else if (moreChoice === "3") {
            delete currentState.filters[currentState.finalFilterType];
            currentState.step = "awaiting_final_filter";
            if (currentState.finalFilterType === "localidad") {
              respuesta =
                "📍 Muy bien, elegí la nueva localidad:\n\n" +
                "*1.* Villa del Dique\n*2.* Villa Rumipal\n*3.* Santa Rosa\n*4.* Amboy\n*5.* San Ignacio";
            } else {
              respuesta =
                "💰 Entendido, elegí el nuevo rango de precios (en USD):\n\n" +
                "*1.* 0 - 10k\n*2.* 10k - 20k\n*3.* 20k - 40k\n*4.* 40k - 60k\n*5.* 60k - 80k\n*6.* 80k - 100k\n" +
                "*7.* 100k - 130k\n*8.* 130k - 160k\n*9.* 160k - 200k\n*10.* 200k - 300k\n*11.* 300k - 500k\n*12.* +500k";
            }
          } else if (moreChoice === "4") {
            delete currentState.filters.precio;
            delete currentState.filters.localidad;
            currentState.step = "awaiting_filter_choice";
            respuesta =
              "Perfecto. ¿Cómo querés filtrar ahora?\n\n" +
              "*1.* 📍 Por Localidad\n*2.* 💰 Por Precio\n*3.* ↩️ Volver al menú anterior";
          } else if (moreChoice === "5") {
            delete userStates[numeroRemitente];
            respuesta = menuGeneral;
          } else {
            respuesta = "Opción no válida. Por favor, elegí un número del 1 al 5.";
          }
          break;
        }

        // ===== 3) Actualizar LEAD =====
        case "update_lead_start": {
          const key = mensajeRecibido.trim();
          const found = await findLeadByPhoneOrId(key);

          if (!found.ok) {
            respuesta = "❌ No encontré el Lead. Probá con *otro teléfono* (sin 0/15) o *ID*.";
            break;
          }

          const leadItem = found.leadItem.item_id
            ? found.leadItem
            : await getLeadDetails(found.leadItem.item_id || found.leadItem);

          if (!leadItem?.item_id) {
            respuesta = "❌ No pude abrir el Lead. Probá de nuevo.";
            break;
          }

          currentState.step = "update_lead_choice";
          currentState.leadItemId = leadItem.item_id;
          currentState.leadCache = leadItem;

          respuesta =
            `✅ LEAD seleccionado (#${leadItem.item_id}). ¿Qué querés hacer?\n\n` +
            "*a.* 📄 Info del Lead (resumen)\n*b.* 🗣️ Nueva conversación (texto o audio)\n*c.* 📅 Agendar visita (próximamente)\n\n" +
            "Escribí *a*, *b* o *c*.";
          break;
        }

        case "update_lead_choice": {
          const opt = mensajeRecibido.toLowerCase();

          if (opt === "a") {
            const item = currentState.leadCache || (await getLeadDetails(currentState.leadItemId));
            respuesta = formatLeadInfoSummary(item) + `\n\n¿Querés hacer otra acción? (*a*/*b* o *cancelar*)`;
            break;
          }

          if (opt === "b") {
            currentState.step = "awaiting_update_lead_content";
            respuesta =
              "🗣️ Enviame *el texto* de la conversación o *un audio de WhatsApp*.\n" +
              "Lo resumimos y lo guardamos en *seguimiento* del Lead.";
            break;
          }

          if (opt === "c") {
            respuesta = "🛠️ *Agendar visita* lo activamos más adelante. Por ahora usá *a* o *b*.";
            break;
          }

          respuesta = "Opción no válida. Escribí *a*, *b* o *c* (o *cancelar*).";
          break;
        }

        case "awaiting_update_lead_content": {
          const itemId = currentState.leadItemId;

          const numMedia = parseInt(req.body.NumMedia || "0", 10);
          const mediaType0 = (req.body.MediaContentType0 || "").toLowerCase().split(";")[0]; // ej: audio/ogg;codecs=opus
          const mediaUrl0 = req.body.MediaUrl0 || "";

          let transcriptRes = null;
          let origin = "texto";
          let rawText = (req.body.Body || "").trim();

          // ¿Vino audio?
          if (numMedia > 0 && mediaType0.startsWith("audio/")) {
            transcriptRes = await transcribeAudioFromTwilioMediaUrl(mediaUrl0);
            origin = transcriptRes?.text ? "audio" : "audio (no transcrito)";
          }

          const baseText = (transcriptRes && transcriptRes.text) ? transcriptRes.text : rawText;

          if (!baseText) {
            // Sin texto y sin transcripción ⇒ igual registramos el audio con link
            const entry = formatSeguimientoEntry(mediaUrl0);
            const appended = await appendToLeadSeguimiento(itemId, entry);


            if (appended.ok) {
              respuesta = "✅ Audio guardado en *seguimiento* (sin transcripción por límite de cuota). ¿Algo más? (*a*/*b* o *cancelar*)";
              currentState.step = "update_lead_choice";
            } else {
              respuesta = "❌ No pude guardar el audio. Avisá al admin.";
              delete userStates[numeroRemitente];
            }
            break;
          }

          // Tenemos texto (nota de voz transcrita o texto escrito)
          const summary = await summarizeWithOpenAI(baseText);
          const extraLink = (transcriptRes && !transcriptRes.text && mediaUrl0) ? `\n\n[Audio WhatsApp] ${mediaUrl0}` : "";

          const entry = formatSeguimientoEntry(summary + (extraLink ? ` ${extraLink}` : ""));
          const appended = await appendToLeadSeguimiento(itemId, entry);


          if (appended.ok) {
            respuesta = "✅ Conversación registrada en *seguimiento* del Lead. ¿Algo más? (*a*/*b* o *cancelar*)";
            currentState.step = "update_lead_choice";
          } else {
            respuesta = "❌ No pude guardar el seguimiento. Avisá al admin.";
            delete userStates[numeroRemitente];
          }
          break;
        }

        // ------- fallback -------
        default: {
          delete userStates[numeroRemitente];
          respuesta = menuGeneral;
          break;
        }
      } // end switch con estado

    } else {
      // --------------------
      // Sin estado: menú inicial
      // --------------------
      if (mensajeRecibido === "1") {
        userStates[numeroRemitente] = { step: "awaiting_phone_to_check" };
        respuesta = "Entendido. Enviame el *número de celular* que querés verificar (sin 0 ni 15, ej: 351..., 3546...).";
      } else if (mensajeRecibido === "2") {
        userStates[numeroRemitente] = { step: "awaiting_property_type", filters: {} };
        respuesta =
          "🏡 Perfecto, empecemos. ¿Qué tipo de propiedad buscás?\n\n" +
          "*1.* 🌳 Lote\n*2.* 🏠 Casa\n*3.* 🏡 Chalet\n*4.* 🏢 Departamento\n*5.* 🏘️ PH\n*6.* 🏭 Galpón\n*7.* 🛖 Cabañas\n*8.* 🏪 Locales comerciales\n\n" +
          "Escribe *volver* para ir al menú anterior.";
      } else if (mensajeRecibido === "3") {
        userStates[numeroRemitente] = { step: "update_lead_start" };
        respuesta = "🔧 *Actualizar LEAD*\nEnviame el *teléfono* (sin 0/15) o el *ID del item* de Podio del Lead que querés actualizar.";
      } else {
        respuesta = menuGeneral;
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
