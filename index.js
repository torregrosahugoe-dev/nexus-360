// index.js
import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* =========================
 * Twilio
 * ========================= */
const { VoiceResponse } = twilio.twiml;
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

/* =========================
 * Configuración (ENV)
 * ========================= */
const PORT        = process.env.PORT || 3000;
const STT_LANG    = process.env.STT_LANG || 'es-ES';
const TTS_VOICE   = process.env.TTS_VOICE || 'Polly.Miguel';

const FALLBACK_NUMBER = (process.env.FALLBACK_NUMBER || '').trim();           // para transferir a asesor (E.164)
const WHATSAPP_FROM   = (process.env.TWILIO_WHATSAPP_FROM || '+14155238886')  // sandbox por defecto
  .replace(/^whatsapp:/i, '').replace(/^:/, '').trim();
const SMS_FROM        = (process.env.TWILIO_SMS_FROM || '').trim();          // opcional, número Twilio con SMS
const MENU_URL        = (process.env.MENU_URL || '').trim();                 // link público al menú (opcional)
const TEST_TOKEN      = (process.env.TEST_TOKEN || '').trim();               // protege /wa/test y /admin/unknown
const TEST_TO_E164    = (process.env.TEST_TO_E164 || '+573115601472').trim();// destino por defecto en pruebas

/* =========================
 * OpenAI
 * ========================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/* =========================
 * Catálogo (menu.json)
 * ========================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const MENU_PATH  = process.env.MENU_PATH || path.join(__dirname, 'data', 'menu.json');

let CATALOG = { currency: 'COP', categories: [] };
try {
  CATALOG = JSON.parse(fs.readFileSync(MENU_PATH, 'utf8'));
  console.log('[CATALOG] Loaded', MENU_PATH, 'items:',
    (CATALOG.categories || []).reduce((n, c) => n + (c.items?.length || 0), 0)
  );
} catch (e) {
  console.warn('[CATALOG] No se pudo cargar menu.json:', e.message);
}
const CURRENCY = (CATALOG.currency || 'COP').toUpperCase();

const ITEMS = (CATALOG.categories || [])
  .flatMap(c => (c.items || []).map(it => ({ ...it, category: c.name || c.id })));

/* =========================
 * Helpers Catálogo / Texto
 * ========================= */
