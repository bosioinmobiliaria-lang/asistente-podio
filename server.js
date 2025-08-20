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
    // Usamos el external_id de tu nuevo campo de Texto: "telefono-busqueda"
    const searchFieldExternalId = "telefono-busqueda"; 

    const response = await axios.post(
      `https://api.podio.com/item/app/${appId}/filter/`,
      {
        // Los campos de texto se buscan con un rango "desde" y "hasta"
        filters: {
          [searchFieldExternalId]: { "from": phoneNumber, "to": phoneNumber }
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
// Webhook para WhatsApp (LÓGICA CONVERSACIONAL Y RÁPIDA v10.0)
// ----------------------------------------
const twilio = require("twilio");
const MessagingResponse = twilio.twiml.MessagingResponse;

const userStates = {}; // "Memoria" del bot

// --- Mapas para las opciones de Podio (estos ya los tenías bien) ---
const VENDEDORES_MAP = {
  'whatsapp:+5493571605532': 1,  // Diego Rodriguez
  'whatsapp:+5493546560311': 9,  // Esteban Bosio
  'whatsapp:+5493546490249': 2,  // Esteban Coll
  'whatsapp:+5493546549847': 3,  // Maximiliano Perez
  'whatsapp:+5493546452443': 10, // Gabriel Perez
  'whatsapp:+5493546545121': 7,  // Carlos Perez
  'whatsapp:+5493546513759': 8   // Santiago Bosio
};
const VENDEDOR_POR_DEFECTO_ID = 1;

const TIPO_CONTACTO_MAP = { '1': 1, '2': 2 }; // 1: Comprador, 2: Propietario
const ORIGEN_CONTACTO_MAP = {
  '1': 6, '2': 1, '3': 2, '4': 8, '5': 7, '6': 3, '7': 5, '8': 9, '9': 11, '10': 10, '11': 12
};
// --- Fin de los Mapas ---

app.post("/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();
  let respuesta = "";

  try {
    const mensajeRecibido = (req.body.Body || "").trim();
    const numeroRemitente = req.body.From || "";
    let currentState = userStates[numeroRemitente];

    // Comando universal para cancelar y volver al inicio
    if (mensajeRecibido.toLowerCase() === 'cancelar') {
      delete userStates[numeroRemitente];
      respuesta = "Operación cancelada. Volviendo al menú principal. 👋";
    
    } else if (currentState) {
      // --- FLUJO ACTIVO: El usuario ya está en una conversación ---
      switch (currentState.step) {

        case 'awaiting_phone_to_check':
          const phoneToCheck = mensajeRecibido.replace(/\D/g, ''); // Limpia todo lo que no sea dígito

          if (phoneToCheck.length < 9) {
            respuesta = "El número parece muy corto. Por favor, envíalo sin el 0 y sin el 15 (ej: 351... ó 3546...).";
            break;
          }
          
          const existingLeads = await searchLeadByPhone(phoneToCheck);

          if (existingLeads.length > 0) {
            // -- CASO A: EL LEAD EXISTE --
            const lead = existingLeads[0];
            const leadTitleField = lead.fields.find(f => f.external_id === 'contacto-2');
            const leadTitle = leadTitleField ? leadTitleField.values[0].value.title : 'Sin nombre';
            const assignedField = lead.fields.find(f => f.external_id === 'vendedor-asignado-2');
            const assignedTo = assignedField ? assignedField.values[0].value.text : 'No asignado';
            const creationDate = formatPodioDate(lead.created_on);
            const lastActivityDays = calculateDaysSince(lead.last_event_on);
            
            respuesta = `✅ **Lead Encontrado**\n\n*Contacto:* ${leadTitle}\n*Asesor:* ${assignedTo}\n*Fecha de Carga:* ${creationDate}\n*Última Actividad:* ${lastActivityDays}`;
            delete userStates[numeroRemitente]; // Finaliza la conversación

          } else {
            // -- CASO B: EL LEAD NO EXISTE --
            currentState.step = 'awaiting_contact_info';
            currentState.data = {
                phone: [{ type: "mobile", value: phoneToCheck }],
                "telefono-busqueda": phoneToCheck // Guardamos el teléfono para el campo de búsqueda también
            };
            respuesta = `El número *${phoneToCheck}* no existe en Leads.\n\nPara cargarlo como un nuevo **Contacto**, por favor, envíame los siguientes datos, **cada uno en una línea separada**:\n\n*Nombre y Apellido*\n*Tipo (1: Comprador, 2: Propietario)*\n*Origen (un número del 1 al 11)*`;
          }
          break;

        case 'awaiting_contact_info':
          const info = mensajeRecibido.split('\n').map(line => line.trim());
          
          if (info.length < 3) {
            respuesta = "❌ Faltan datos. Recordá enviarme el nombre, el tipo y el origen, cada uno en una nueva línea.";
            break;
          }

          const [nombre, tipoInput, origenInput] = info;
          const tipoId = TIPO_CONTACTO_MAP[tipoInput];
          const origenId = ORIGEN_CONTACTO_MAP[origenInput];

          if (!nombre || !tipoId || !origenId) {
            let errorMsg = "❌ Hay un error en los datos.\n";
            if (!nombre) errorMsg += "El *Nombre* no puede estar vacío.\n";
            if (!tipoId) errorMsg += "El *Tipo* debe ser 1 o 2.\n";
            if (!origenId) errorMsg += "El *Origen* debe ser un número del 1 al 11.\n";
            respuesta = errorMsg + "\nPor favor, intentá de nuevo.";
            break;
          }

          // Si todos los datos son válidos, creamos el contacto en Podio
          currentState.data.title = nombre;
          currentState.data['tipo-de-contacto'] = [tipoId];
          currentState.data['contact-type'] = [origenId];
          
          const vendedorId = VENDEDORES_MAP[numeroRemitente] || VENDEDOR_POR_DEFECTO_ID;
          currentState.data['vendedor-asignado-2'] = [vendedorId];
          currentState.data['fecha-de-creacion'] = buildPodioDateObject(new Date());

          await createItemIn("contactos", currentState.data);

          respuesta = `✅ ¡Perfecto! El contacto *"${currentState.data.title}"* fue creado en la app de **Contactos** y asignado correctamente.`;
          delete userStates[numeroRemitente]; // Finaliza la conversación
          break;
      }
    } else {
      // --- MENÚ PRINCIPAL: Aquí comienza la interacción ---
      const menu = "Hola 👋, soy tu asistente de Podio. ¿Qué quieres hacer?\n\n" +
                   "*1.* Verificar Teléfono en Leads\n" +
                   "*2.* Crear un Lead _(próximamente)_\n\n" +
                   "Por favor, responde solo con el número. Escribe *cancelar* en cualquier momento para volver aquí.";

      if (mensajeRecibido === '1') {
        userStates[numeroRemitente] = { action: 'verificar_crear_contacto', step: 'awaiting_phone_to_check' };
        respuesta = "Entendido. Por favor, envíame el *número de celular* que quieres verificar (sin el 0 y sin el 15, ej: 351... ó 3546...).";
      } else {
        respuesta = menu;
      }
    }
  } catch (err) {
    console.error("ERROR GENERAL EN EL WEBHOOK:", err);
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
