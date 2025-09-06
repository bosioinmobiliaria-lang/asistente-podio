// server.js
const express = require('express');
const axios = require('axios');
const qs = require('querystring');
require('dotenv').config();
const FormData = require('form-data');

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
  if (typeof obj === 'object') {
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
  if (typeof str !== 'string') return null;
  const s = str.replace('T', ' ').trim();
  const [date, time = '00:00:00'] = s.split(/\s+/);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { date, time };
}

function addHours(timeStr, hoursToAdd = 1) {
  const [H, M, S] = timeStr.split(':').map(x => parseInt(x, 10) || 0);
  const d = new Date(Date.UTC(2000, 0, 1, H, M, S));
  d.setUTCHours(d.getUTCHours() + hoursToAdd);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Construye objeto de fecha para Podio; soporta fecha simple o rango. */
function buildPodioDateObject(input, wantRange = false) {
  if (!input) return undefined;

  // Normalizamos a { date, time }
  let date = null,
    time = '00:00:00';

  if (input instanceof Date) {
    date = input.toISOString().slice(0, 10);
  } else if (typeof input === 'string') {
    const parts = splitDateTime(input); // → { date: 'YYYY-MM-DD', time: 'HH:MM:SS' }
    if (!parts) return undefined;
    date = parts.date;
    time = parts.time || '00:00:00';
  } else if (typeof input === 'object') {
    // Si ya viene con formato Podio, devolver tal cual
    if (input.start || input.start_date) return input;
    if (input.start_date) date = input.start_date;
  }

  if (!date) return undefined;

  // Si hay hora, usamos claves start/end; si no, start_date/end_date
  const hasTime = time !== '00:00:00';
  if (hasTime) {
    return wantRange
      ? { start: `${date} ${time}`, end: `${date} ${time}` }
      : { start: `${date} ${time}` };
  } else {
    return wantRange ? { start_date: date, end_date: date } : { start_date: date };
  }
}

// --- util chiquita: arma la fecha correcta para Leads (range/horas según meta)
function buildLeadDateForToday(dateFieldMeta, when = new Date()) {
  const ymd = when.toISOString().slice(0, 10); // YYYY-MM-DD
  const needTime = (dateFieldMeta?.config?.settings?.time || 'disabled') !== 'disabled';
  const wantRange = (dateFieldMeta?.config?.settings?.end || 'disabled') !== 'disabled';

  if (needTime) {
    const stamp = `${ymd} 00:00:00`;
    return wantRange ? { start: stamp, end: stamp } : { start: stamp };
  } else {
    return wantRange ? { start_date: ymd, end_date: ymd } : { start_date: ymd };
  }
}

// Devuelve YYYY-MM-DD y HH:MM:SS (si existiera)
function splitStamp(input) {
  if (!input) return { date: null, time: null };
  if (input instanceof Date) return { date: input.toISOString().slice(0, 10), time: '00:00:00' };
  if (typeof input === 'string') {
    const s = input.replace('T', ' ').trim();
    const [d, t] = s.split(/\s+/);
    return { date: d || null, time: t || '00:00:00' };
  }
  if (typeof input === 'object') {
    if (input.start) {
      const [d, t = '00:00:00'] = input.start.split(' ');
      return { date: d, time: t };
    }
    if (input.start_date) return { date: input.start_date, time: null };
  }
  return { date: null, time: null };
}

// Devuelve SIEMPRE un RANGO (start/end o start_date/end_date) para Podio
function buildPodioDateRange(dfMeta, when = new Date()) {
  const ymd = when.toISOString().slice(0, 10);
  const wantTime = (dfMeta?.config?.settings?.time || 'disabled') !== 'disabled';
  if (wantTime) {
    const stamp = `${ymd} 00:00:00`;
    return { start: stamp, end: stamp };
  } else {
    return { start_date: ymd, end_date: ymd };
  }
}

// Normaliza TODAS las fechas que vayan en el payload de creación de LEADS.
// - Convierte objetos sueltos a array
// - Convierte "start_date"↔"start" según si el campo usa hora
// - Si el campo es requerido y no viene → pone HOY.
function normalizeLeadDateFieldsForCreate(fields, leadsMeta) {
  const out = { ...(fields || {}) };
  const dateFields = (leadsMeta || []).filter(f => f.type === 'date');

  for (const df of dateFields) {
    const ext = df.external_id;
    let v = out[ext];

    const wantTime = (df?.config?.settings?.time || 'disabled') !== 'disabled';
    const wantRange = (df?.config?.settings?.end || 'disabled') !== 'disabled';

    // Si el campo es requerido y no vino, usamos HOY (como RANGO)
    if (!v && df.config?.required) {
      const ymd = new Date().toISOString().slice(0, 10);
      v = wantTime
        ? { start: `${ymd} 00:00:00`, end: `${ymd} 00:00:00` }
        : { start_date: ymd, end_date: ymd };
    }
    if (!v) continue;

    // Si vino en array, tomar el primero (create espera objeto)
    if (Array.isArray(v)) v = v[0];

    // Unificar claves según tenga hora o no
    if (wantTime) {
      // pasar _date → con hora
      if (v.start_date && !v.start) v.start = `${v.start_date} 00:00:00`;
      if (v.end_date && !v.end) v.end = `${v.end_date} 00:00:00`;
      delete v.start_date;
      delete v.end_date;
      if (wantRange && v.start && !v.end) v.end = v.start;
      if (!wantRange) delete v.end;
    } else {
      // pasar con hora → _date
      if (v.start && !v.start_date) v.start_date = String(v.start).split(' ')[0];
      if (v.end && !v.end_date) v.end_date = String(v.end).split(' ')[0];
      delete v.start;
      delete v.end;
      if (wantRange && v.start_date && !v.end_date) v.end_date = v.start_date;
      if (!wantRange) delete v.end_date;
    }

    out[ext] = v; // ← **OBJETO**, no array
  }
  return out;
}

// Para CREAR items en Podio: siempre devolvemos un ARRAY con 1 objeto de RANGO COMPLETO.

function buildPodioDateForCreate(dfMeta, when = new Date()) {
  const ymd = (when instanceof Date ? when : new Date(when)).toISOString().slice(0, 10);
  const wantTime = (dfMeta?.config?.settings?.time || 'disabled') !== 'disabled';

  if (wantTime) {
    const stamp = `${ymd} 00:00:00`;
    return { start: stamp, end: stamp }; // ← SIEMPRE rango con hora
  } else {
    return { start_date: ymd, end_date: ymd }; // ← SIEMPRE rango sin hora
  }
}

// Busca contacto por teléfono (búsqueda general). Si no existe, lo crea.
async function findOrCreateContactByPhone(digits, senderWhatsApp) {
  const appId = process.env.PODIO_CONTACTOS_APP_ID;
  const token = await getAppAccessTokenFor('contactos');

  // 1) Intento: búsqueda libre por query (suele matchear teléfonos)
  try {
    const found = await searchContactByPhone(digits);
    if (found?.length) return { item_id: found[0].item_id, created: false };
  } catch (e) {
    console.error('search contacto by query fail:', e.response?.data || e.message);
  }

  // 2) Crear contacto mínimo
  const vendedorId = VENDEDORES_CONTACTOS_MAP[senderWhatsApp] || VENDEDOR_POR_DEFECTO_ID;
  const created = await createItemIn(
    'contactos',
    cleanDeep({
      title: 'Contacto sin nombre',
      phone: [{ type: 'mobile', value: digits }],
      'vendedor-asignado-2': [vendedorId],
    }),
  );
  return { item_id: created.item_id, created: true };
}

// --- AYUDANTE PARA CALCULAR DÍAS DESDE UNA FECHA ---
function calculateDaysSince(dateString) {
  if (!dateString) return 'N/A';
  try {
    const activityDate = new Date(dateString.replace(' ', 'T') + 'Z');
    const today = new Date();
    const diffTime = Math.abs(today - activityDate);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'hoy';
    if (diffDays === 1) return 'hace 1 día';
    return `hace ${diffDays} días`;
  } catch (e) {
    console.error('Error al calcular días:', e);
    return 'N/A';
  }
}

// --- FORMATEO FECHAS PODIO → DD/MM/AAAA ---
function formatPodioDate(dateString) {
  if (!dateString) return 'N/A';
  try {
    const date = new Date(dateString + ' UTC');
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
  } catch {
    return 'N/A';
  }
}

function forceRangeDate(input) {
  // Acepta Date o string "YYYY-MM-DD" o "YYYY-MM-DD HH:MM:SS"
  let date = null,
    time = '00:00:00';
  if (input instanceof Date) {
    date = input.toISOString().slice(0, 10);
  } else if (typeof input === 'string') {
    const s = input.replace('T', ' ').trim();
    const [d, t = '00:00:00'] = s.split(/\s+/);
    date = d;
    time = t;
  }
  if (!date) return undefined;

  // Devolvemos SIEMPRE rango (start+end). Si hay hora, usamos start/end; si no, start_date/end_date
  const hasTime = time !== '00:00:00';
  if (hasTime) return { start: `${date} ${time}`, end: `${date} ${time}` };
  return { start_date: date, end_date: date };
}

// --- Timestamp "AAAA-MM-DD HH:MM:SS" (hora local del server) ---
function nowStamp(tz = 'America/Argentina/Buenos_Aires') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

// --- Línea PLANA para guardar en "seguimiento": [fecha] contenido ---
function formatSeguimientoEntry(plainText) {
  const text = (plainText || '').toString().trim();
  return `[${nowStamp()}] ${text}`;
}

// --- Utilidades para mostrar solo "fecha: contenido" (sin HTML) ---
function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
function ddmmyyyyFromStamp(stamp) {
  const [d] = (stamp || '').split(' ');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return stamp || '';
  const [Y, M, D] = d.split('-');
  return `${D}/${M}/${Y}`;
}
async function createLeadWithDateFallback(fields, dateExternalId, when = new Date()) {
  const meta = await getLeadsFieldsMeta();
  const ymd = (when instanceof Date ? when : new Date(when)).toISOString().slice(0, 10);

  // 1) asegurá todos los date requeridos
  const requiredDates = (meta || []).filter(f => f.type === 'date' && f.config?.required);
  const withAllDates = { ...fields };
  for (const f of requiredDates) {
    const ext = f.external_id;
    const needTime = (f?.config?.settings?.time || 'disabled') !== 'disabled';
    if (!withAllDates[ext]) {
      withAllDates[ext] = needTime
        ? { start: `${ymd} 00:00:00`, end: `${ymd} 00:00:00` }
        : { start_date: ymd, end_date: ymd };
    }
  }

  // 2) intentá sin hora y con hora para el campo principal (por si difiere la config)
  const stamp = `${ymd} 00:00:00`;
  const variants = [
    { [dateExternalId]: { start_date: ymd, end_date: ymd } },
    { [dateExternalId]: { start: stamp, end: stamp } },
  ];

  let lastErr;
  for (const v of variants) {
    try {
      const payload = { ...withAllDates, ...(dateExternalId ? v : {}) };
      console.log('[LEADS] Intento variante fecha →', JSON.stringify(payload, null, 2));
      return await createItemIn('leads', payload);
    } catch (e) {
      lastErr = e;
      console.error('[LEADS] Variante falló:', e?.response?.data || e.message);
    }
  }
  throw lastErr;
}

// Devuelve "DD/MM/AAAA: contenido" del último bloque del campo seguimiento
function extractLastSeguimientoLine(wholeText) {
  const clean = stripHtml((wholeText || '').replace(/\r/g, ''));
  if (!clean) return '—';

  // Buscamos TODAS las líneas que empiezan con [AAAA-MM-DD HH:MM:SS]
  const lines = clean
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  let lastStamp = null;
  let lastContent = null;

  for (const s of lines) {
    const m = s.match(/^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
    if (m) {
      lastStamp = m[1];
      lastContent = m[2].trim();
    }
  }

  if (!lastStamp) return '—';

  // Formato DD/MM/AAAA
  const fecha = ddmmyyyyFromStamp(lastStamp);

  // Limpiamos restos de etiquetas antiguas si aparecieran
  const contenido = (lastContent || '')
    .replace(/^Nueva conversación:?/i, '')
    .replace(/^Resumen conversación:?/i, '')
    .replace(/^\(Origen:[^)]+\)/i, '')
    .trim();

  return `${fecha}: ${contenido || '—'}`;
}

// --- Resultados de propiedades (WhatsApp) ---
function formatSingleProperty(prop, currentNumber) {
  const title = prop.title;
  const valorField = prop.fields.find(f => f.external_id === 'valor-de-la-propiedad');
  const localidadField = prop.fields.find(f => f.external_id === 'localidad-texto-2');
  const linkField =
    prop.fields.find(f => f.external_id === 'enlace-texto-2') ||
    prop.fields.find(f => f.external_id === 'enlace'); // fallback

  const valor = valorField
    ? `💰 Valor: *u$s ${parseInt(valorField.values[0].value).toLocaleString('es-AR')}*`
    : 'Valor no especificado';

  const localidadLimpia = localidadField
    ? localidadField.values[0].value.replace(/<[^>]*>?/gm, '')
    : 'No especificada';
  const localidad = `📍 Localidad: *${localidadLimpia}*`;

  let link = 'Sin enlace web';
  const raw = linkField?.values?.[0]?.value;
  const url = extractFirstUrl(typeof raw === 'string' ? raw : raw?.url || '');
  if (url) link = url;

  // 👇 CORRECCIÓN: Estructura final sin la línea de guiones
  return `*${currentNumber}. ${title}*
${valor}
${localidad}
🔗 Enlace: ${link}`.trim();
}
// --- Utilidades Lead / Podio ---
async function getLeadDetails(itemId) {
  const token = await getAppAccessTokenFor('leads');
  try {
    const { data } = await axios.get(`https://api.podio.com/item/${itemId}`, {
      headers: { Authorization: `OAuth2 ${token}` },
      timeout: 20000,
    });
    return data;
  } catch (err) {
    console.error('Error getLeadDetails:', err.response?.data || err.message);
    return null;
  }
}

function getTextFieldValue(item, externalId) {
  const f = (item?.fields || []).find(x => x.external_id === externalId);
  if (!f || !f.values || !f.values.length) return '';
  return (f.values[0].value || '').toString();
}

/** Guarda en 'seguimiento' SOLO "[fecha] contenido" (sin etiquetas extra) */
async function appendToLeadSeguimiento(itemId, newLinePlain) {
  try {
    const token = await getAppAccessTokenFor('leads');

    // 1) Traer el item para obtener el contenido anterior del campo.
    const item = await getLeadDetails(itemId);
    // Si el item no existe, salimos.
    if (!item) {
      console.error('[Seguimiento] No se pudo obtener el item:', itemId);
      return { ok: false, error: 'item_not_found' };
    }

    // Buscamos el campo. Si no está, es porque está vacío, lo cual es normal.
    const segField = item?.fields?.find(f => f.external_id === 'seguimiento');

    // 2) Merge de valor anterior + nueva línea.
    // Usamos 'optional chaining' (?.) para que no falle si segField es undefined.
    const prev = ((segField?.values?.[0]?.value ?? '') + '').replace(/\r/g, '');
    const entry = formatSeguimientoEntry(newLinePlain);
    const merged = prev ? `${prev}\n${entry}` : entry;

    // 3) Actualizar SOLO el campo 'seguimiento' (forma correcta para Podio)
    try {
      const url = `https://api.podio.com/item/${itemId}/value/seguimiento`;
      const body = [{ value: merged }];

      await axios.put(url, body, {
        headers: { Authorization: `OAuth2 ${token}` },
        timeout: 20000,
      });
    } catch (e1) {
      // Fallback por field_id si lo tenés (p.ej. cuando el external_id no funciona)
      if (segField?.field_id) {
        await axios.put(
          `https://api.podio.com/item/${itemId}/value/${segField.field_id}`,
          [{ value: merged }],
          { headers: { Authorization: `OAuth2 ${token}` }, timeout: 20000 },
        );
      } else {
        throw e1;
      }
    }

    console.log('[Seguimiento] Actualizado OK en item:', itemId);
    return { ok: true };
  } catch (e) {
    console.error(
      '[Seguimiento] ERROR al actualizar:',
      e.response?.status,
      e.response?.data || e.message,
    );
    return { ok: false, error: e.response?.data || e.message };
  }
}

// Extrae la primera URL que encuentre (sirve si viene en <a ...> o texto plano)
function extractFirstUrl(input) {
  const s = (input || '').toString();
  const m = s.match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0] : '';
}

