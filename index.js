// index.js
import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* =========================
 * Twilio: cliente y TwiML
 * ========================= */
const { VoiceResponse } = twilio.twiml;
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

/* =========================
 * Configuración (env)
 * ========================= */
const PORT              = process.env.PORT || 3000;
const STT_LANG          = process.env.STT_LANG || 'es-ES';
const TTS_VOICE         = process.env.TTS_VOICE || 'Polly.Miguel';
const FALLBACK_NUMBER   = (process.env.FALLBACK_NUMBER || '').trim(); // para transferir al vendedor

// Mensajería
const WHATSAPP_FROM = (process.env.TWILIO_WHATSAPP_FROM || '+14155238886') // sandbox por defecto
  .replace(/^whatsapp:/i, '')
  .replace(/^:/, '')
  .trim();
const SMS_FROM      = (process.env.TWILIO_SMS_FROM || '').trim();          // número Twilio con SMS
const MENU_URL      = (process.env.MENU_URL || '').trim();

// Tests (opcionales)
const TEST_TO_E164  = (process.env.TEST_TO_E164 || '+573115601472').trim(); // por si pruebas manuales
const TEST_TOKEN    = (process.env.TEST_TOKEN || '').trim();                // protege /wa/test

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/* =========================
 * Memoria en RAM por llamada
 * ========================= */
const sessions = new Map();
function getSession(callSid = 'ANON') {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      greeted: false,     // ya saludó
      menuDone: false,    // ya eligió una opción del menú inicial
      history: [
        { role: 'system', content:
`Eres un agente de voz en español para pedidos y consultas.
- Responde breve y natural (apto para TTS).
- Pide confirmaciones cuando haga falta.
- Si el usuario pide humano o no puedes resolverlo, responde exactamente la palabra: HANDOFF.` }
      ]
    });
  }
  return sessions.get(callSid);
}

function needsHandoff(text = '') {
  const t = (text || '').toLowerCase();
  return t.includes('handoff') || t.includes('humano') || t.includes('agente') || t.includes('vendedor');
}

/* =========================
 * Helpers de menú y mensajería
 * ========================= */
function sayMenuText(node) {
  node.say({ voice: TTS_VOICE },
    'Hola, bienvenido a Nexus 360. ' +
    'Elige una opción: ' +
    'Para tomar tu pedido, di "pedido" o marca 1. ' +
    'Para que te envíe el menú por WhatsApp, di "WhatsApp" o marca 2. ' +
    'Para hablar con un vendedor, di "vendedor" o marca 3.'
  );
}

async function sendMenuToUser(toE164) {
  const body = MENU_URL
    ? `Aquí tienes nuestro menú: ${MENU_URL}`
    : `Menú de ejemplo:
- Sándwich de pollo
- Sándwich de pavo
- Limonada
(Agrega MENU_URL en Config Vars para enviar un link)`;

  // Intento WhatsApp primero si hay WA FROM
  if (WHATSAPP_FROM) {
    try {
      const msg = await client.messages.create({
        from: `whatsapp:${WHATSAPP_FROM}`,
        to:   `whatsapp:${toE164}`,
        body
      });
      return { via: 'whatsapp', sid: msg.sid };
    } catch (err) {
      // Continúa a SMS
      console.error('[WhatsApp send error]', err?.message || err);
    }
  }
  // SMS como fallback
  if (SMS_FROM) {
    try {
      const sms = await client.messages.create({
        from: SMS_FROM,
        to:   toE164,
        body
      });
      return { via: 'sms', sid: sms.sid };
    } catch (err) {
      console.error('[SMS send error]', err?.message || err);
    }
  }
  return null;
}

/* =========================
 * Rutas de voz (Twilio Voice)
 * ========================= */