function normalize(s='') {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
function findItemByNameOrId(token) {
  const t = normalize(token || '');
  if (!t) return null;
  // id exacto
  let f = ITEMS.find(x => normalize(String(x.id)) === t);
  if (f) return f;
  // nombre aproximado
  f = ITEMS.find(x => normalize(String(x.name)).includes(t) || t.includes(normalize(String(x.name))));
  return f || null;
}
function priceOrder(order) {
  const priced = { items: [], subtotal: 0, currency: CURRENCY };
  for (const it of (order?.items || [])) {
    const ref = findItemByNameOrId(it.id || it.nombre || it.name);
    const cantidad = Number(it.cantidad) > 0 ? Number(it.cantidad) : 1;
    if (!ref) {
      priced.items.push({ ...it, valido: false, motivo: 'No está en el catálogo' });
      continue;
    }
    const precio = Number(ref.price || ref.precio || 0);
    const linea = {
      id: ref.id, nombre: ref.name, precio, cantidad,
      total: precio * cantidad, valido: true, notas: it.notas || ''
    };
    priced.items.push(linea);
    priced.subtotal += linea.total;
  }
  return priced;
}
function missingSlots(order) {
  const faltan = [];
  if (!order?.items?.length) faltan.push('items');
  else {
    const invalid = order.items.filter(x => !findItemByNameOrId(x.id || x.nombre || x.name));
    if (invalid.length) faltan.push('items válidos del catálogo');
  }
  // Ejemplos si quieres obligar estos campos:
  // if (!order?.delivery?.direccion) faltan.push('dirección');
  // if (!order?.pago?.metodo) faltan.push('método de pago');
  return faltan;
}

/* ——— Sugerencias si un producto no existe ——— */
function bigrams(str='') {
  const s = normalize(str);
  const arr = [];
  for (let i = 0; i < s.length - 1; i++) arr.push(s.slice(i, i+2));
  return new Set(arr);
}
function jaccard(aSet, bSet) {
  const inter = new Set([...aSet].filter(x => bSet.has(x)));
  const union = new Set([...aSet, ...bSet]);
  return union.size ? inter.size / union.size : 0;
}
function scoreName(query='', candidate='') {
  return jaccard(bigrams(query), bigrams(candidate));
}
function suggestClosestItems(query='', k=3, threshold=0.28) {
  const scored = ITEMS.map(it => ({
    it,
    s: Math.max(scoreName(query, it.name), scoreName(query, String(it.id)))
  }));
  scored.sort((a,b) => b.s - a.s);
  return scored.filter(x => x.s >= threshold).slice(0, k).map(x => x.it);
}
function findInvalidRequestedItems(order) {
  return (order?.items || []).filter(x => !findItemByNameOrId(x.id || x.nombre || x.name));
}

/* ——— Utils varias ——— */
const onlyDigits = s => (s || '').replace(/\D+/g, '');
const toE164 = s => {
  if (!s) return '';
  const t = String(s).trim();
  if (t.startsWith('+')) return t;
  const d = onlyDigits(t);
  return d ? `+${d}` : '';
};
function whats(nE164) { return `whatsapp:${nE164.replace(/^whatsapp:/i, '').trim()}`; }
function extractJSONBlock(text='') {
  const m = text.match(/@@JSON@@([\s\S]*?)@@END@@/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
function stripJSONBlock(text='') {
  return text.replace(/@@JSON@@[\s\S]*?@@END@@/g, '').trim();
}
function summarizeCatalog(cat, maxLines = 120) {
  const lines = [];
  (cat.categories || []).forEach(c => {
    (c.items || []).forEach(i => {
      const p = (i.price != null) ? ` - ${cat.currency || 'COP'} ${i.price}` : '';
      lines.push(`${i.id}: ${i.name}${p}`);
    });
  });
  return lines.slice(0, maxLines).join('\n');
}

/* =========================
 * Prompt system (ordering)
 * ========================= */
function buildSystemPrompt() {
  return `Eres un agente de voz en español para tomar pedidos del catálogo.
- Responde SIEMPRE breve y natural (apto para TTS, 1-2 frases).
- Pide confirmaciones cuando falte información.
- Si el usuario quiere humano o no puedes resolver, responde exactamente: HANDOFF.

[Catálogo vigente]
${summarizeCatalog(CATALOG)}

[FORMATO ESTRICTO]
Devuelve SIEMPRE dos partes:
1) Mensaje corto para el cliente.
2) Bloque JSON en NUEVA línea, exactamente así:
@@JSON@@
{
  "intencion": "pedido|consulta|otro",
  "items": [ { "id": "ID o null", "nombre": "texto", "cantidad": 1, "notas": "" } ],
  "delivery": { "direccion": "" },
  "pago": { "metodo": "" },
  "confirmado": false
}
@@END@@

Reglas:
- Usa IDs del catálogo cuando los reconozcas.
- Si no hay pedido claro, "intencion":"consulta" y "items":[].
- No inventes productos ni precios.
- Si un producto no existe en el catálogo, sugiere 2–3 alternativas del catálogo y pregunta cuál desea.`;
}

/* =========================
 * Sesiones por llamada
 * ========================= */
const sessions = new Map();
/** session = { mode: 'menu'|'ordering', greeted, awaiting_confirmation, invalid_turns, order, history[] } */
function getSession(callSid = 'ANON') {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      mode: 'menu',
      greeted: false,
      awaiting_confirmation: false,
      invalid_turns: 0,
      order: null,
      history: [{ role: 'system', content: buildSystemPrompt() }]
    });
  }
  return sessions.get(callSid);
}
function needsHandoff(text = '') {
  const t = (text || '').toLowerCase();
  return t.includes('handoff') || t.includes('humano') || t.includes('agente') || t.includes('asesor');
}