/** Busca lead por teléfono o por item_id */
async function findLeadByPhoneOrId(inputStr) {
  const onlyDigits = (inputStr || '').replace(/\D/g, '');
  if (!onlyDigits) return { ok: false, reason: 'empty' };

  // Teléfono AR: 10 dígitos → NO lo interpretes como ID
  if (onlyDigits.length === 10) {
    const found = await searchLeadByPhone(onlyDigits);
    return found?.length ? { ok: true, leadItem: found[0] } : { ok: false, reason: 'not_found' };
  }

  // Primero intentar teléfono (otros largos)
  if (onlyDigits.length >= 9) {
    const found = await searchLeadByPhone(onlyDigits);
    if (found?.length) return { ok: true, leadItem: found[0] };
  }

  // Luego, y sólo si NO eran 10 dígitos, probar como item_id
  if (onlyDigits.length >= 6 && onlyDigits.length !== 10) {
    const item = await getLeadDetails(Number(onlyDigits));
    if (item?.item_id) return { ok: true, leadItem: item };
  }
  return { ok: false, reason: 'not_found' };
}

// --- OpenAI resumen (fallback si no hay crédito) ---
async function summarizeWithOpenAI(text) {
  const raw = (text || '').toString().trim();
  if (!raw) return '';

  if (!process.env.OPENAI_API_KEY) return raw; // sin key → guardar plano
  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              "Sos asistente de una inmobiliaria. Si recibís la transcripción de un audio, devolvé EXCLUSIVAMENTE viñetas con '• ' al inicio de cada línea. Entre 3 y 6 bullets, en español, sin título ni cierre. Extraé pedidos/condiciones: tipo de propiedad, zonas, presupuesto, tiempos, restricciones, dudas y próximas acciones. No inventes datos.",
          },
          { role: 'user', content: raw },
        ],
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, timeout: 60000 },
    );
    const out = (data.choices?.[0]?.message?.content || '').trim();
    return out || raw;
  } catch (err) {
    // --- ESTA ES LA MAGIA DEL DIAGNÓSTICO ---
    console.error('\n--- ❌ ERROR DETALLADO DE LA API DE OPENAI ---');
    if (err.response) {
      // El error viene de la API de OpenAI (ej: sin crédito, límite, etc.)
      console.error('Status Code:', err.response.status);
      console.error('Respuesta de OpenAI:', JSON.stringify(err.response.data, null, 2));
    } else {
      // El error es de red o de otro tipo (ej: timeout)
      console.error('Error sin respuesta de la API:', err.message);
    }
    console.error('--------------------------------------------\n');
    return raw; // Devolvemos el texto original como fallback
  }
}

// --- Transcripción de audio WhatsApp (Adaptada para Meta) ---
async function transcribeAudioFromMeta(mediaId) {
  const API_VERSION = 'v19.0';
  try {
    // 1) Pedir la media URL a Meta
    const metaUrl = `https://graph.facebook.com/${API_VERSION}/${mediaId}`;
    const metaRes = await axios.get(metaUrl, {
      headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
      timeout: 20000,
    });
    const mediaUrl = metaRes.data?.url;
    if (!mediaUrl) {
      console.error('META: url vacía en mediaId', mediaId, metaRes.data);
      return { text: null, error: 'no_media_url' };
    }
    console.log('[ASR] Media URL:', mediaUrl);

    // 2) Descargar el binario del audio (WhatsApp voice note suele ser OGG/opus)
    const audioRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    const audioBuf = Buffer.from(audioRes.data);
    const contentType = audioRes.headers['content-type'] || 'audio/ogg';
    console.log(`[ASR] Descargado ${audioBuf.length} bytes (${contentType})`);

    // 3) Enviar a OpenAI para transcribir
    const form = new FormData();
    form.append('file', audioBuf, { filename: 'audio.ogg', contentType });
    // Modelos válidos: "whisper-1" o "gpt-4o-mini-transcribe"
    form.append('model', 'whisper-1');

    const asrRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
      timeout: 60000,
    });

    const text = (asrRes.data?.text || '').trim();
    console.log('[ASR] Texto transcrito:', text);
    return { text };
  } catch (err) {
    console.error('ASR error:', err.response?.data || err.message);
    return { text: null, error: err.response?.data || err.message };
  }
}

// Cache simple para opciones de categoría por texto
const _optionIdCache = {};

/** Busca el ID de opción de un campo categoría por su texto (case-insensitive). */
async function getCategoryOptionIdPropiedades(fieldExternalId, label) {
  const key = `${fieldExternalId}::${(label || '').toLowerCase()}`;
  if (_optionIdCache[key]) return _optionIdCache[key];

  const meta = await getAppMeta(process.env.PODIO_PROPIEDADES_APP_ID, 'propiedades');
  const field = (meta.fields || []).find(f => f.external_id === fieldExternalId);
  const opt = field?.config?.settings?.options?.find(
    o => (o.text || '').toLowerCase() === (label || '').toLowerCase(),
  );
  if (opt) {
    _optionIdCache[key] = opt.id;
    return opt.id;
  }
  return null;
}

// Construye LOCALIDAD_MAP con IDs reales de Podio (por texto)
let LOCALIDAD_MAP_DYNAMIC = {};
async function ensureLocalidadMap() {
  if (Object.keys(LOCALIDAD_MAP_DYNAMIC).length) return LOCALIDAD_MAP_DYNAMIC;

  const meta = await getAppMeta(process.env.PODIO_PROPIEDADES_APP_ID, 'propiedades');
  const field = (meta.fields || []).find(f => f.external_id === 'localidad');
  const opts = field?.config?.settings?.options || [];

  const idBy = txt => opts.find(o => (o.text || '').toLowerCase() === txt.toLowerCase())?.id;
  LOCALIDAD_MAP_DYNAMIC = {
    1: idBy('Villa del Dique'),
    2: idBy('Villa Rumipal'),
    3: idBy('Santa Rosa'),
    4: idBy('Amboy'),
    5: idBy('San Ignacio'),
  };
  return LOCALIDAD_MAP_DYNAMIC;
}

/** Resumen compacto del Lead para WhatsApp (incluye último seguimiento limpio) */
function formatLeadInfoSummary(leadItem) {
  if (!leadItem) return 'No encontré info del lead.';

  const nameField = (leadItem.fields || []).find(f => f.external_id === 'contacto-2');
  const contacto = nameField ? nameField.values?.[0]?.value?.title : 'Sin nombre';

  const assignedField = (leadItem.fields || []).find(f => f.external_id === 'vendedor-asignado-2');
  const assignedTo = assignedField ? assignedField.values?.[0]?.value?.text : 'No asignado';

  const estadoField = (leadItem.fields || []).find(f => f.external_id === 'lead-status');
  const estado = estadoField ? estadoField.values?.[0]?.value?.text : 'Sin estado';

  const ubicacion = getTextFieldValue(leadItem, 'ubicacion');
  const detalle = getTextFieldValue(leadItem, 'detalle');

  // Última línea limpia del campo seguimiento → "DD/MM/AAAA: contenido"
  const segField = (leadItem.fields || []).find(f => f.external_id === 'seguimiento');
  const seguimientoUltimo = segField?.values?.[0]?.value
    ? extractLastSeguimientoLine(segField.values[0].value)
    : '—';

  const fechaCarga = formatPodioDate(leadItem.created_on);
  const lastAct = calculateDaysSince(leadItem.last_event_on);

  return [
    `👤 *Perfil*\n• Contacto: ${contacto}\n• Asesor: ${assignedTo}\n• Estado: ${estado}`,
    `🎯 *Interés*\n• Ubicación/zona: ${ubicacion || '—'}\n• Detalle: ${detalle || '—'}`,
    `🗂️ *Seguimiento (último)*\n${seguimientoUltimo}`,
    `⏱️ *Actividad*\n• Cargado: ${fechaCarga}\n• Última actividad: ${lastAct}`,
  ].join('\n\n');
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
  const token = await getAppAccessTokenFor('propiedades');
  try {
    const { data } = await axios.get(`https://api.podio.com/item/${itemId}`, {
      headers: { Authorization: `OAuth2 ${token}` },
    });
    return data;
  } catch (err) {
    console.error(
      `Error al obtener detalles del item ${itemId}:`,
      err.response ? err.response.data : err.message,
    );
    return null; // Devolvemos null si hay un error con un item específico
  }
}

async function getAppAccessTokenFor(appName = 'contactos') {
  const now = Date.now();
  const slot = TOKENS[appName] || (TOKENS[appName] = { value: null, exp: 0 });

  if (slot.value && now < slot.exp - 30_000) {
    return slot.value;
  }

  // Mapeo correcto por app
  const creds = (() => {
    switch (appName) {
      case 'leads':
        return {
          appId: process.env.PODIO_LEADS_APP_ID,
          appToken: process.env.PODIO_LEADS_APP_TOKEN,
        };
      case 'propiedades':
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
    grant_type: 'app',
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
      const { data } = await axios.post('https://podio.com/oauth/token', body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 45000, // +tiempo
      });
      slot.value = data.access_token;
      slot.exp = Date.now() + (data.expires_in || 3600) * 1000;
      return slot.value;
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.error || err?.code;
      console.error('TOKEN ERROR:', status, err?.response?.data || err.message);

      const retriable =
        status === 503 ||
        code === 'no_response' ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        err.message?.includes('timeout');

      if (!retriable || attempt === MAX_RETRIES) {
        throw new Error('No se pudo obtener access_token de Podio');
      }

      const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function buildFiltersHint(filters = {}) {
  const applied = [];
  if (filters.localidad) applied.push('📍 Localidad');
  if (typeof filters.gas === 'boolean') applied.push('🔥 Gas');
  return applied.length ? `\nAplicados: ${applied.join(', ')}` : '';
}

// 🚀 NUEVA FUNCIÓN PARA ENVIAR MENSAJES CON META (VERSIÓN COMPATIBLE)
async function sendMessage(to, messageData) {
  const API_VERSION = 'v19.0';
  const url = `https://graph.facebook.com/${API_VERSION}/${process.env.META_PHONE_NUMBER_ID}/messages`;

  // CAMBIO: Se construye el payload de una forma más tradicional para mayor compatibilidad.
  const basePayload = {
    messaging_product: 'whatsapp',
    to: to,
  };
  const payload = Object.assign(basePayload, messageData);

  console.log('Enviando mensaje a Meta:', JSON.stringify(payload, null, 2));

  // El resto de la función es idéntica
  try {
    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    console.log('Mensaje enviado con éxito.');
  } catch (error) {
    console.error(
      '❌ Error al enviar mensaje:',
      error.response ? JSON.stringify(error.response.data, null, 2) : error.message,
    );
  }
}

async function sendGasFilterButtons(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: '¿Filtrar por *Gas natural*?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'gas_yes', title: '✅ Sí' } },
          { type: 'reply', reply: { id: 'gas_no', title: '🚫 No' } },
          { type: 'reply', reply: { id: 'gas_any', title: '🔄 Cualquiera' } },
        ],
      },
    },
  });
}

// === MENÚ PRINCIPAL (con header y footer) ===
async function sendMainMenu(to) {
  const key = 'whatsapp:+' + to;
  const name = ASESOR_NOMBRE_MAP[key] || USER_NAME_MAP[key];
  const saludo = name ? `¡Hola, *${name}*! 👋` : '¡Hola! 👋';

  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      // 👇 sin header
      body: { text: `${saludo} ¿Qué hacemos hoy?\nElegí una opción:` },
      footer: { text: 'Tip: escribí *cancelar* para salir' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'menu_check_contact', title: '📇 Chequear contacto' } },
          { type: 'reply', reply: { id: 'menu_actualizar', title: '✏️ Actualizar leads' } },
          { type: 'reply', reply: { id: 'menu_buscar', title: '🔎 Buscar propiedad' } },
        ],
      },
    },
  });
}