// Entrada principal: menú inicial o conversación
app.all('/voice', (req, res) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || 'ANON';
  const session = getSession(callSid);

  const continuing = req.query?.cont === '1' || session.greeted;
  const vr = new VoiceResponse();

  // Si aún no eligió en el menú, mostrar menú (voz + DTMF)
  if (!session.menuDone && !continuing) {
    const gather = vr.gather({
      input: 'dtmf speech',
      numDigits: 1,
      action: '/menu-select',
      method: 'POST',
      language: STT_LANG,
      speechTimeout: 'auto',
      bargeIn: true
    });
    sayMenuText(gather);

    // Si no dijo nada, redirige igual para repreguntar
    vr.redirect({ method: 'POST' }, '/menu-select');
    session.greeted = true;
    return res.type('text/xml').send(vr.toString());
  }

  // Conversación normal con la IA
  const gather = vr.gather({
    input: 'speech',
    action: '/process-speech',
    method: 'POST',
    language: STT_LANG,
    speechTimeout: 'auto',
    bargeIn: true
  });

  if (!continuing) {
    gather.say({ voice: TTS_VOICE }, 'Te escucho, ¿qué deseas ordenar o consultar?');
    session.greeted = true;
  }

  vr.redirect({ method: 'POST' }, '/process-speech');
  return res.type('text/xml').send(vr.toString());
});

// Alias por si en Twilio dejaste /ivr
app.post('/ivr', (req, res) => { req.url = '/voice'; app._router.handle(req, res); });

// Procesa selección de menú
app.post('/menu-select', async (req, res) => {
  const callSid   = req.body?.CallSid || 'ANON';
  const digits    = (req.body?.Digits || '').trim();
  const speechRaw = (req.body?.SpeechResult || '').toLowerCase().trim();
  // From puede venir como whatsapp:+E164; lo normalizamos
  const fromE164  = (req.body?.From || TEST_TO_E164 || '')
    .replace(/^whatsapp:/i, '')
    .trim();

  const session = getSession(callSid);
  const vr = new VoiceResponse();

  // Determina opción del menú
  let opt = null;
  if (digits === '1' || /pedido|orden|pedir/.test(speechRaw)) opt = 'order';
  else if (digits === '2' || /whats?app|men[úu]/.test(speechRaw)) opt = 'menu';
  else if (digits === '3' || /vendedor|humano|asesor/.test(speechRaw)) opt = 'agent';

  if (opt === 'order') {
    session.menuDone = true;
    vr.say({ voice: TTS_VOICE }, 'Perfecto. Tomo tu pedido. ¿Qué deseas ordenar?');
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());
  }

  if (opt === 'menu') {
    try {
      const result = await sendMenuToUser(fromE164);
      if (result?.via === 'whatsapp') {
        vr.say({ voice: TTS_VOICE }, 'Te envié el menú por WhatsApp. ¿Quieres que tome tu pedido ahora?');
      } else if (result?.via === 'sms') {
        vr.say({ voice: TTS_VOICE }, 'No pude usar WhatsApp. Te envié el menú por SMS. ¿Quieres que tome tu pedido ahora?');
      } else {
        vr.say({ voice: TTS_VOICE }, 'No pude enviar el menú automáticamente. Si quieres, puedo tomar tu pedido por aquí. ¿Deseas continuar?');
      }
    } catch (err) {
      console.error('[sendMenu error]', err?.message || err);
      vr.say({ voice: TTS_VOICE }, 'Tuve un problema al enviar el menú. ¿Quieres que tome tu pedido por aquí?');
    }
    session.menuDone = true;
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());
  }

  if (opt === 'agent') {
    if (FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Te transfiero con un vendedor. Un momento, por favor.');
      vr.dial().number(FALLBACK_NUMBER);
    } else {
      vr.say({ voice: TTS_VOICE }, 'No puedo transferirte ahora. ¿Quieres que tome tu pedido por aquí?');
      session.menuDone = true;
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
    }
    return res.type('text/xml').send(vr.toString());
  }

  // No entendido → repetir menú
  const gather = vr.gather({
    input: 'dtmf speech',
    numDigits: 1,
    action: '/menu-select',
    method: 'POST',
    language: STT_LANG,
    speechTimeout: 'auto',
    bargeIn: true
  });
  gather.say({ voice: TTS_VOICE },
    'No te entendí. ' +
    'Para tomar tu pedido di "pedido" o marca 1. ' +
    'Para enviar el menú por WhatsApp di "WhatsApp" o marca 2. ' +
    'Para hablar con un vendedor di "vendedor" o marca 3.'
  );
  vr.redirect({ method: 'POST' }, '/menu-select');
  return res.type('text/xml').send(vr.toString());
});