/* =========================
 * WhatsApp / SMS
 * ========================= */
async function sendMenuToUser(toE164) {
  const to = toE164.replace(/^whatsapp:/i, '').trim();
  const body = MENU_URL
    ? `Aquí tienes nuestro menú: ${MENU_URL}`
    : `Menú de ejemplo:
- Artículos del catálogo
- Responde este chat o vuelve a llamar para ordenar`;

  // Intentar WhatsApp
  try {
    if (!WHATSAPP_FROM) throw new Error('TWILIO_WHATSAPP_FROM vacío');
    const wa = await twilioClient.messages.create({
      from: whats(WHATSAPP_FROM),
      to:   whats(to),
      body
    });
    return { ok: true, via: 'whatsapp', sid: wa.sid };
  } catch (e) {
    // Fallback a SMS
    if (SMS_FROM) {
      try {
        const sms = await twilioClient.messages.create({ from: SMS_FROM, to, body });
        return { ok: true, via: 'sms', sid: sms.sid };
      } catch (e2) {
        return { ok: false, via: 'none', error: e2?.message || String(e2) };
      }
    }
    return { ok: false, via: 'none', error: e?.message || String(e) };
  }
}

/* =========================
 * Voz: flujo principal
 * ========================= */
app.all('/voice', (req, res) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || 'ANON';
  const session = getSession(callSid);
  const continuing = req.query?.cont === '1';
  const vr = new VoiceResponse();

  if (session.mode === 'ordering') {
    // Modo tomar pedido (IA)
    const gather = vr.gather({
      input: 'speech',
      action: '/process-speech',
      method: 'POST',
      language: STT_LANG,
      speechTimeout: 'auto',
      bargeIn: true
    });
    if (!continuing && !session.greeted) {
      gather.say({ voice: TTS_VOICE }, 'Perfecto, tomaré tu pedido. ¿Qué deseas ordenar?');
      session.greeted = true;
    }
    vr.redirect({ method: 'POST' }, '/process-speech');
    return res.type('text/xml').send(vr.toString());
  }

  // Modo menú
  const gather = vr.gather({
    input: 'dtmf speech',
    numDigits: 1,
    action: '/menu-select',
    method: 'POST',
    language: STT_LANG,
    speechTimeout: 'auto',
    bargeIn: true
  });

  if (!continuing && !session.greeted) {
    gather.say({ voice: TTS_VOICE },
      'Hola, bienvenido a Nexus 360. ' +
      'Marca 1 o di tomar pedido. ' +
      'Marca 2 o di enviar menú. ' +
      'Marca 3 o di hablar con un asesor.'
    );
    session.greeted = true;
  } else {
    gather.say({ voice: TTS_VOICE },
      'Opciones: 1 tomar pedido, 2 enviar menú por WhatsApp, 3 hablar con un asesor.'
    );
  }

  vr.redirect({ method: 'POST' }, '/menu-select');
  res.type('text/xml').send(vr.toString());
});

/* =========================
 * Menú: selección 1/2/3
 * ========================= */