async function sendMenuGeneral(to) {
  return sendMainMenu(to);
}

// Opciones finales tras mostrar todas las propiedades
async function sendPostResultsOptions(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: '¿Necesitás algo más?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'post_back_menu', title: '🏠 Menú principal' } },
          { type: 'reply', reply: { id: 'post_cancel', title: '❌ Cancelar' } },
        ],
      },
    },
  });
}

// Lista de orígenes con emoji (≤ 24 chars por fila)
async function sendOriginList(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: '🧭 Elegí el *origen del contacto*:' },
      action: {
        button: 'Elegir origen',
        sections: [
          {
            title: 'Orígenes',
            rows: [
              { id: 'origin_1', title: '✅ Inmobiliaria' },
              { id: 'origin_2', title: '✅ Facebook (Pers.)' },
              { id: 'origin_3', title: '✅ Instagram (Pers.)' },
              { id: 'origin_4', title: '✅ Cartelería (Cel.Inm)' },
              { id: 'origin_5', title: '✅ Página Web' },
              { id: 'origin_6', title: '✅ 0810' },
              { id: 'origin_7', title: '✅ Referido' },
              { id: 'origin_8', title: '✅ Instagram (Inmob.)' },
              { id: 'origin_9', title: '✅ Publicador externo' },
              { id: 'origin_10', title: '✅ Cliente Antiguo' },
            ],
          },
        ],
      },
    },
  });
}

// 3.1) Tipo de propiedad (lista de 8)
async function sendPropertyTypeList(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: '🏠 Buscar propiedades' },
      body: { text: '¿Qué tipo de propiedad?' },
      action: {
        button: 'Elegir tipo',
        sections: [
          {
            title: 'Tipos',
            rows: [
              { id: 'ptype_1', title: '🏡 Lote' }, // 1
              { id: 'ptype_2', title: '🏠 Casa' }, // 2
              { id: 'ptype_3', title: '🏚️ Chalet' }, // 3
              { id: 'ptype_4', title: '🏢 Dpto.' }, // 4 (Departamento)
              { id: 'ptype_5', title: '🏘️ PH' }, // 5
              { id: 'ptype_6', title: '🏭 Galpón' }, // 6
              { id: 'ptype_7', title: '🏕️ Cabañas' }, // 7
              { id: 'ptype_8', title: '🏬 Locales comerc.' }, // 8 (≤24 chars)
            ],
          },
        ],
      },
    },
  });
}

// 3.2) Botones de filtro (minimalista)
async function sendPropertyFilterButtons(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: '¿Cómo querés buscar?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'filter_go', title: '🔧 Buscar con filtros' } },
          { type: 'reply', reply: { id: 'filter_skip', title: '⏭️ Seguir sin filtros' } },
        ],
      },
    },
  });
}

async function sendFiltersList(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: 'Elegí un *filtro*:' },
      action: {
        button: 'Elegir',
        sections: [
          {
            title: 'Filtros disponibles',
            rows: [
              { id: 'f_loc', title: '📍 Por localidad' },
              { id: 'f_gas', title: '🔥 Gas natural' },
              { id: 'f_doc', title: '📄 Documentación' }, // 👈 NUEVO
              { id: 'f_done', title: '✅ Listo (continuar)' },
            ],
          },
        ],
      },
    },
  });
}

// 3.3) Lista de localidades (usa tu LOCALIDAD_MAP)
async function sendLocalidadList(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: 'Elegí la localidad:' },
      action: {
        button: 'Elegir',
        sections: [
          {
            title: 'Localidades',
            rows: [
              { id: 'loc_1', title: '📍 Villa del Dique' },
              { id: 'loc_2', title: '📍 Villa Rumipal' },
              { id: 'loc_3', title: '📍 Santa Rosa' },
              { id: 'loc_4', title: '📍 Amboy' },
              { id: 'loc_5', title: '📍 San Ignacio' },
            ],
          },
        ],
      },
    },
  });
}

async function sendPriceEntryPoint(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: '💸 Elegí cómo filtrar por *precio*:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'price_btn_any', title: '🔓 Cualquier valor' } },
          { type: 'reply', reply: { id: 'price_btn_range', title: '📊 Por rango' } },
        ],
      },
    },
  });
}

// 3.4) Rango de precio (lista de 10) — títulos cortos (≤24) + emojis
async function sendPriceRangeList(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: '💸 Elegí el rango de precio:' },
      action: {
        button: 'Elegir rango',
        sections: [
          {
            title: 'Rangos',
            rows: [
              { id: 'price_1', title: '💸 U$S 0–10.000' },
              { id: 'price_2', title: '💸 U$S 10.000–20.000' },
              { id: 'price_3', title: '💸 U$S 20.000–40.000' },
              { id: 'price_4', title: '💸 U$S 40.000–60.000' },
              { id: 'price_5', title: '💸 U$S 60.000–80.000' },
              { id: 'price_6', title: '💸 U$S 80.000–100.000' },
              { id: 'price_7', title: '💸 U$S 100.000–130.000' },
              { id: 'price_8', title: '💸 U$S 130.000–160.000' },
              { id: 'price_9', title: '💸 U$S 160.000–200.000' },
              { id: 'price_10', title: '💎 Más de U$S 200.000' },
            ],
          },
        ],
      },
    },
  });
}

// 3.5) Sub-lista de precio alto (>200k)
async function sendHighPriceList(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: '💎 Elegí el rango alto:' },
      action: {
        button: 'Elegir rango',
        sections: [
          {
            title: 'Rangos altos',
            rows: [
              { id: 'price_h1', title: 'U$S 200.000–300.000' },
              { id: 'price_h2', title: 'U$S 300.000–500.000' },
              { id: 'price_h3', title: 'Más de U$S 500.000' },
            ],
          },
        ],
      },
    },
  });
}

// 3.6) Paginado de resultados (unificado en una 'Card' por propiedad)
async function sendPropertiesPage(to, properties, startIndex = 0) {
  const batchSize = 5;
  const batch = properties.slice(startIndex, startIndex + batchSize); // Enviamos cada propiedad de la tanda en un mensaje separado y unificado

  for (let i = 0; i < batch.length; i++) {
    const prop = batch[i];
    const currentNumber = startIndex + i + 1;

    // 1. Obtenemos el link de la imagen (igual que antes)
    const photoLinkField = prop.fields.find(f => f.external_id === 'link-de-la-foto');
    const rawLinkValue = photoLinkField?.values?.[0]?.value || '';
    const imageUrl = extractFirstUrl(rawLinkValue);

    // 2. Construimos todo el texto que irá en el caption
    const captionText = formatSingleProperty(prop, currentNumber);

    if (imageUrl) {
      // 3. Si hay imagen, la enviamos con toda la info en el caption
      await sendMessage(to, {
        type: 'image',
        image: {
          link: imageUrl,
          caption: captionText, // <-- TODA la info va aquí
        },
      });
    } else {
      // 4. Fallback: Si no hay imagen, enviamos solo el texto para no fallar
      await sendMessage(to, { type: 'text', text: { body: captionText } });
    }
  }

  // El resto de la función (paginación) sigue igual
  const hasMore = startIndex + batchSize < properties.length;
  if (hasMore) {
    await sendMessage(to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: '¿Ver más resultados?' },
        action: { buttons: [{ type: 'reply', reply: { id: 'props_more', title: '➡️ Ver más' } }] },
      },
    });
  } else {
    await sendMessage(to, { type: 'text', text: { body: '✅ Esos son todos los resultados.' } });
    await sendPostResultsOptions(to);
  }
}

// Lista dinámica de opciones del campo categoría "documentacion"
async function sendDocumentacionList(to) {
  const meta = await getAppMeta(process.env.PODIO_PROPIEDADES_APP_ID, 'propiedades');
  const field = (meta.fields || []).find(f => f.external_id === 'documentacion');
  const options = field?.config?.settings?.options || [];

  const rows = options.slice(0, 10).map(o => ({
    id: `doc_${o.id}`, // 👈 usamos el ID REAL de Podio
    title: `📄 ${o.text}`.slice(0, 24), // WhatsApp: máx ~24 chars en título
  }));

  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: 'Elegí *documentación*:' },
      action: { button: 'Elegir', sections: [{ title: 'Documentación', rows }] },
    },
  });
}

async function sendInquietudList(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: '🧭 Elegí la *inquietud*:' },
      action: {
        button: 'Elegir',
        sections: [
          {
            title: 'Inquietud',
            rows: [
              { id: 'inq_1', title: '🪙 Inversión' },
              { id: 'inq_2', title: '📈 Capitalización' },
              { id: 'inq_3', title: '📦 Mudanza' },
              { id: 'inq_4', title: '🏦 Crédito hipotecario' },
              { id: 'inq_5', title: '🏖️ Para vacacionar' },
              { id: 'inq_6', title: '🧬 Herencia' },
              { id: 'inq_7', title: '💼 Trabajo' },
            ],
          },
        ],
      },
    },
  });
}

async function sendPresupuestoList(to) {
  // 9 filas + "Más opciones" (cumple límite 10)
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: '💸 Elegí *presupuesto*:' },
      action: {
        button: 'Elegir',
        sections: [
          {
            title: 'Presupuesto',
            rows: [
              { id: 'pre_1', title: '≤ U$S 10.000' },
              { id: 'pre_2', title: 'U$S 10.000–20.000' },
              { id: 'pre_3', title: 'U$S 20.000–40.000' },
              { id: 'pre_4', title: 'U$S 40.000–60.000' },
              { id: 'pre_5', title: 'U$S 60.000–80.000' },
              { id: 'pre_6', title: 'U$S 80.000–100.000' },
              { id: 'pre_7', title: 'U$S 100.000–150.000' },
              { id: 'pre_8', title: 'U$S 150.000–200.000' },
              { id: 'pre_more', title: '➡️ Más opciones…' },
            ],
          },
        ],
      },
    },
  });
}

async function sendPresupuestoHighList(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: '💸 Rango alto:' },
      action: {
        button: 'Elegir',
        sections: [
          {
            title: 'Presupuesto (alto)',
            rows: [
              { id: 'pre_10', title: 'U$S 200.000–300.000' },
              { id: 'pre_11', title: 'Más de U$S 500.000' },
            ],
          },
        ],
      },
    },
  });
}

async function sendQueBuscaList(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: '🔎 ¿Qué *busca*?' },
      action: {
        button: 'Elegir',
        sections: [
          {
            title: 'Busco',
            rows: [
              { id: 'qb_1', title: '🏠 Casa' },
              { id: 'qb_2', title: '🏡 Lote' },
              { id: 'qb_4', title: '🏗️ Casa en construcción' },
              { id: 'qb_3', title: '🏕️ Cabañas' },
              { id: 'qb_5', title: '🏢 Monoambiente' },
            ],
          },
        ],
      },
    },
  });
}

async function sendExpectativaList(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: '⏳ *Expectativa de cierre*:' },
      action: {
        button: 'Elegir',
        sections: [
          {
            title: 'Cierre',
            rows: [
              { id: 'exp_1', title: '⚡ Lo antes posible' },
              { id: 'exp_2', title: '🗓️ 1 mes' },
              { id: 'exp_3', title: '🗓️ 2 meses' },
              { id: 'exp_4', title: '🗓️ 3 meses' },
              { id: 'exp_6', title: '🗓️ + de 6 meses' },
              { id: 'exp_8', title: '🌫️ Indefinido' },
              { id: 'exp_9', title: '🏡 Debe vender una prop.' },
            ],
          },
        ],
      },
    },
  });
}

async function searchProperties(filters) {
  const appId = process.env.PODIO_PROPIEDADES_APP_ID;
  const token = await getAppAccessTokenFor('propiedades');

  const podioFilters = { estado: [ID_ESTADO_DISPONIBLE] };

  // Precio (número): {from, to}
  if (filters.precio) podioFilters['valor-de-la-propiedad'] = filters.precio;

  // Localidad (categoría): [optionId]
  if (filters.localidad) podioFilters['266379964'] = [filters.localidad];

  // Tipo (si ya lo tenías mapeado)
  if (filters.tipo) podioFilters['tipo-de-propiedad'] = [filters.tipo];

  // Documentación (categoría): [optionId]
  if (filters.documentacion) podioFilters['documentacion'] = [filters.documentacion];

  // Gas natural (categoría Sí/No)
  // Gas natural
  if (typeof filters.gas === 'boolean') {
    const label = filters.gas ? 'Si' : 'No'; // <— sin tilde
    const gasId = await getCategoryOptionIdPropiedades('gas-natural', label);
    if (gasId) podioFilters['gas-natural'] = [gasId];
  }

  console.log('--- FILTROS ENVIADOS A PODIO ---');
  console.log(JSON.stringify({ filters: podioFilters }, null, 2));
  console.log('---------------------------------');

  try {
    const response = await axios.post(
      `https://api.podio.com/item/app/${appId}/filter/`,
      {
        filters: podioFilters,
        limit: 20,
        sort_by: 'created_on',
        sort_desc: true,
      },
      {
        headers: { Authorization: `OAuth2 ${token}` },
        timeout: 20000,
      },
    );
    return response.data.items;
  } catch (err) {
    console.error(
      'Error al buscar propiedades en Podio:',
      err.response ? err.response.data : err.message,
    );
    return [];
  }
}

// Botonera de acciones sobre un lead encontrado
async function sendLeadUpdateMenu(to, leadName) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '✅ Lead encontrado' },
      body: { text: `Nombre: ${leadName}\n¿Qué querés hacer?` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'update_info', title: 'ℹ️ Info' } },
          { type: 'reply', reply: { id: 'update_newconv', title: '📝 Nueva conversación' } },
          { type: 'reply', reply: { id: 'update_visit', title: '📅 Agendar visita' } },
        ],
      },
    },
  });
}

// NUEVO: opciones luego de actualizar algo en el lead
async function sendAfterUpdateOptions(to) {
  await sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: '¿Necesitás algo más?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'after_back_menu', title: '🏠 Menú principal' } },
          { type: 'reply', reply: { id: 'after_done', title: '❌ Cancelar' } },
        ],
      },
    },
  });
}