// Conversación con IA
app.post('/process-speech', async (req, res) => {
  const { CallSid, SpeechResult } = req.body || {};
  const heard = (SpeechResult || '').trim();
  const callSid = CallSid || 'ANON';
  const vr = new VoiceResponse();

  if (!heard) {
    vr.say({ voice: TTS_VOICE }, 'No te escuché bien. ¿Puedes repetir, por favor?');
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());
  }

  try {
    const session = getSession(callSid);
    session.history.push({ role: 'user', content: heard });

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      messages: session.history.slice(-16)
    });

    const aiText = (completion.choices?.[0]?.message?.content || '').trim() || '¿Podrías repetir, por favor?';
    session.history.push({ role: 'assistant', content: aiText });

    // Handoff a humano si aplica
    if (needsHandoff(aiText) && FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Te transfiero con un asesor humano. Un momento, por favor.');
      vr.dial().number(FALLBACK_NUMBER);
      return res.type('text/xml').send(vr.toString());
    }

    // Responder y decidir si cortar o seguir
    vr.say({ voice: TTS_VOICE }, aiText);
    const end = aiText.toLowerCase();
    const shouldHangup =
      end.includes('hasta luego') ||
      end.includes('adiós') ||
      end.includes('gracias por llamar') ||
      end.includes('cerrar pedido');

    if (shouldHangup) {
      vr.hangup();
      sessions.delete(callSid);
    } else {
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
    }

    return res.type('text/xml').send(vr.toString());
  } catch (err) {
    const status = err?.status || err?.response?.status;
    const data   = err?.response?.data;
    console.error('[AI error]', { status, message: err?.message, data });

    if (status === 429 && FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Nuestro asistente inteligente no está disponible. Te transfiero con un asesor humano.');
      vr.dial().number(FALLBACK_NUMBER);
    } else {
      vr.say({ voice: TTS_VOICE }, `Tuve un problema técnico, pero alcancé a escuchar: ${heard}. ¿Quieres continuar?`);
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
    }
    return res.type('text/xml').send(vr.toString());
  }
});

/* =========================
 * Status callback (opcional)
 * ========================= */
app.post('/status', (req, res) => {
  const { CallSid, CallStatus } = req.body || {};
  console.log('[STATUS]', CallSid, CallStatus);
  res.sendStatus(200);
});

/* =========================
 * Health / ai-test / wa-test
 * ========================= */
app.get('/', (_req, res) => res.send('Nexus 360 OK'));

// Prueba de OpenAI
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

// Test seguro de WhatsApp (y SMS fallback)
// GET /wa/test?to=+573115601472&token=XXXX
app.get('/wa/test', async (req, res) => {
  try {
    if (TEST_TOKEN && req.query.token !== TEST_TOKEN) {
      return res.status(401).send('Unauthorized');
    }
    const raw   = (req.query.to || TEST_TO_E164).trim();
    const toE64 = raw.replace(/^whatsapp:/i, '').trim();

    try {
      const msg = await client.messages.create({
        from: `whatsapp:${WHATSAPP_FROM}`,
        to:   `whatsapp:${toE64}`,
        body: '🍔 ¡Hola! Este es un mensaje de prueba del IVR por WhatsApp. Gracias por comunicarte con Nexus 360.'
      });
      return res.json({ ok: true, via: 'whatsapp', sid: msg.sid, to: toE64 });
    } catch (waErr) {
      if (SMS_FROM) {
        const sms = await client.messages.create({
          from: SMS_FROM,
          to:   toE64,
          body: '🍔 Prueba SMS de Nexus 360: si no recibiste por WhatsApp, revisa el opt-in del sandbox.'
        });
        return res.json({ ok: true, via: 'sms', sid: sms.sid, to: toE64, wa_error: waErr?.message || String(waErr) });
      }
      return res.status(500).json({ ok: false, via: 'whatsapp', error: waErr?.message || String(waErr) });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================
 * Arranque
 * ========================= */
app.listen(PORT, () => console.log(`Nexus 360 running on port ${PORT}`));