app.post('/menu-select', async (req, res) => {
  const callSid   = req.body?.CallSid || 'ANON';
  const digits    = (req.body?.Digits || '').trim();
  const speechRaw = (req.body?.SpeechResult || '').toLowerCase().trim();
  const fromRaw   = (req.body?.From || '').replace(/^whatsapp:/i, '').trim();
  const fromE164  = toE164(fromRaw) || TEST_TO_E164;

  const session = getSession(callSid);
  const vr = new VoiceResponse();

  const isOrder = digits === '1' || /(tomar pedido|hacer pedido|pedido|orden|ordenar|comprar)/i.test(speechRaw);
  const isMenu  = digits === '2' || /(enviar menú|mandar menú|menú|menu|whatsapp)/i.test(speechRaw);
  const isAgent = digits === '3' || /(asesor|agente|humano|vendedor|hablar con un asesor|transferir)/i.test(speechRaw);

  if (isOrder) {
    session.mode = 'ordering';
    vr.say({ voice: TTS_VOICE }, 'Perfecto. Seguimos en la llamada. ¿Qué deseas ordenar?');
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());
  }

  if (isMenu) {
    try {
      const result = await sendMenuToUser(fromE164);
      if (!result?.ok) {
        vr.say({ voice: TTS_VOICE }, 'No pude enviar el menú automáticamente.');
      }
    } catch (err) {
      console.error('[sendMenu error]', err?.message || err);
      vr.say({ voice: TTS_VOICE }, 'Tuve un problema al enviar el menú.');
    }

    // Pregunta: seguir o asesor
    const ask = vr.gather({
      input: 'dtmf speech',
      numDigits: 1,
      action: '/post-menu-choice',
      method: 'POST',
      language: STT_LANG,
      speechTimeout: 'auto',
      bargeIn: true
    });
    ask.say(
      { voice: TTS_VOICE },
      'Te envié el menú por WhatsApp. ' +
      '¿Deseas seguir en la llamada o prefieres hablar con un asesor? ' +
      'Marca 1 o di: seguir en la llamada. ' +
      'Marca 2 o di: hablar con un asesor.'
    );
    vr.redirect({ method: 'POST' }, '/post-menu-choice');
    return res.type('text/xml').send(vr.toString());
  }

  if (isAgent) {
    if (FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Te transfiero con un asesor. Un momento, por favor.');
      vr.dial().number(FALLBACK_NUMBER);
    } else {
      vr.say({ voice: TTS_VOICE }, 'Ahora no puedo transferirte. ¿Quieres que tome tu pedido aquí?');
      session.mode = 'ordering';
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
    }
    return res.type('text/xml').send(vr.toString());
  }

  // Repetir menú si no entendí
  const rep = vr.gather({
    input: 'dtmf speech',
    numDigits: 1,
    action: '/menu-select',
    method: 'POST',
    language: STT_LANG,
    speechTimeout: 'auto',
    bargeIn: true
  });
  rep.say({ voice: TTS_VOICE }, 'No te entendí. 1 tomar pedido, 2 enviar menú, 3 hablar con un asesor.');
  vr.redirect({ method: 'POST' }, '/menu-select');
  return res.type('text/xml').send(vr.toString());
});

/* =========================
 * Post menú: seguir o asesor
 * ========================= */
app.post('/post-menu-choice', (req, res) => {
  const callSid   = req.body?.CallSid || 'ANON';
  const digits    = (req.body?.Digits || '').trim();
  const speechRaw = (req.body?.SpeechResult || '').toLowerCase().trim();
  const session   = getSession(callSid);
  const vr = new VoiceResponse();

  const wantContinue =
    digits === '1' ||
    /(seguir en la llamada|seguir|continuar|continuo|quedarme|aquí|aca|si|sí)/i.test(speechRaw);

  const wantAgent =
    digits === '2' ||
    /(hablar con un asesor|asesor|vendedor|agente|humano|transferir|transferencia)/i.test(speechRaw);

  if (wantContinue) {
    session.mode = 'ordering';
    vr.say({ voice: TTS_VOICE }, 'Perfecto, seguimos en la llamada. ¿Cómo te puedo ayudar?');
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());
  }

  if (wantAgent) {
    if (FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Te transfiero con un asesor. Un momento, por favor.');
      vr.dial().number(FALLBACK_NUMBER);
    } else {
      vr.say({ voice: TTS_VOICE }, 'Ahora no puedo transferirte. Seguimos en la llamada. ¿Cómo te puedo ayudar?');
      session.mode = 'ordering';
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
    }
    return res.type('text/xml').send(vr.toString());
  }

  const rep = vr.gather({
    input: 'dtmf speech',
    numDigits: 1,
    action: '/post-menu-choice',
    method: 'POST',
    language: STT_LANG,
    speechTimeout: 'auto',
    bargeIn: true
  });
  rep.say(
    { voice: TTS_VOICE },
    'No te entendí. Marca 1 o di: seguir en la llamada. Marca 2 o di: hablar con un asesor.'
  );
  vr.redirect({ method: 'POST' }, '/post-menu-choice');
  return res.type('text/xml').send(vr.toString());
});