// Actualiza el campo de fecha del lead (si existe)
async function updateLeadDate(itemId, inputStr) {
  try {
    const meta = await getLeadsFieldsMeta();
    const dateFieldMeta = meta.find(f => f.type === 'date');
    const dateExternalId =
      process.env.PODIO_LEADS_DATE_EXTERNAL_ID ||
      (dateFieldMeta ? dateFieldMeta.external_id : null);
    if (!dateExternalId) return { ok: false, error: 'No hay campo fecha en Leads' };

    const token = await getAppAccessTokenFor('leads');
    const parts = splitDateTime(inputStr); // {date, time}
    if (!parts?.date) return { ok: false, error: 'Fecha inválida' };

    const wantRange = (dateFieldMeta?.config?.settings?.end || 'disabled') !== 'disabled';
    const wantTime = (dateFieldMeta?.config?.settings?.time || 'disabled') !== 'disabled';

    let value;
    if (wantTime) {
      const stamp = `${parts.date} ${parts.time || '00:00:00'}`;
      value = wantRange ? { start: stamp, end: stamp } : { start: stamp };
    } else {
      value = wantRange
        ? { start_date: parts.date, end_date: parts.date }
        : { start_date: parts.date };
    }

    // 👇 IMPORTANTE: el body es un ARRAY con el objeto (no { value: ... })
    await axios.put(`https://api.podio.com/item/${itemId}/value/${dateExternalId}`, [value], {
      headers: { Authorization: `OAuth2 ${token}` },
      timeout: 20000,
    });

    // Dejar registro simple en seguimiento
    const tt = parts.time && parts.time !== '00:00:00' ? ` ${parts.time.slice(0, 5)}hs` : '';
    await appendToLeadSeguimiento(itemId, `Visita agendada para ${parts.date}${tt}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.response?.data || e.message };
  }
}

// Mensaje de despedida estándar
async function sendFarewell(to) {
  const key = 'whatsapp:+' + to;
  const name = ASESOR_NOMBRE_MAP[key] || USER_NAME_MAP[key];
  const msg = name
    ? `✨ Fue un gusto ayudarte *${name}*. Cuando quieras, escribime. 🙌`
    : '✨ Fue un gusto ayudarte. Cuando quieras, escribime. 🙌';
  await sendMessage(to, { type: 'text', text: { body: msg } });
}

async function createItemIn(appName, fields) {
  const appId =
    appName === 'leads' ? process.env.PODIO_LEADS_APP_ID : process.env.PODIO_CONTACTOS_APP_ID;

  const token = await getAppAccessTokenFor(appName);

  // Limpieza defensiva (si tenés cleanDeep, úsalo; si no, sigue igual).
  const inputFields = typeof cleanDeep === 'function' ? cleanDeep(fields) : fields || {};

  // Solo traigo meta para LEADS; en otros apps no filtro por meta.
  const meta = appName === 'leads' ? (await getLeadsFieldsMeta()) || [] : [];
  const hasMeta = Array.isArray(meta) && meta.length > 0;
  const byExt = hasMeta ? new Map(meta.map(f => [f.external_id, f])) : null;

  // Construyo el payload desde cero (evita claves sueltas tipo "start_date" al nivel raíz).
  const payloadFields = {};

  if (hasMeta) {
    // Con meta: solo acepto claves que sean fields reales del app.
    for (const [ext, raw] of Object.entries(inputFields)) {
      const m = byExt.get(ext);
      if (!m) continue; // ignora claves desconocidas

      if (m.type === 'date') {
        const needTime = (m?.config?.settings?.time || 'disabled') !== 'disabled';
        const wantRange = (m?.config?.settings?.end || 'disabled') !== 'disabled';
        const v = normalizeDateForPodioSafe(raw, { needTime, wantRange });
        if (v) payloadFields[ext] = v; // nunca mandes null/obj vacío
      } else {
        payloadFields[ext] = raw;
      }
    }
  } else {
    // Sin meta (p.ej. contactos): paso todo tal cual.
    Object.assign(payloadFields, inputFields);
  }

  // Log útil
  console.log(`[${appName.toUpperCase()}] Payload FINAL →`, JSON.stringify(payloadFields, null, 2));

  // POST principal
  try {
    const { data } = await axios.post(
      `https://api.podio.com/item/app/${appId}/`,
      { fields: payloadFields },
      { headers: { Authorization: `OAuth2 ${token}` }, timeout: 30000 },
    );
    return data;
  } catch (err) {
    const msg = err?.response?.data?.error_description || String(err?.message || '');
    console.log(`[${appName.toUpperCase()}] Error create →`, msg);

    // Fallback: si el servidor insiste con "must be Range", reintento forzando end = start.
    if (/must be Range/i.test(msg) && hasMeta) {
      for (const [ext, m] of byExt.entries()) {
        if (m?.type === 'date' && payloadFields[ext]) {
          const v = payloadFields[ext];
          if (v.start && !v.end) v.end = v.start;
          if (v.start_date && !v.end_date) v.end_date = v.start_date;
        }
      }
      console.log(
        `[${appName.toUpperCase()}] Reintento forzando rango →`,
        JSON.stringify(payloadFields, null, 2),
      );
      const { data } = await axios.post(
        `https://api.podio.com/item/app/${appId}/`,
        { fields: payloadFields },
        { headers: { Authorization: `OAuth2 ${token}` }, timeout: 30000 },
      );
      return data;
    }

    // Propaga si no era el caso anterior
    throw err;
  }
}

// ✅ Normalizador defensivo (renombrado para evitar colisiones)
function normalizeDateForPodioSafe(input, { needTime, wantRange }) {
  if (!input) return null;

  // Si ya viene con formato Podio, úsalo y completa el rango si falta.
  if (typeof input === 'object' && (input.start || input.start_date)) {
    const out = { ...input };
    if (wantRange) {
      if (out.start && !out.end) out.end = out.start;
      if (out.start_date && !out.end_date) out.end_date = out.start_date;
    } else {
      // Si el campo es single, asegúrate de no dejar claves "end*"
      delete out.end;
      delete out.end_date;
    }
    return out;
  }

  // Normaliza string o Date → YYYY-MM-DD y HH:MM:SS
  let dateStr = null;
  let timeStr = '00:00:00';

  if (input instanceof Date) {
    dateStr = input.toISOString().slice(0, 10);
  } else if (typeof input === 'string') {
    const m = input.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?$/);
    if (!m) return null;
    dateStr = m[1];
    timeStr = m[2] || '00:00:00';
  } else if (typeof input === 'object') {
    // Soporta { date, time } o { start_date } mínimo
    dateStr = input.date || input.start_date || null;
    timeStr = input.time || '00:00:00';
  }

  if (!dateStr) return null;

  if (needTime) {
    const out = { start: `${dateStr} ${timeStr}` };
    if (wantRange) out.end = out.start;
    return out;
  } else {
    const out = { start_date: dateStr };
    if (wantRange) out.end_date = out.start_date;
    return out;
  }
}

async function getAppMeta(appId, which = 'contactos') {
  const token = await getAppAccessTokenFor(which);
  const { data } = await axios.get(`https://api.podio.com/app/${appId}`, {
    headers: { Authorization: `OAuth2 ${token}` },
  });
  return data;
}

async function getLeadsFieldsMeta() {
  const raw = await getAppMeta(process.env.PODIO_LEADS_APP_ID, 'leads');
  return raw.fields || [];
}

// --- NUEVA FUNCIÓN DE BÚSQUEDA RÁPIDA EN LEADS ---
async function searchLeadByPhone(phoneNumber) {
  const appId = process.env.PODIO_LEADS_APP_ID;
  const token = await getAppAccessTokenFor('leads');

  try {
    const searchFieldExternalId = 'telefono-busqueda';

    const response = await axios.post(
      `https://api.podio.com/item/app/${appId}/filter/`,
      {
        filters: {
          // ✅ SOLUCIÓN: Enviamos el número como texto simple, no como un objeto.
          [searchFieldExternalId]: phoneNumber,
        },
      },
      {
        headers: { Authorization: `OAuth2 ${token}` },
        timeout: 15000,
      },
    );
    return response.data.items;
  } catch (err) {
    console.error('Error al buscar lead en Podio:', err.response ? err.response.data : err.message);
    return [];
  }
}

// --- Contactos: buscar por teléfono (query + match exacto por últimos 10) ---
async function searchContactByPhone(phoneRaw) {
  const appId = process.env.PODIO_CONTACTOS_APP_ID;
  const token = await getAppAccessTokenFor('contactos');

  const digits = (phoneRaw || '').replace(/\D/g, '');
  if (!digits) return [];

  const core10 = digits.slice(-10);
  const variants = Array.from(
    new Set([
      core10,
      digits,
      '0' + core10,
      '15' + core10,
      '54' + core10,
      '549' + core10,
      '+54' + core10,
      '+549' + core10,
    ]),
  );

  const norm10 = s => (s || '').toString().replace(/\D/g, '').slice(-10);
  const exactByPhone = items =>
    (items || []).filter(it => {
      const pf = (it.fields || []).find(f => f.external_id === 'phone');
      const list = pf?.values || [];
      return list.some(p => norm10(p?.value) === core10);
    });

  const tryQuery = async q => {
    try {
      const r = await axios.post(
        `https://api.podio.com/item/app/${appId}/filter/`,
        { query: q, limit: 50 }, // query global
        { headers: { Authorization: `OAuth2 ${token}` }, timeout: 20000 },
      );
      return r.data?.items || [];
    } catch (e) {
      console.error('contact query fail:', e.response?.data || e.message);
      return [];
    }
  };

  // 1) Probar varias variantes de query y filtrar localmente por igualdad exacta (últimos 10)
  for (const q of variants) {
    const hits = exactByPhone(await tryQuery(q));
    if (hits.length) return hits;
  }

  // 2) Fallback: traer últimos N y filtrar localmente por phone
  try {
    const r = await axios.post(
      `https://api.podio.com/item/app/${appId}/filter/`,
      { limit: 200, sort_by: 'created_on', sort_desc: true },
      { headers: { Authorization: `OAuth2 ${token}` }, timeout: 20000 },
    );
    return exactByPhone(r.data?.items || []);
  } catch (e) {
    console.error('contact fallback scan fail:', e.response?.data || e.message);
    return [];
  }
}

// ----------------------------------------
// Contactos - meta & creación
// ----------------------------------------
app.get('/meta/fields', async (_req, res) => {
  try {
    const data = await getAppMeta(process.env.PODIO_CONTACTOS_APP_ID, 'contactos');
    res.json({
      app: data.config?.name || 'Contactos',
      fields: data.fields.map(f => ({
        label: f.label,
        external_id: f.external_id,
        type: f.type,
        options: f.config?.settings?.options?.map(o => ({ id: o.id, text: o.text })) || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message });
  }
});

app.post('/contactos', async (req, res) => {
  try {
    const {
      title,
      phone,
      email,
      tipo_de_contacto_option_id,
      origen_contacto_option_id,
      acompanante,
      telefono_acompanante,
      vendedor_asignado_option_id,
      fecha_creacion,
    } = req.body;
    const fields = cleanDeep({
      title: title || 'Contacto sin nombre',
      'tipo-de-contacto': tipo_de_contacto_option_id ? [tipo_de_contacto_option_id] : undefined,
      'contact-type': origen_contacto_option_id ? [origen_contacto_option_id] : undefined,
      'fecha-de-creacion': buildPodioDateObject(
        fecha_creacion || new Date().toISOString().slice(0, 19).replace('T', ' '),
        false,
      ),
      phone: phone ? [{ type: 'mobile', value: phone }] : undefined,
      acompanante: acompanante || undefined,
      'telefono-del-acompanante': telefono_acompanante
        ? [{ type: 'mobile', value: telefono_acompanante }]
        : undefined,
      'vendedor-asignado-2': vendedor_asignado_option_id
        ? [vendedor_asignado_option_id]
        : undefined,
      'email-2': email ? [{ type: 'other', value: email }] : undefined,
    });
    const created = await createItemIn('contactos', fields);
    res
      .status(201)
      .json({ ok: true, item_id: created.item_id, message: 'Contacto creado en Podio' });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ ok: false, error: err?.response?.data || err.message });
  }
});

// ----------------------------------------
// Leads - meta
// ----------------------------------------
app.get('/meta/fields/leads', async (_req, res) => {
  try {
    const fields = await getLeadsFieldsMeta();
    const dateFields = fields
      .filter(f => f.type === 'date')
      .map(f => ({
        label: f.label,
        external_id: f.external_id,
        required: !!f.config?.required,
        endMode: f.config?.settings?.end || 'disabled',
        rangeEnabled: (f.config?.settings?.end || 'disabled') !== 'disabled',
      }));
    const chosen =
      process.env.PODIO_LEADS_DATE_EXTERNAL_ID ||
      (dateFields[0] ? dateFields[0].external_id : null);
    res.json({ app: 'Leads', chosenDateExternalId: chosen, dateFields, fields });
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message });
  }
});

// ----------------------------------------
// Leads - creación
// ----------------------------------------
app.post('/leads', async (req, res) => {
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
      force_range,
    } = req.body;
    const meta = await getLeadsFieldsMeta();
    const dateFieldMeta = meta.find(f => f.type === 'date');
    const dateExternalId =
      process.env.PODIO_LEADS_DATE_EXTERNAL_ID ||
      (dateFieldMeta ? dateFieldMeta.external_id : null);
    const forceRangeFromEnv = String(process.env.PODIO_LEADS_FORCE_RANGE || '') === '1';
    const forceRangeFromReq =
      req.query.forceRange === '1' || req.headers['x-force-range'] === '1' || force_range === true;
    const apiSaysRange = (dateFieldMeta?.config?.settings?.end || 'disabled') !== 'disabled';
    const wantRange = forceRangeFromReq || forceRangeFromEnv || apiSaysRange;
    const fields = cleanDeep({
      'contacto-2': contacto_item_id ? [{ item_id: contacto_item_id }] : undefined,
      'telefono-busqueda': telefono ? String(telefono).replace(/\D/g, '') : undefined,
      'vendedor-asignado-2': vendedor_option_id ? [vendedor_option_id] : undefined,
      'lead-status': lead_status_option_id ? [lead_status_option_id] : undefined,
      ubicacion: ubicacion || undefined,
      detalle: detalle || undefined,
      seguimiento: seguimiento || undefined,
      ...(extras && typeof extras === 'object' ? extras : {}),
    });
    const skipDate =
      String(process.env.PODIO_LEADS_SKIP_DATE || '') === '1' ||
      req.query.skipDate === '1' ||
      req.headers['x-skip-date'] === '1';

    let created;
    if (!skipDate && dateExternalId && (fecha || dateFieldMeta?.config?.required)) {
      created = await createLeadWithDateFallback(
        fields,
        dateExternalId,
        fecha ? new Date(fecha) : new Date(),
      );
    } else {
      created = await createItemIn('leads', fields);
    }

    res.status(201).json({ ok: true, item_id: created.item_id, message: 'Lead creado en Podio' });
  } catch (err) {
    console.error('\n[LEADS ERROR] =>', err?.response?.data || err.message);
    res.status(500).json({ ok: false, error: err?.response?.data || err.message });
  }
});