/* =========================
 * IA (ordering): extracción + validación + sugerencias + confirmación
 * ========================= */

// Log ligero de ítems desconocidos para que los revises luego
const unknownItemsLog = []; // { when, from, name, cantidad }
app.get('/admin/unknown', (req, res) => {
  if (TEST_TOKEN && req.query.token !== TEST_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  res.json(unknownItemsLog);
});

app.post('/process-speech', async (req, res) => {
  const { CallSid, SpeechResult } = req.body || {};
  const heard   = (SpeechResult || '').trim();
  const callSid = CallSid || 'ANON';
  const session = getSession(callSid);
  const vr = new VoiceResponse();

  if (!heard) {
    vr.say({ voice: TTS_VOICE }, 'No te escuché bien. ¿Puedes repetir, por favor?');
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());
  }

  // Confirmación express (sí/no) si ya preguntamos
  if (session.awaiting_confirmation) {
    const yes = /\b(s[ií]|claro|correcto|confirmo|dale|est[aá] bien|sí confirmo)\b/i.test(heard);
    const no  = /\b(no|cancela|mejor no|modificar|cambiar)\b/i.test(heard);

    if (yes) {
      const priced = session.order?.priced;
      const resumen = priced?.items?.filter(i => i.valido).map(i => `${i.cantidad} x ${i.nombre}`).join(', ') || '';
      const total = priced?.subtotal || 0;
      vr.say({ voice: TTS_VOICE }, `Perfecto, pedido confirmado: ${resumen}. Total ${total} ${CURRENCY}. ¡Gracias por tu compra! Hasta luego.`);
      vr.hangup();
      sessions.delete(callSid);
      return res.type('text/xml').send(vr.toString());
    }
    if (no) {
      session.awaiting_confirmation = false;
      vr.say({ voice: TTS_VOICE }, 'Entendido. ¿Qué te gustaría cambiar del pedido?');
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
      return res.type('text/xml').send(vr.toString());
    }
    // si ambiguo, que la IA aclare
  }

  try {
    session.history.push({ role: 'user', content: heard });

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 240,
      messages: session.history.slice(-16)
    });

    const raw   = (completion.choices?.[0]?.message?.content || '').trim() || '¿Podrías repetir, por favor?';
    const json  = extractJSONBlock(raw);
    const aiTts = stripJSONBlock(raw);
    session.history.push({ role: 'assistant', content: raw });

    // Transferencia a humano si aplica
    if (needsHandoff(aiTts) && FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Te transfiero con un asesor humano. Un momento, por favor.');
      vr.dial().number(FALLBACK_NUMBER);
      return res.type('text/xml').send(vr.toString());
    }

    // Si el modelo no devolvió JSON, conversa normal
    if (!json) {
      vr.say({ voice: TTS_VOICE }, aiTts);
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
      return res.type('text/xml').send(vr.toString());
    }

    // Validación contra catálogo
    const priced = priceOrder(json);
    const faltan = missingSlots(json);
    session.order = { propuesta: json, priced, confirmado: !!json.confirmado };

    // Detecta inválidos y propone alternativas
    const invalid = findInvalidRequestedItems(json);
    if (invalid.length) {
      session.invalid_turns = (session.invalid_turns || 0) + 1;

      // Log admin
      const fromE164 = (req.body?.From || '').replace(/^whatsapp:/i, '').trim();
      for (const inv of invalid) {
        unknownItemsLog.push({
          when: new Date().toISOString(),
          from: fromE164 || null,
          name: inv.nombre || inv.name || inv.id || '',
          cantidad: inv.cantidad || 1
        });
      }

      // Sugerencias por cada inválido
      const sugMsgs = invalid.map(inv => {
        const q = inv.nombre || inv.name || inv.id || '';
        const sug = suggestClosestItems(q, 3).map(i => `${i.name} (ID ${i.id})`).join(', ');
        return sug ? `Para "${q}", opciones: ${sug}.` : `No encontré alternativas cercanas para "${q}".`;
      }).join(' ');

      if (session.invalid_turns >= 2) {
        vr.say({ voice: TTS_VOICE },
          `${aiTts} No encontré algunos productos en el catálogo. ${sugMsgs} ` +
          `Si quieres, puedo enviarte el menú por WhatsApp o transferirte con un asesor. ` +
          `Di "enviar menú" o "asesor".`
        );
        vr.redirect({ method: 'POST' }, '/voice?cont=1');
        return res.type('text/xml').send(vr.toString());
      }

      // Primer intento inválido → pedir alternativa
      vr.say({ voice: TTS_VOICE },
        `${aiTts} No encontré algunos productos en el catálogo. ${sugMsgs} ` +
        `¿Cuál de esas opciones prefieres?`
      );
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
      return res.type('text/xml').send(vr.toString());
    }

    // Faltan datos (cantidades, etc.)
    if (faltan.length) {
      const hint = priced.items.filter(i => i.valido).map(i => `${i.cantidad || 1} x ${i.nombre || ''}`.trim()).join(', ');
      const texto = hint
        ? `${aiTts} Hasta ahora tengo: ${hint}. Me falta: ${faltan.join(', ')}.`
        : `${aiTts} Para continuar, necesito: ${faltan.join(', ')}.`;
      vr.say({ voice: TTS_VOICE }, texto);
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
      return res.type('text/xml').send(vr.toString());
    }

    // Todo válido → resumen + confirmación
    const resumen = priced.items.filter(i => i.valido).map(i => `${i.cantidad} x ${i.nombre}`).join(', ');
    const total = priced.subtotal;
    session.awaiting_confirmation = true;

    vr.say({ voice: TTS_VOICE }, `${aiTts} Tengo: ${resumen}. El total es ${total} ${CURRENCY}. ¿Confirmas el pedido?`);
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());

  } catch (err) {
    const status = err?.status || err?.response?.status;
    const data   = err?.response?.data;
    console.error('[AI error]', { status, message: err?.message, data });

    if (status === 429 && FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Nuestro asistente no está disponible. Te transfiero con un asesor.');
      vr.dial().number(FALLBACK_NUMBER);
    } else {
      vr.say({ voice: TTS_VOICE }, `Tuve un problema técnico, pero alcancé a escuchar: ${heard}. ¿Quieres continuar?`);
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
    }
    return res.type('text/xml').send(vr.toString());
  }
});

/* =========================
 * Status / Health
 * ========================= */
app.post('/status', (req, res) => {
  const { CallSid, CallStatus } = req.body || {};
  console.log('[STATUS]', CallSid, CallStatus);
  res.sendStatus(200);
});
app.get('/', (_req, res) => res.send('Nexus 360 OK'));

/* =========================
 * Admin / Testing
 * ========================= */
// Ver catálogo cargado (debug)
app.get('/catalog.json', (_req, res) => res.json(CATALOG));

// Envío de WhatsApp / SMS de prueba
// GET /wa/test?to=+573115601472&token=XXXX
app.get('/wa/test', async (req, res) => {
  try {
    if (TEST_TOKEN && req.query.token !== TEST_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const to = toE164(req.query.to || TEST_TO_E164);
    const result = await sendMenuToUser(to);
    res.json({ ok: !!result?.ok, via: result?.via || null, sid: result?.sid || null, to });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Test de OpenAI
app.get('/ai-test', async (_req, res) => {
  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'Responde con: OK' }],
      temperature: 0
    });
    res.json({ ok: true, text: r.choices?.[0]?.message?.content || '' });
  } catch (e) {
    res.status(500).json({
      ok: false,
      status: e?.status || e?.response?.status,
      message: e?.message,
      data: e?.response?.data || null
    });
  }
});

/* =========================
 * Start
 * ========================= */
app.listen(PORT, () => console.log(`Nexus 360 running on port ${PORT}`));