// ----------------------------------------
// Debugs
// ----------------------------------------
app.post('/debug/leads/payload', async (req, res) => {
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
      force_range,
    } = req.body;
    const meta = await getLeadsFieldsMeta();
    const dateFieldMeta = meta.find(f => f.type === 'date');
    const dateExternalId =
      process.env.PODIO_LEADS_DATE_EXTERNAL_ID ||
      (dateFieldMeta ? dateFieldMeta.external_id : null);
    const forceRangeFromEnv = String(process.env.PODIO_LEADS_FORCE_RANGE || '') === '1';
    const forceRangeFromReq =
      req.query.forceRange === '1' || req.headers['x-force-range'] === '1' || force_range === true;
    const apiSaysRange = (dateFieldMeta?.config?.settings?.end || 'disabled') !== 'disabled';
    const wantRange = forceRangeFromReq || forceRangeFromEnv || apiSaysRange;
    const fields = cleanDeep({
      'contacto-2': contacto_item_id ? [{ item_id: contacto_item_id }] : undefined,
      'telefono-busqueda': telefono ? String(telefono).replace(/\D/g, '') : undefined,
      'vendedor-asignado-2': vendedor_option_id ? [vendedor_option_id] : undefined,
      'lead-status': lead_status_option_id ? [lead_status_option_id] : undefined,
      ubicacion: ubicacion || undefined,
      detalle: detalle || undefined,
      seguimiento: seguimiento || undefined,
      ...(extras && typeof extras === 'object' ? extras : {}),
    });
    res.json({ wouldSend: { fields }, dateExternalId, wantRange });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.response?.data || err.message });
  }
});

app.get('/debug/env', (_req, res) => {
  res.json({
    PORT: process.env.PORT,
    PODIO_CLIENT_ID: process.env.PODIO_CLIENT_ID,
    PODIO_CONTACTOS_APP_ID: process.env.PODIO_CONTACTOS_APP_ID,
    PODIO_LEADS_APP_ID: process.env.PODIO_LEADS_APP_ID,
    PODIO_LEADS_FORCE_RANGE: process.env.PODIO_LEADS_FORCE_RANGE,
    PODIO_LEADS_DATE_EXTERNAL_ID: process.env.PODIO_LEADS_DATE_EXTERNAL_ID || '(auto)',
  });
});

app.get('/', (_req, res) =>
  res.send(
    'OK • GET /meta/fields, POST /contactos, GET /meta/fields/leads, POST /leads, POST /debug/leads/payload, GET /debug/env',
  ),
);

// ----------------------------------------
// Webhook para WhatsApp (LÓGICA CONVERSACIONAL Y RÁPIDA v11.0)
// ----------------------------------------
const twilio = require('twilio');
const MessagingResponse = twilio.twiml.MessagingResponse;

const userStates = {}; // "Memoria" del bot

// --- Mapas para las opciones de Podio (sin cambios) ---
const VENDEDORES_LEADS_MAP = {
  'whatsapp:+5493571605532': 1, // Diego Rodriguez
  'whatsapp:+5493546560311': 9, // Esteban Bosio
  'whatsapp:+5493546490249': 2, // Esteban Coll
  'whatsapp:+5493546549847': 3, // Maximiliano Perez
  'whatsapp:+5493546452443': 10, // Gabriel Perez
  'whatsapp:+5493546545121': 7, // Carlos Perez
  'whatsapp:+5493546513759': 8, // Santiago Bosio
};

// ✅ NUEVO: IDs para la App de CONTACTOS (extraídos de tu captura)
const VENDEDORES_CONTACTOS_MAP = {
  'whatsapp:+5493571605532': 1, // Diego Rodriguez
  'whatsapp:+5493546560311': 8, // Esteban Bosio
  'whatsapp:+5493546490249': 5, // Esteban Coll
  'whatsapp:+5493546549847': 2, // Maximiliano Perez
  'whatsapp:+5493546452443': 10, // Gabriel Perez
  'whatsapp:+5493546545121': 4, // Carlos Perez
  'whatsapp:+5493546513759': 9, // Santiago Bosio
};
const VENDEDOR_POR_DEFECTO_ID = 8; // Usamos el ID de Esteban como default
const TIPO_CONTACTO_MAP = { 1: 1, 2: 2 };
const ORIGEN_CONTACTO_MAP = {
  1: 6, // Inmobiliaria
  2: 1, // Facebook (Personal)
  3: 9, // Instagram (Personal)  (antes opción 8)
  4: 2, // Carteleria (Celu inmobiliaria)
  5: 8, // Pagina Web
  6: 3, // 0810
  7: 5, // Referido
  8: 11, // Instagram (Inmobiliaria) (antes opción 9)
  9: 10, // Publicador externo
  10: 12, // Cliente Antiguo
};

// ====== Opciones Podio para crear Lead (IDs reales de tus capturas) ======
// === Opciones de Podio (IDs exactos de tus capturas) ===
const INQUIETUD_MAP = { inq_1: 1, inq_2: 10, inq_3: 2, inq_4: 4, inq_5: 8, inq_6: 6, inq_7: 9 };

const PRESUPUESTO_MAP = {
  pre_1: 1,
  pre_2: 2,
  pre_3: 3,
  pre_4: 4,
  pre_5: 5,
  pre_6: 6,
  pre_7: 7,
  pre_8: 8,
  pre_9: 9,
  pre_10: 10,
  pre_11: 11,
};

const BUSCA_MAP = { qb_1: 1, qb_2: 2, qb_4: 4, qb_3: 3, qb_5: 5 };

const EXPECTATIVA_MAP = { exp_1: 1, exp_2: 2, exp_3: 3, exp_4: 4, exp_6: 6, exp_8: 8, exp_9: 9 };

// --- Rangos de precio (lista principal de 10) ---
const PRICE_RANGES_10 = {
  1: { from: 0, to: 10000 },
  2: { from: 10000, to: 20000 },
  3: { from: 20000, to: 40000 },
  4: { from: 40000, to: 60000 },
  5: { from: 60000, to: 80000 },
  6: { from: 80000, to: 100000 },
  7: { from: 100000, to: 130000 },
  8: { from: 130000, to: 160000 },
  9: { from: 160000, to: 200000 },
  10: { from: 200000, to: 99999999, next: true }, // dispara sub-lista alta
};

// 👤 Nombre por número (para saludo personalizado)
const ASESOR_NOMBRE_MAP = {
  'whatsapp:+5493571605532': 'Diego',
  'whatsapp:+5493546560311': 'Este',
  'whatsapp:+5493546490249': 'Este',
  'whatsapp:+5493546549847': 'Maxi',
  'whatsapp:+5493546452443': 'Gabi',
  'whatsapp:+5493546545121': 'Carlos',
  'whatsapp:+5493546513759': 'Santi',
  'whatsapp:+5493512846059': 'Debo',
};

// Nombres aprendidos de usuarios internos no listados (memoria en RAM)
const USER_NAME_MAP = {};

// --- Rangos altos (si eligen > 200k) ---
const PRICE_RANGES_HIGH = {
  h1: { from: 200000, to: 300000 },
  h2: { from: 300000, to: 500000 },
  h3: { from: 500000, to: 99999999 },
};

// ✅ IDs REALES (extraídos de tus capturas)
const LOCALIDAD_MAP = {
  1: 1, // Villa del Dique
  2: 2, // Villa Rumipal
  3: 3, // Santa Rosa
  4: 4, // Amboy
  5: 5, // San Ignacio
};

const TIPO_PROPIEDAD_MAP = {
  1: 1, // Lote
  2: 2, // Casa
  3: 3, // Chalet
  4: 4, // Departamento
  5: 5, // PH
  6: 6, // Galpon
  7: 7, // Cabañas
  8: 8, // Locales comerciales
};

// ✅ ID REAL (extraído de tus capturas)
const ID_ESTADO_DISPONIBLE = 1; // ID de la opción "Disponible" del campo "Estado"
//

// ===============================================
// NUEVO WEBHOOK PARA WHATSAPP CLOUD API (META)
// ===============================================

// --- 1. Verificación del Webhook (GET) ---
app.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado con éxito.');
    res.status(200).send(challenge);
  } else {
    console.error('❌ Falló la verificación del webhook.');
    res.sendStatus(403);
  }
});

// --- 2. Recepción de Mensajes (POST) ---
app.post('/whatsapp', async (req, res) => {
  // CAMBIO 1: Respondemos a Meta inmediatamente para evitar timeouts.
  res.sendStatus(200);

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return; // ← primero chequeamos que exista

    // Declaramos las variables ANTES de usarlas
    let userInput = '';
    let interactiveReplyId = null;

    // Ahora sí, podemos loguear message.*
    console.log('[WHATSAPP] tipo:', message.type, '| from:', message.from);
    if (message.type === 'audio') {
      console.log('[WHATSAPP] audio.id:', message.audio?.id);
    }

    const from = message.from;
    const numeroRemitente = `whatsapp:+${from}`;
    let currentState = userStates[numeroRemitente];

    if (message.type === 'text') {
      userInput = (message.text?.body || '').trim();
      if (userStates[numeroRemitente]) userStates[numeroRemitente].lastInputType = 'text';
    } else if (message.type === 'interactive') {
      const interactive = message.interactive;
      if (interactive?.type === 'button_reply') {
        interactiveReplyId = interactive.button_reply.id;
      } else if (interactive?.type === 'list_reply') {
        interactiveReplyId = interactive.list_reply.id;
      }
    } else if (message.type === 'audio') {
      try {
        const mediaId = message.audio.id;
        const { text: asrText } = await transcribeAudioFromMeta(mediaId);
        userInput = (asrText || '').trim();
        if (userStates[numeroRemitente]) userStates[numeroRemitente].lastInputType = 'audio';
      } catch (e) {
        console.error('ASR fail:', e);
        userInput = '';
      }
    }

    const input = interactiveReplyId || userInput;

    // 🔗 Override global del menú: funciona aunque haya estado previo
    if (['menu_check_contact', 'menu_actualizar', 'menu_buscar'].includes(input)) {
      delete userStates[numeroRemitente];

      if (input === 'menu_check_contact') {
        userStates[numeroRemitente] = { step: 'check_contact_start' };
        await sendMessage(from, {
          type: 'text',
          text: { body: '📱 Pasame el *celular* (10 dígitos, sin 0/15).' },
        });
      } else if (input === 'menu_actualizar') {
        userStates[numeroRemitente] = { step: 'update_lead_start' };
        await sendMessage(from, {
          type: 'text',
          text: { body: '🛠️ Actualizar lead\nEnviá el *celular* (10 dígitos) o el *ID* del lead.' },
        });
      } else if (input === 'menu_buscar') {
        userStates[numeroRemitente] = { step: 'awaiting_property_type', filters: {} };
        await sendPropertyTypeList(from);
      }
      return; // 👈 importantísimo: cortamos el flujo acá
    }

    // CAMBIO 3: La variable "respuesta" se elimina. Cada respuesta se envía directamente.
    // const twiml = new MessagingResponse();
    // let respuesta = "";

    // Cancelar y volver al menú
    const low = (input || '').toLowerCase(); // ← evita crash si input es undefined
    if (low === 'cancelar' || low === 'volver') {
      delete userStates[numeroRemitente];
      await sendFarewell(from);
      return; // ← no seguimos, no mostramos menú
    } else if (currentState) {
      console.log('--- ESTADO ACTUAL ---', JSON.stringify(currentState, null, 2)); // <-- AGREGA ESTA LÍNEA
      switch (currentState.step) {
        case 'awaiting_name_only': {
          const nombre = (input || '').trim();
          if (!nombre || nombre.length < 3) {
            await sendMessage(from, {
              type: 'text',
              text: { body: '🤏 Nombre muy corto. Probá de nuevo (Nombre y Apellido).' },
            });
            break;
          }
          currentState.data = currentState.data || {};
          currentState.data.title = nombre;

          // Pasamos a elegir tipo con botones
          currentState.step = 'awaiting_contact_type';
          await sendMessage(from, {
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text: '👤 ¿Qué tipo de contacto es?' },
              action: {
                buttons: [
                  { type: 'reply', reply: { id: 'type_buyer', title: '🛒 Comprador' } },
                  { type: 'reply', reply: { id: 'type_owner', title: '🏠 Propietario' } },
                ],
              },
            },
          });
          break;
        }

        case 'awaiting_contact_type': {
          let tipoId = null,
            tipoTexto = '';
          if (input === 'type_buyer') {
            tipoId = TIPO_CONTACTO_MAP['1'];
            tipoTexto = 'Comprador';
          }
          if (input === 'type_owner') {
            tipoId = TIPO_CONTACTO_MAP['2'];
            tipoTexto = 'Propietario';
          }

          if (!tipoId) {
            await sendMessage(from, {
              type: 'text',
              text: { body: 'Elegí una opción 👆 o escribí *cancelar*.' },
            });
            break;
          }

          currentState.data['tipo-de-contacto'] = [tipoId];

          const telefono = currentState.data.phone?.[0]?.value || '—';
          const nombre = currentState.data.title || '—';

          // Resumen corto + pasamos a origen (con LISTA interactiva)
          await sendMessage(from, {
            type: 'text',
            text: {
              body: `✅ Datos ok\n\n• *Nombre:* ${nombre}\n• *Tel.:* ${telefono}\n• *Tipo:* ${tipoTexto}`,
            },
          });

          // Mostrar lista de orígenes
          currentState.step = 'awaiting_origin';
          await sendOriginList(from);
          break;
        }

        // ===== 1) Verificar teléfono en Leads =====
        case 'awaiting_phone_to_check': {
          console.log("==> PASO 1: Entrando al flujo 'awaiting_phone_to_check'.");
          const phoneToCheck = input.replace(/\D/g, '');

          console.log(`==> PASO 2: Buscando el teléfono: ${phoneToCheck} en Podio...`);
          const existingLeads = await searchLeadByPhone(phoneToCheck);
          console.log(
            `==> PASO 3: Búsqueda en Podio finalizada. Se encontraron ${existingLeads.length} leads.`,
          );

          if (existingLeads.length > 0) {
            // --- SI ENCUENTRA EL LEAD ---
            console.log('==> PASO 4: Lead encontrado. Enviando resumen.');
            const lead = existingLeads[0];
            const leadTitleField = lead.fields.find(f => f.external_id === 'contacto-2');
            const leadTitle = leadTitleField ? leadTitleField.values[0].value.title : 'Sin nombre';
            const assignedField = lead.fields.find(f => f.external_id === 'vendedor-asignado-2');
            const assignedTo = assignedField ? assignedField.values[0].value.text : 'No asignado';
            const creationDate = formatPodioDate(lead.created_on);
            const lastActivityDays = calculateDaysSince(lead.last_event_on);
            const responseText =
              `✅ *Lead Encontrado*\n\n` +
              `*Contacto:* ${leadTitle}\n*Asesor:* ${assignedTo}\n*Fecha de Carga:* ${creationDate}\n*Última Actividad:* ${lastActivityDays}`;

            await sendMessage(from, { type: 'text', text: { body: responseText } });
            delete userStates[numeroRemitente];
          } else {
            // --- NO ENCUENTRA EL LEAD ---
            console.log('==> PASO 4: Lead no encontrado. Ofreciendo crear contacto.');
            currentState.step = 'awaiting_creation_confirmation';
            currentState.data = {
              phone: [{ type: 'mobile', value: phoneToCheck }],
              'telefono-busqueda': phoneToCheck,
            };
            await sendMessage(from, {
              type: 'interactive',
              interactive: {
                type: 'button',
                body: {
                  text: `⚠️ El número *${phoneToCheck}* no existe en Leads.\n\n¿Deseas crear un nuevo Contacto?`,
                },
                action: {
                  buttons: [
                    {
                      type: 'reply',
                      reply: { id: 'confirm_create_yes', title: 'Sí, crear ahora' },
                    },
                    { type: 'reply', reply: { id: 'confirm_create_no', title: 'No, cancelar' } },
                  ],
                },
              },
            });
          }
          console.log("==> PASO 5: Flujo 'awaiting_phone_to_check' completado.");
          break;
        }

        case 'awaiting_creation_confirmation': {
          if (input === 'confirm_create_yes') {
            currentState.step = 'awaiting_name_only';
            await sendMessage(from, {
              type: 'text',
              text: { body: '✍️ Decime *Nombre y Apellido*.' },
            });
          } else if (input === 'confirm_create_no' || low === 'cancelar') {
            delete userStates[numeroRemitente];
            await sendFarewell(from);
            break; // ← no menú
          } else {
            await sendMessage(from, {
              type: 'text',
              text: { body: 'Tocá un botón para continuar o escribí *cancelar*.' },
            });
          }
          break;
        }

        case 'awaiting_name_and_type': {
          const info = (input || '').split('\n').map(line => line.trim());
          if (info.length < 2) {
            await sendMessage(from, {
              type: 'text',
              text: {
                body: '❌ Faltan datos. Primera línea: Nombre. Segunda línea: Tipo (1 o 2).',
              },
            });
            break;
          }

          const [nombre, tipoInputRaw] = info;
          const tipoInput = (tipoInputRaw || '').trim();
          const tipoId = TIPO_CONTACTO_MAP[tipoInput.charAt(0)];

          if (!nombre || !tipoId) {
            let errorMsg = '❌ Hay un error en los datos.\n';
            if (!nombre) errorMsg += 'El *Nombre* no puede estar vacío.\n';
            if (!tipoId) errorMsg += 'El *Tipo* debe ser 1 o 2.\n';
            await sendMessage(from, {
              type: 'text',
              text: { body: errorMsg + '\nPor favor, intentá de nuevo.' },
            });
            break;
          }

          currentState.data.title = nombre;
          currentState.data['tipo-de-contacto'] = [tipoId];

          const telefono = currentState.data.phone[0].value;
          const tipoTexto = tipoId === 1 ? 'Comprador' : 'Propietario';

          const responseText =
            `✅ *Datos recibidos:*\n\n*Nombre:* ${nombre}\n*Teléfono:* ${telefono}\n*Tipo:* ${tipoTexto}\n\n` +
            '🌎 Elegí el *origen del contacto*:\n\n' +
            '*1.* Inmobiliaria\n*2.* Facebook\n*3.* Cartelería\n*4.* Página Web\n*5.* Showroom\n*6.* 0810\n*7.* Referido\n*8.* Instagram (Personal)\n*9.* Instagram (Inmobiliaria)\n*10.* Publicador externo\n*11.* Cliente antiguo';
          await sendMessage(from, { type: 'text', text: { body: responseText } });
          currentState.step = 'awaiting_origin';
          break;
        }

        case 'awaiting_origin': {
          // Esperamos un list_reply con ids "origin_#"
          const m = /^origin_(\d+)$/.exec(input || '');
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

          currentState.data['contact-type'] = [origenId];
          const vendedorId = VENDEDORES_CONTACTOS_MAP[numeroRemitente] || VENDEDOR_POR_DEFECTO_ID;
          currentState.data['vendedor-asignado-2'] = [vendedorId];
          currentState.data['fecha-de-creacion'] = buildPodioDateObject(new Date());
          delete currentState.data['telefono-busqueda'];

          try {
            await createItemIn('contactos', currentState.data);
            await sendMessage(from, {
              type: 'text',
              text: { body: '✅ *Contacto creado y asignado.*' },
            });
          } catch (e) {
            await sendMessage(from, {
              type: 'text',
              text: { body: '⚠️ No pude crear el contacto. Probá más tarde.' },
            });
          }
          delete userStates[numeroRemitente];
          break;
        }

        // ===== Tipo de propiedad elegido =====
        case 'awaiting_property_type': {
          const m = /^ptype_(\d)$/.exec(input || '');
          if (!m) {
            await sendPropertyTypeList(from);
            break;
          }
          const tipoKey = m[1]; // "1".."8"
          const tipoId = TIPO_PROPIEDAD_MAP[tipoKey];
          if (!tipoId) {
            await sendPropertyTypeList(from);
            break;
          }

          currentState.filters = currentState.filters || {};
          currentState.filters.tipo = tipoId;

          currentState.step = 'awaiting_property_filter';
          await sendPropertyFilterButtons(from);
          break;
        }

        // ===== Botones de filtro =====
        case 'awaiting_property_filter': {
          if (input === 'filter_go') {
            currentState.step = 'filters_menu';
            await sendFiltersList(from);
          } else if (input === 'filter_skip') {
            currentState.step = 'awaiting_price_entry';
            await sendPriceEntryPoint(from);
          } else {
            await sendPropertyFilterButtons(from);
          }
          break;
        }

        case 'awaiting_price_entry': {
          if (input === 'price_btn_any') {
            delete currentState.filters?.precio;
            const results = await searchProperties(currentState.filters);
            if (!results?.length) {
              currentState.step = 'awaiting_price_retry';
              currentState.priceLevel = 'main';
              await sendMessage(from, {
                type: 'interactive',
                interactive: {
                  type: 'button',
                  body: { text: '😕 Sin resultados.\n¿Probar un rango?' },
                  action: {
                    buttons: [
                      {
                        type: 'reply',
                        reply: { id: 'price_retry_main', title: '🔁 Elegir rango' },
                      },
                      { type: 'reply', reply: { id: 'price_retry_cancel', title: '❌ Cancelar' } },
                    ],
                  },
                },
              });
              break;
            }
            currentState.step = 'showing_results';
            currentState.results = results;
            currentState.nextIndex = 0;
            await sendPropertiesPage(from, results, 0);
            currentState.nextIndex += 5;
            break;
          }

          if (input === 'price_btn_range') {
            currentState.step = 'awaiting_price_range';
            await sendPriceRangeList(from);
            break;
          }

          await sendPriceEntryPoint(from); // fallback si escribe otra cosa
          break;
        }

        case 'filters_menu': {
          currentState.filters = currentState.filters || {};

          switch (input) {
            case 'f_loc': {
              currentState.step = 'awaiting_localidad';
              await sendLocalidadList(from);
              break;
            }

            case 'f_gas': {
              currentState.step = 'awaiting_gas_filter';
              await sendGasFilterButtons(from);
              break;
            }

            case 'f_doc': {
              // 👇 nuevo filtro por Documentación
              currentState.step = 'awaiting_doc_filter';
              await sendDocumentacionList(from);
              break;
            }

            case 'f_done': {
              const lines = [];
              if (currentState.filters.localidad) lines.push('• 📍 Localidad');
              if (typeof currentState.filters.gas === 'boolean') {
                lines.push(`• 🔥 Gas: ${currentState.filters.gas ? 'Sí' : 'No'}`);
              }
              if (currentState.filters.documentacion) lines.push('• 📄 Documentación');
              if (lines.length) {
                await sendMessage(from, {
                  type: 'text',
                  text: { body: `🧰 *Filtros activos*\n${lines.join('\n')}` },
                });
              }

              currentState.step = 'awaiting_price_entry';
              await sendPriceEntryPoint(from);
              break;
            }

            default: {
              await sendFiltersList(from);
              break;
            }
          }
          break;
        }

        // ===== Localidad (si eligió filtrar) =====
        case 'awaiting_localidad': {
          const m = /^loc_(\d)$/.exec(input || '');
          if (!m) {
            await sendLocalidadList(from);
            break;
          } // CAMBIO CLAVE: Usamos el mapa estático y confiable

          const locKey = m[1];
          const locId = LOCALIDAD_MAP[locKey]; // Usamos LOCALIDAD_MAP, no el dinámico
          // Esta validación sigue siendo importante por si se elige una opción inválida

          if (!locId) {
            await sendMessage(from, {
              type: 'text',
              text: { body: 'Opción inválida, por favor elegí de la lista.' },
            });
            await sendLocalidadList(from);
            break;
          }

          currentState.filters = currentState.filters || {};
          currentState.filters.localidad = locId; // Confirmamos y volvemos al menú de filtros (como en la corrección anterior)

          await sendMessage(from, {
            type: 'text',
            text: { body: '✅ Filtro de *localidad* aplicado.' },
          });
          currentState.step = 'filters_menu';
          await sendFiltersList(from);
          break;
        }

        case 'awaiting_gas_filter': {
          if (input === 'gas_yes') {
            currentState.filters.gas = true;
          } else if (input === 'gas_no') {
            currentState.filters.gas = false;
          } else if (input === 'gas_any') {
            delete currentState.filters.gas; // no filtrar por gas
          } else {
            await sendGasFilterButtons(from);
            break;
          }
          await sendMessage(from, { type: 'text', text: { body: '✅ Filtro de gas aplicado.' } });
          currentState.step = 'filters_menu';
          await sendFiltersList(from);
          break;
        }

        // ===== Rango principal =====
        case 'awaiting_price_range': {
          // Opción: ver todas (sin limitar por precio)
          if (input === 'price_any') {
            delete currentState.filters?.precio; // aseguramos que no quede rango previo

            const results = await searchProperties(currentState.filters);
            if (!results || !results.length) {
              currentState.step = 'awaiting_price_retry';
              currentState.priceLevel = 'main';
              await sendMessage(from, {
                type: 'interactive',
                interactive: {
                  type: 'button',
                  body: { text: '😕 Sin resultados.\n¿Probar otro rango?' },
                  action: {
                    buttons: [
                      {
                        type: 'reply',
                        reply: { id: 'price_retry_main', title: '🔁 Elegir otro rango' },
                      },
                      { type: 'reply', reply: { id: 'price_retry_cancel', title: '❌ Cancelar' } },
                    ],
                  },
                },
              });
              break;
            }

            currentState.step = 'showing_results';
            currentState.results = results;
            currentState.nextIndex = 0;
            await sendPropertiesPage(from, results, currentState.nextIndex);
            currentState.nextIndex += 5;
            break;
          }

          const m = /^price_(\d+)$/.exec(input || '');
          if (!m) {
            await sendPriceRangeList(from);
            break;
          }
          const k = m[1];
          const range = PRICE_RANGES_10[k];
          if (!range) {
            await sendPriceRangeList(from);
            break;
          }

          if (range.next) {
            currentState.step = 'awaiting_price_range_high';
            await sendHighPriceList(from);
            break;
          }

          currentState.filters.precio = { from: range.from, to: range.to };

          // BUSCAR y mostrar página 1
          const results = await searchProperties(currentState.filters);
          // ... (código que maneja si no hay resultados) ...

          // ✅ Mensaje con el total ANTES de empezar a listar
          await sendMessage(from, {
            type: 'text',
            text: { body: `✅ ¡Encontré ${results.length} propiedades disponibles!` },
          });

          currentState.step = 'showing_results';
          currentState.results = results;
          currentState.nextIndex = 0;
          await sendPropertiesPage(from, results, currentState.nextIndex);
          currentState.nextIndex += 5;
          break;

          currentState.step = 'showing_results';
          currentState.results = results;
          currentState.nextIndex = 0;
          await sendPropertiesPage(from, results, currentState.nextIndex);
          currentState.nextIndex += 5;
          break;
        }

        // ===== Rango alto (>200k) =====
        case 'awaiting_price_range_high': {
          let r = null;
          if (input === 'price_h1') r = PRICE_RANGES_HIGH.h1;
          if (input === 'price_h2') r = PRICE_RANGES_HIGH.h2;
          if (input === 'price_h3') r = PRICE_RANGES_HIGH.h3;
          if (!r) {
            await sendHighPriceList(from);
            break;
          }

          currentState.filters.precio = { from: r.from, to: r.to };

          // BUSCAR y mostrar página 1
          const results = await searchProperties(currentState.filters);
          if (!results || !results.length) {
            currentState.step = 'awaiting_price_retry';
            // También volvemos al menú PRINCIPAL (no al de “alto”)
            currentState.priceLevel = 'main';
            await sendMessage(from, {
              type: 'interactive',
              interactive: {
                type: 'button',
                body: { text: '😕 Sin resultados.\n¿Probar otro rango?' },
                action: {
                  buttons: [
                    {
                      type: 'reply',
                      reply: { id: 'price_retry_main', title: '🔁 Elegir otro rango' },
                    },
                    { type: 'reply', reply: { id: 'price_retry_cancel', title: '❌ Cancelar' } },
                  ],
                },
              },
            });
            break;
          }

          currentState.step = 'showing_results';
          currentState.results = results;
          currentState.nextIndex = 0;
          await sendPropertiesPage(from, results, currentState.nextIndex);
          currentState.nextIndex += 5;

          break;
        }

        // ===== Paginado: botón "Ver más" =====
        case 'showing_results': {
          if (input === 'props_more') {
            const results = currentState.results || [];
            const idx = currentState.nextIndex || 0;
            if (idx >= results.length) {
              await sendMessage(from, { type: 'text', text: { body: 'No hay más resultados 🙂' } });
              currentState.step = 'post_results_options';
              await sendPostResultsOptions(from);
              break;
            }
            await sendPropertiesPage(from, results, idx);
            currentState.nextIndex = idx + 5;
          } else {
            delete userStates[numeroRemitente];
            await sendMainMenu(from);
          }
          break;
        }

        case 'post_results_options': {
          if (input === 'post_back_menu') {
            delete userStates[numeroRemitente];
            await sendMainMenu(from);
          } else if (input === 'post_cancel' || low === 'cancelar') {
            delete userStates[numeroRemitente];
            await sendFarewell(from);
          } else {
            // Repetimos opciones si escribe otra cosa
            await sendPostResultsOptions(from);
          }
          break;
        }

        case 'awaiting_price_retry':
          {
            if (input === 'price_retry_main') {
              // Siempre mostramos el menú PRINCIPAL de rangos
              currentState.step = 'awaiting_price_range';
              await sendPriceRangeList(from);
            } else if (input === 'price_retry_cancel' || low === 'cancelar') {
              delete userStates[numeroRemitente];
              await sendFarewell(from);
              break; // ← no menú
            } else {
              // Si escriben otra cosa, mantenemos el loop y re-enviamos los botones
              await sendMessage(from, {
                type: 'interactive',
                interactive: {
                  type: 'button',
                  body: { text: '😕 Sin resultados.\n¿Probar otro rango?' },
                  action: {
                    buttons: [
                      {
                        type: 'reply',
                        reply: { id: 'price_retry_main', title: '🔁 Elegir otro rango' },
                      },
                      { type: 'reply', reply: { id: 'price_retry_cancel', title: '❌ Cancelar' } },
                    ],
                  },
                },
              });
            }
            break;
          }

          // Tampoco hay Contacto → ofrecer crear Contacto (flujo existente)
          currentState.step = 'awaiting_creation_confirmation';
          currentState.data = { phone: [{ type: 'mobile', value: raw }], 'telefono-busqueda': raw };
          await sendMessage(from, {
            type: 'interactive',
            interactive: {
              type: 'button',
              body: {
                text: `⚠️ No existe un Lead ni un Contacto con *${raw}*.\n¿Querés crear el contacto ahora?`,
              },
              action: {
                buttons: [
                  {
                    type: 'reply',
                    reply: { id: 'confirm_create_yes', title: '✅ Crear Contacto' },
                  },
                  { type: 'reply', reply: { id: 'confirm_create_no', title: '❌ Cancelar' } },
                ],
              },
            },
          });
          break;

        case 'awaiting_create_lead_confirm': {
          if (input === 'create_lead_yes') {
            // inicia wizard
            currentState.step = 'awaiting_inquietud';
            currentState.leadDraft = {};
            await sendInquietudList(from);
          } else if (input === 'create_lead_no' || low === 'cancelar') {
            delete userStates[numeroRemitente];
            await sendFarewell(from);
          } else {
            // re-mostrar botones
            const name = currentState.contactItemId ? 'Contacto' : '';
            await sendMessage(from, {
              type: 'text',
              text: { body: 'Tocá un botón para continuar. ✅ / ❌' },
            });
          }
          break;
        }

        case 'awaiting_inquietud': {
          const m = /^inq_\d+$/.exec(input || '');
          if (!m) {
            await sendInquietudList(from);
            break;
          }
          currentState.leadDraft.inquietud = INQUIETUD_MAP[m[0]];
          currentState.step = 'awaiting_presupuesto';
          await sendPresupuestoList(from);
          break;
        }

        case 'awaiting_presupuesto': {
          if (input === 'pre_more') {
            currentState.step = 'awaiting_presupuesto_high';
            await sendPresupuestoHighList(from);
            break;
          }
          const m = /^pre_\d+$/.exec(input || '');
          if (!m) {
            await sendPresupuestoList(from);
            break;
          }
          currentState.leadDraft.presupuesto = PRESUPUESTO_MAP[m[0]];
          currentState.step = 'awaiting_que_busca';
          await sendQueBuscaList(from);
          break;
        }

        case 'awaiting_presupuesto_high': {
          const m = /^pre_1[01]$/.exec(input || ''); // 10 u 11
          if (!m) {
            await sendPresupuestoHighList(from);
            break;
          }
          currentState.leadDraft.presupuesto = PRESUPUESTO_MAP[m[0]];
          currentState.step = 'awaiting_que_busca';
          await sendQueBuscaList(from);
          break;
        }

        case 'awaiting_que_busca': {
          const m = /^qb_[12345]$/.exec(input || '');
          if (!m) {
            await sendQueBuscaList(from);
            break;
          }
          currentState.leadDraft.busca = BUSCA_MAP[m[0]];
          currentState.step = 'create_lead_expectativa';
          await sendExpectativaList(from);
          break;
        }

        case 'create_lead_expectativa': {
          const id = EXPECTATIVA_MAP[input];
          if (!id) {
            await sendExpectativaList(from);
            break;
          }
          currentState.leadDraft.expectativa = id;

          try {
            const vendedorId = VENDEDORES_LEADS_MAP[numeroRemitente] || VENDEDOR_POR_DEFECTO_ID;

            // ⚠️ SOLO categorías + refs. Nada de start_date/start/end acá.
            const fields = {
              'contacto-2': [{ item_id: currentState.contactItemId }],
              'telefono-busqueda': currentState.tempPhoneDigits,
              'vendedor-asignado-2': [vendedorId],
              'lead-status': [currentState.leadDraft.inquietud],
              'presupuesto-2': [currentState.leadDraft.presupuesto],
              busca: [currentState.leadDraft.busca],
              'ideal-time-frame-of-sale': [currentState.leadDraft.expectativa],
            };

            // Descubrimos cuál es el campo fecha (external_id real) y dejamos
            // que el helper pruebe rango sin hora y con hora.
            const meta = await getLeadsFieldsMeta();
            const dateExternalId =
              process.env.PODIO_LEADS_DATE_EXTERNAL_ID ||
              meta.find(f => f.type === 'date')?.external_id ||
              null;

            console.log(
              '[LEADS] FINAL PAYLOAD (ANTES CREATE) →',
              JSON.stringify({ fields }, null, 2),
            );

            // 👉 Esto intenta 1) {start_date,end_date} y si falla 2) {start,end}
            const created = await createLeadWithDateFallback(fields, dateExternalId, new Date());

            currentState.leadItemId = created.item_id;
            currentState.step = 'awaiting_newlead_voice';
            delete currentState.lastInputType;

            await sendMessage(from, {
              type: 'text',
              text: { body: '✅ *Lead creado y vinculado al contacto.*' },
            });
            await sendMessage(from, {
              type: 'text',
              text: {
                body: '🎙️ Si querés, dejá *un audio* o texto con lo conversado y lo guardo como nota.',
              },
            });
          } catch (e) {
            console.error('[LEADS] FALLÓ DEFINITIVO:', e?.response?.data || e.message);
            await sendMessage(from, {
              type: 'text',
              text: { body: '❌ No pude crear el Lead. Probá más tarde.' },
            });
            delete userStates[numeroRemitente];
          }
          break;
        }

        case 'awaiting_newlead_voice': {
          const leadId = currentState.leadItemId;
          const raw = (input || '').trim();
          const kind = currentState.lastInputType || 'text'; // 'audio' o 'text'

          if (!raw) {
            await sendMessage(from, {
              type: 'text',
              text: {
                body: '🤏 No entendí o el audio vino vacío. Probá de nuevo, o escribí *cancelar*.',
              },
            });
            break;
          }

          await sendMessage(from, {
            type: 'text',
            text: {
              body:
                kind === 'audio'
                  ? '🎙️ Analizando y resumiendo…'
                  : '📝 Guardando en el seguimiento…',
            },
          });

          let toSave = raw;
          if (kind === 'audio') {
            try {
              const resumen = await summarizeWithOpenAI(raw);
              if (resumen && resumen.trim()) toSave = resumen.trim();
            } catch (e) {
              console.error('[Seguimiento] resumen fail:', e.message);
            }
          }

          const r = await appendToLeadSeguimiento(leadId, toSave);
          if (!r.ok) {
            await sendMessage(from, {
              type: 'text',
              text: { body: '❌ No pude guardar el seguimiento. Avisá al administrador.' },
            });
          } else {
            await sendMessage(from, {
              type: 'text',
              text: { body: '✅ Guardado en el seguimiento del lead.' },
            });
          }

          currentState.step = 'after_update_options';
          await sendAfterUpdateOptions(from);
          break;
        }

        case 'update_lead_start': {
          // El usuario responde con el celular (o un item_id)
          const raw = (input || '').replace(/\D/g, '');

          if (!raw) {
            await sendMessage(from, {
              type: 'text',
              text: { body: '📱 Mandame el *celular* (10 dígitos, sin 0/15) o el *ID* del lead.' },
            });
            break;
          }

          // 1) Intentar encontrar el Lead por teléfono o por ID
          const found = await findLeadByPhoneOrId(raw);
          if (found.ok && found.leadItem) {
            const leadItem = found.leadItem;
            currentState.leadItemId = leadItem.item_id;
            currentState.step = 'update_lead_menu';

            const nameField = (leadItem.fields || []).find(f => f.external_id === 'contacto-2');
            const leadName = nameField
              ? nameField.values?.[0]?.value?.title || 'Sin nombre'
              : 'Sin nombre';

            await sendLeadUpdateMenu(from, leadName); // ✅ “Lead encontrado: … ¿Qué querés hacer?”
            break;
          }

          // 2) No hay Lead → buscar Contacto para linkear
          const contacts = await searchContactByPhone(raw);

          if (contacts?.length) {
            const contact = contacts[0];
            const cName = contact.title || 'Contacto sin nombre';

            currentState.step = 'awaiting_create_lead_confirm';
            currentState.tempPhoneDigits = raw;
            currentState.contactItemId = contact.item_id;

            await sendMessage(from, {
              type: 'interactive',
              interactive: {
                type: 'button',
                header: { type: 'text', text: `✅ Contacto encontrado: ${cName}` },
                body: { text: 'No hay un Lead asociado. ¿Querés crear uno y vincularlo?' },
                action: {
                  buttons: [
                    { type: 'reply', reply: { id: 'create_lead_yes', title: '✅ Crear Lead' } },
                    { type: 'reply', reply: { id: 'create_lead_no', title: '❌ Cancelar' } },
                  ],
                },
              },
            });
            break;
          }

          // 3) Tampoco hay Contacto → ofrecer crear Contacto
          currentState.step = 'awaiting_creation_confirmation';
          currentState.data = { phone: [{ type: 'mobile', value: raw }], 'telefono-busqueda': raw };

          await sendMessage(from, {
            type: 'interactive',
            interactive: {
              type: 'button',
              body: {
                text: `⚠️ No existe un Lead ni un Contacto con *${raw}*.\n¿Querés crear el contacto ahora?`,
              },
              action: {
                buttons: [
                  {
                    type: 'reply',
                    reply: { id: 'confirm_create_yes', title: '✅ Crear Contacto' },
                  },
                  { type: 'reply', reply: { id: 'confirm_create_no', title: '❌ Cancelar' } },
                ],
              },
            },
          });
          break;
        }

        case 'update_lead_menu': {
          const id = input;
          const leadId = currentState.leadItemId;
          if (!leadId) {
            delete userStates[numeroRemitente];
            break;
          }

          if (id === 'update_info') {
            const leadItem = await getLeadDetails(leadId);
            const summary = formatLeadInfoSummary(leadItem);
            await sendMessage(from, { type: 'text', text: { body: summary } });
            // Volvemos a mostrar la botonera para seguir actuando
            const nameField = (leadItem.fields || []).find(f => f.external_id === 'contacto-2');
            const leadName = nameField
              ? nameField.values?.[0]?.value?.title || 'Sin nombre'
              : 'Sin nombre';
            await sendLeadUpdateMenu(from, leadName);
          } else if (id === 'update_newconv') {
            currentState.step = 'awaiting_newconv_text';
            // MENSAJE MEJORADO: Avisamos que vamos a resumir.
            await sendMessage(from, {
              type: 'text',
              text: {
                body: '🗣️ Enviá *texto o audio* con la conversación. Lo voy a resumir y guardar en el seguimiento.',
              },
            });
          } else if (id === 'update_visit') {
            currentState.step = 'awaiting_visit_date';
            await sendMessage(from, {
              type: 'text',
              text: {
                body: '📅 Decime la *fecha* de la visita (AAAA-MM-DD). Podés agregar hora HH:MM.',
              },
            });
          } else {
            // Si eligen una opción inválida, mostramos el menú de nuevo.
            const leadItem = await getLeadDetails(leadId);
            const nameField = (leadItem.fields || []).find(f => f.external_id === 'contacto-2');
            const leadName = nameField
              ? nameField.values?.[0]?.value?.title || 'Sin nombre'
              : 'Sin nombre';
            await sendLeadUpdateMenu(from, leadName);
          }
          break;
        }

        case 'awaiting_newconv_text': {
          const leadId = currentState.leadItemId;
          const raw = (input || '').trim();
          const kind = currentState.lastInputType || 'text'; // 'text' o 'audio'

          console.log('[DIAGNÓSTICO] Texto recibido para procesar:', raw);

          if (!raw) {
            await sendMessage(from, {
              type: 'text',
              text: {
                body: '🤏 No entendí o el audio estaba vacío. Enviá de nuevo el seguimiento en *texto o audio*, o escribí *cancelar*.',
              },
            });
            break;
          }

          // Mensaje de estado acorde
          await sendMessage(from, {
            type: 'text',
            text: {
              body:
                kind === 'audio'
                  ? '🎙️ Analizando... Dame un momento para resumir y guardar en Podio.'
                  : '📝 Guardando tu mensaje en Podio...',
            },
          });

          // Si es audio, resumimos corto; si es texto, guardamos tal cual
          let toSave = raw;
          if (kind === 'audio') {
            try {
              const resumen = await summarizeWithOpenAI(raw);
              if (resumen && resumen.trim()) toSave = resumen.trim();
            } catch (e) {
              console.error('[Seguimiento] Error generando resumen:', e.message);
              // si falla el resumen, queda el texto transcripto
            }
          }

          const r = await appendToLeadSeguimiento(leadId, toSave);
          if (!r.ok) {
            console.error('[Seguimiento] Error guardando:', r.error);
            await sendMessage(from, {
              type: 'text',
              text: { body: '❌ No pude guardar en Podio. Avisá al administrador.' },
            });
          } else {
            await sendMessage(from, {
              type: 'text',
              text: {
                body:
                  kind === 'audio'
                    ? '✅ Guardé el resumen en el seguimiento del lead.'
                    : '✅ Guardé tu mensaje en el seguimiento del lead.',
              },
            });
          }

          // limpiar flag de tipo de entrada
          delete currentState.lastInputType;

          // Volver a la botonera del lead
          currentState.step = 'after_update_options';
          await sendAfterUpdateOptions(from);
          break;
        }

        case 'check_contact_start': {
          const digits = (input || '').replace(/\D/g, '').slice(-10);
          if (!/^\d{10}$/.test(digits)) {
            await sendMessage(from, {
              type: 'text',
              text: { body: '⚠️ Enviá 10 dígitos (sin 0/15).' },
            });
            break;
          }

          currentState.tempPhoneDigits = digits;

          const [contacts = [], leads = []] = await Promise.all([
            searchContactByPhone(digits),
            searchLeadByPhone(digits),
          ]);

          const getAsesor = item => {
            const f = (item?.fields || []).find(x => x.external_id === 'vendedor-asignado-2');
            return f?.values?.[0]?.value?.text || '—';
          };
          const hace = item => calculateDaysSince(item?.created_on); // 'hoy' / 'hace X días'

          const listRefs = items =>
            items.map(it => `• ${getAsesor(it)} — cargado ${hace(it)}`).join('\n');

          if (contacts.length && !leads.length) {
            // a) En Contactos, no en Leads
            const header =
              contacts.length === 1
                ? '✅ *Cliente encontrado en Contactos*'
                : `✅ *Cliente encontrado en Contactos* (${contacts.length} registros)`;
            const detalle = listRefs(contacts);

            await sendMessage(from, {
              type: 'text',
              text: { body: `${header}\n${detalle}\n\n🚫 *No aparece en Leads.*` },
            });

            currentState.step = 'check_contact_choices';
            await sendMessage(from, {
              type: 'interactive',
              interactive: {
                type: 'button',
                body: { text: '¿Deseás cargarlo como *nuevo contacto*?' },
                action: {
                  buttons: [
                    {
                      type: 'reply',
                      reply: { id: 'check_create_contact_yes', title: '🧾 Crear contacto' },
                    },
                    { type: 'reply', reply: { id: 'check_cancel', title: '❌ Cancelar' } },
                  ],
                },
              },
            });
            break;
          }

          if (contacts.length && leads.length) {
            // b) En Contactos y en Leads
            const headerC =
              contacts.length === 1
                ? '✅ *En Contactos*'
                : `✅ *En Contactos* (${contacts.length})`;
            const headerL =
              leads.length === 1 ? '✅ *En Leads*' : `✅ *En Leads* (${leads.length})`;

            await sendMessage(from, {
              type: 'text',
              text: { body: `${headerC}\n${listRefs(contacts)}\n\n${headerL}\n${listRefs(leads)}` },
            });

            currentState.step = 'check_contact_choices';
            await sendMessage(from, {
              type: 'interactive',
              interactive: {
                type: 'button',
                body: { text: '¿Te puedo ayudar en algo más?' },
                action: {
                  buttons: [
                    { type: 'reply', reply: { id: 'check_back_menu', title: '🏠 Menú principal' } },
                    { type: 'reply', reply: { id: 'check_cancel', title: '❌ Cancelar' } },
                  ],
                },
              },
            });
            break;
          }

          // c) No está en Contactos ni en Leads
          await sendMessage(from, {
            type: 'text',
            text: { body: '🔎 *No encontré* ningún contacto ni lead con ese número.' },
          });

          currentState.step = 'check_contact_choices';
          await sendMessage(from, {
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text: '¿Querés *crear un nuevo contacto*?' },
              action: {
                buttons: [
                  {
                    type: 'reply',
                    reply: { id: 'check_create_contact_yes', title: '🧾 Crear contacto' },
                  },
                  { type: 'reply', reply: { id: 'check_cancel', title: '❌ Cancelar' } },
                ],
              },
            },
          });
          break;
        }

        case 'collect_display_name': {
          const name = (input || '').trim();
          if (!name || name.length < 2) {
            await sendMessage(from, {
              type: 'text',
              text: { body: 'Perdón, no lo tomé. Decime solo tu *nombre* (2+ letras).' },
            });
            break;
          }
          const key = 'whatsapp:+' + from;
          USER_NAME_MAP[key] = name;

          await sendMessage(from, { type: 'text', text: { body: `¡Gracias, *${name}*! 🙌` } });
          delete userStates[numeroRemitente]; // arrancamos limpio
          await sendMainMenu(from);
          break;
        }

        case 'awaiting_doc_filter': {
          const m = /^doc_(\d+)$/.exec(input || '');
          if (!m) {
            await sendDocumentacionList(from);
            break;
          }
          currentState.filters = currentState.filters || {};
          currentState.filters.documentacion = Number(m[1]); // 👈 guardamos el ID de opción
          await sendMessage(from, {
            type: 'text',
            text: { body: '✅ Filtro de *documentación* aplicado.' },
          });
          currentState.step = 'filters_menu';
          await sendFiltersList(from);
          break;
        }

        case 'check_contact_choices': {
          if (input === 'check_create_contact_yes') {
            // saltamos directo a pedir nombre (reutilizando tu flujo de creación)
            userStates[numeroRemitente].step = 'awaiting_name_only';
            userStates[numeroRemitente].data = {
              phone: [{ type: 'mobile', value: userStates[numeroRemitente].tempPhoneDigits }],
              'telefono-busqueda': userStates[numeroRemitente].tempPhoneDigits,
            };
            await sendMessage(from, {
              type: 'text',
              text: { body: '✍️ Decime *Nombre y Apellido*.' },
            });
          } else if (input === 'check_back_menu') {
            delete userStates[numeroRemitente];
            await sendMainMenu(from);
          } else if (input === 'check_cancel' || low === 'cancelar') {
            delete userStates[numeroRemitente];
            await sendFarewell(from); // “Fue un gusto ayudarte…”
          } else {
            // Si manda otra cosa, repetimos opciones cortas
            await sendMessage(from, {
              type: 'interactive',
              interactive: {
                type: 'button',
                body: { text: 'Elegí una opción 👇' },
                action: {
                  buttons: [
                    { type: 'reply', reply: { id: 'check_back_menu', title: '🏠 Menú principal' } },
                    { type: 'reply', reply: { id: 'check_cancel', title: '❌ Cancelar' } },
                  ],
                },
              },
            });
          }
          break;
        }

        case 'create_lead_confirm': {
          if (input === 'create_lead_yes') {
            // Vinculamos (o creamos) el contacto por teléfono
            const phone = currentState.newLead?.phoneDigits;
            const { item_id: contactoId } = await findOrCreateContactByPhone(
              phone,
              numeroRemitente,
            );
            currentState.newLead.contactoId = contactoId;

            // Pregunta 1
            currentState.step = 'create_lead_inquietud';
            await sendInquietudList(from);
          } else if (input === 'create_lead_no' || low === 'cancelar') {
            delete userStates[numeroRemitente];
            await sendFarewell(from);
          } else {
            await sendMessage(from, {
              type: 'text',
              text: { body: 'Tocá un botón para continuar o escribí *cancelar*.' },
            });
          }
          break;
        }

        case 'create_lead_inquietud': {
          const id = INQUIETUD_MAP[input];
          if (!id) {
            await sendInquietudList(from);
            break;
          }
          currentState.newLead['lead-status'] = [id];
          currentState.step = 'create_lead_presupuesto';
          await sendPresupuestoList(from);
          break;
        }

        case 'create_lead_presupuesto': {
          const id = PRESUPUESTO_MAP[input];
          if (!id) {
            await sendQueBuscaList(from);
            break;
          }
          currentState.newLead['presupuesto-2'] = [id];
          currentState.step = 'create_lead_busca';
          await sendBuscaList(from);
          break;
        }

        case 'create_lead_busca': {
          const id = BUSCA_MAP[input];
          if (!id) {
            await sendBuscaList(from);
            break;
          }
          currentState.newLead['busca'] = [id];
          currentState.step = 'create_lead_expectativa';
          await sendExpectativaList(from);
          break;
        }

        case 'after_update_options': {
          if (input === 'after_back_menu') {
            delete userStates[numeroRemitente];
            await sendMainMenu(from);
          } else if (input === 'after_done' || low === 'cancelar' || low === 'cancelar') {
            delete userStates[numeroRemitente];
            await sendMessage(from, {
              type: 'text',
              text: {
                body: '✨ Fue un gusto ayudarte. Estoy para acompañarte; cuando quieras, escribime. 🙌',
              },
            });
          } else {
            await sendAfterUpdateOptions(from);
          }
          break;
        }

        case 'awaiting_visit_date': {
          const leadId = currentState.leadItemId;
          const text = (input || '').trim();
          const res = await updateLeadDate(leadId, text);
          if (res.ok) {
            await sendMessage(from, {
              type: 'text',
              text: { body: '📌 Visita agendada. Quedó registrada en el lead.' },
            });
          } else {
            await sendMessage(from, {
              type: 'text',
              text: {
                body: '⚠️ No pude registrar la fecha. Enviá *AAAA-MM-DD* (y hora HH:MM opcional).',
              },
            });
            break; // seguí en este paso hasta que lo mande bien
          }
          // Volver a la botonera del lead
          currentState.step = 'update_lead_menu';
          const leadItem = await getLeadDetails(leadId);
          const nameField = (leadItem.fields || []).find(f => f.external_id === 'contacto-2');
          const leadName = nameField
            ? nameField.values?.[0]?.value?.title || 'Sin nombre'
            : 'Sin nombre';
          await sendLeadUpdateMenu(from, leadName);
          break;
        }

        // ... Y así sucesivamente para todos los demás `case` ...
        // Simplemente reemplaza `respuesta =` por `await sendMessage(from, { type: 'text', text: { body: ... } });`

        // ===== COPIA Y PEGA EL RESTO DE TUS `case` AQUÍ, REALIZANDO EL CAMBIO MENCIONADO =====

        // ------- fallback -------
        default: {
          delete userStates[numeroRemitente];
          await sendMainMenu(from);
          break;
        }
      } // end switch con estado
    } else {
      // Sin estado: menú inicial
      if (input === 'menu_check_contact') {
        userStates[numeroRemitente] = { step: 'check_contact_start' };
        await sendMessage(from, {
          type: 'text',
          text: { body: '📱 Pasame el *celular* (10 dígitos, sin 0/15).' },
        });
      } else if (input === 'menu_actualizar') {
        userStates[numeroRemitente] = { step: 'update_lead_start' };
        await sendMessage(from, {
          type: 'text',
          text: { body: '🛠️ Actualizar lead\nEnviá el *celular* (10 dígitos) o el *ID* del lead.' },
        });
      } else if (input === 'menu_buscar') {
        userStates[numeroRemitente] = { step: 'awaiting_property_type', filters: {} };
        await sendPropertyTypeList(from);
      } else {
        // Si es un número nuevo, nos presentamos y pedimos nombre; si no, mostramos menú
        const key = 'whatsapp:+' + from;
        if (!ASESOR_NOMBRE_MAP[key] && !USER_NAME_MAP[key]) {
          userStates[numeroRemitente] = { step: 'collect_display_name' };
          await sendMessage(from, {
            type: 'text',
            text: {
              body: 'Hola, soy *Bosi*, asistente de Bosio Inmobiliaria. ¿Cómo te llamás? 🙂',
            },
          });
        } else {
          await sendMainMenu(from);
        }
      }
    }
  } catch (err) {
    console.error('\n--- ERROR DETALLADO EN WEBHOOK ---');
    if (err.response) {
      console.error('Status Code:', err.response.status);
      console.error('Respuesta de Podio:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('Error no relacionado con la API:', err.message);
      console.error(err.stack);
    }
  }
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
  console.log(
    `[CFG] PODIO_LEADS_FORCE_RANGE=${process.env.PODIO_LEADS_FORCE_RANGE || '0'} | PODIO_LEADS_DATE_EXTERNAL_ID=${process.env.PODIO_LEADS_DATE_EXTERNAL_ID || '(auto)'}`,
  );
});
