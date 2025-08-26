import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const { VoiceResponse } = twilio.twiml;

// ===== Config =====
const STT_LANG         = process.env.STT_LANG         || 'es-ES';
const TTS_VOICE        = process.env.TTS_VOICE        || 'Polly.Miguel';
const FALLBACK_NUMBER  = process.env.FALLBACK_NUMBER  || '';  // para opción 3
const TWILIO_SMS_FROM  = process.env.TWILIO_SMS_FROM  || '';  // ej: +1XXXXXXXXXX (opcional)
const WHATSAPP_FROM    = process.env.TWILIO_WHATSAPP_FROM || ''; // ej: +14155238886 (opcional)
const MENU_URL         = process.env.MENU_URL || '';          // link a tu menú (opcional)
const PORT             = process.env.PORT || 3000;

// Twilio REST client (para WhatsApp/SMS en la opción 2)
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ===== OpenAI =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ===== Memoria por llamada =====
const sessions = new Map();
function getSession(callSid = 'ANON') {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      greeted: false,
      menuDone: false,     // <— NUEVO: ya eligió una opción del menú inicial
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
  const t = text.toLowerCase();
  return t.includes('handoff') || t.includes('humano') || t.includes('agente');
}

function sayMenuText(vr) {
  // Texto corregido y claro (voz y DTMF)
  // “Bienvenida”, “WhatsApp”, “vendedor” con ortografía correcta.
  vr.say({ voice: TTS_VOICE },
    'Hola, bienvenido a Nexus 360. ' +
    'Elige una opción: ' +
    'Para tomar tu pedido, di "pedido" o marca 1. ' +
    'Para que te envíe el menú por WhatsApp, di "WhatsApp" o marca 2. ' +
    'Para hablar con un vendedor, di "vendedor" o marca 3.'
  );
}

// ===== Helpers: envío de menú por WhatsApp/SMS =====
async function sendMenuToUser(toE164) {
  const body = MENU_URL && MENU_URL.trim().length > 0
    ? `Aquí tienes nuestro menú: ${MENU_URL}`
    : `Menú de ejemplo:\n- Sándwich de pollo\n- Sándwich de pavo\n- Limonada\n(Agrega MENU_URL en Config Vars para enviar un link)`;

  // Intento WhatsApp primero (si está configurado)
  if (WHATSAPP_FROM) {
    try {
      await client.messages.create({
        from: `whatsapp:${WHATSAPP_FROM}`,
        to:   `whatsapp:${toE164}`,
        body
      });
      return 'whatsapp';
    } catch (e) {
      console.error('[WhatsApp send error]', e?.message || e);
      // continúa con SMS
    }
  }
  // SMS fallback (si está configurado)
  if (TWILIO_SMS_FROM) {
    try {
      await client.messages.create({
        from: TWILIO_SMS_FROM,
        to:   toE164,
        body
      });
      return 'sms';
    } catch (e) {
      console.error('[SMS send error]', e?.message || e);
    }
  }
  return null;
}

// ===== /voice: MENÚ inicial y, luego, conversación =====
app.all('/voice', (req, res) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || 'ANON';
  const session = getSession(callSid);
  const continuing = req.query?.cont === '1' || session.greeted;

  const vr = new VoiceResponse();

  // Si aún no eligió en el menú, mostramos menú (voz + DTMF)
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
    // Si no dijo nada, igual saltamos a evaluar (para repreguntar)
    vr.redirect({ method: 'POST' }, '/menu-select');
    session.greeted = true;
    return res.type('text/xml').send(vr.toString());
  }

  // ===== Conversación normal (tu flujo actual) =====
  const gather = vr.gather({
    input: 'speech',
    action: '/process-speech',
    method: 'POST',
    language: STT_LANG,
    speechTimeout: 'auto',
    bargeIn: true
  });

  if (!continuing) {
    // Primer turno luego del menú (o si alguien entra directo acá)
    gather.say({ voice: TTS_VOICE }, 'Te escucho, ¿qué deseas ordenar o consultar?');
    session.greeted = true;
  }
  vr.redirect({ method: 'POST' }, '/process-speech');
  res.type('text/xml').send(vr.toString());
});

// ===== /menu-select: procesa 1/2/3 o intentos por voz =====
app.post('/menu-select', async (req, res) => {
  const callSid = req.body?.CallSid || 'ANON';
  const fromE164 = (req.body?.From || '').replace(/^whatsapp:/, ''); // llamada = +57..., (por si acaso)
  const digits = (req.body?.Digits || '').trim();
  const speech = (req.body?.SpeechResult || '').toLowerCase();
  const session = getSession(callSid);

  const vr = new VoiceResponse();

  // Normaliza elección (voz o DTMF)
  let opt = null;
  if (digits === '1' || /pedido|orden|pedir/.test(speech)) opt = 'order';
  else if (digits === '2' || /whats?app|men[úu]/.test(speech)) opt = 'menu';
  else if (digits === '3' || /vendedor|humano|asesor/.test(speech)) opt = 'agent';

  if (opt === 'order') {
    session.menuDone = true;
    vr.say({ voice: TTS_VOICE }, 'Perfecto. Tomo tu pedido. ¿Qué deseas ordenar?');
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());
  }

  if (opt === 'menu') {
    try {
      const sentVia = await sendMenuToUser(fromE164);
      if (sentVia === 'whatsapp') {
        vr.say({ voice: TTS_VOICE }, 'Te envié el menú por WhatsApp. ¿Quieres que tome tu pedido ahora?');
      } else if (sentVia === 'sms') {
        vr.say({ voice: TTS_VOICE }, 'No pude usar WhatsApp. Te envié el menú por SMS. ¿Quieres que tome tu pedido ahora?');
      } else {
        vr.say({ voice: TTS_VOICE }, 'No pude enviar el menú automáticamente. Si quieres, puedo tomar tu pedido por aquí. ¿Deseas continuar?');
      }
    } catch (e) {
      console.error('[menu send error]', e?.message || e);
      vr.say({ voice: TTS_VOICE }, 'Tuve un problema al enviar el menú. ¿Quieres que tome tu pedido por aquí?');
    }
    // Después de enviar (o fallar), ofrecemos seguir con la conversación
    session.menuDone = true;
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());
  }

  if (opt === 'agent') {
    if (FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Te transfiero con un vendedor. Un momento, por favor.');
      vr.dial().number(FALLBACK_NUMBER);
    } else {
      vr.say({ voice: TTS_VOICE }, 'En este momento no puedo transferirte a un vendedor. ¿Quieres que tome tu pedido por aquí?');
      session.menuDone = true;
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
    }
    return res.type('text/xml').send(vr.toString());
  }

  // No entendí → repetir menú de forma clara
  const gather = vr.gather({
    input: 'dtmf speech',
    numDigits: 1,
    action: '/menu-select',
    method: 'POST',
    language: STT_LANG,
    speechTimeout: 'auto',
    bargeIn: true
  });
  gather.say({ voice: TTS_VOICE }, 'No te entendí. ' +
    'Para tomar tu pedido di "pedido" o marca 1. ' +
    'Para enviar el menú por WhatsApp di "WhatsApp" o marca 2. ' +
    'Para hablar con un vendedor di "vendedor" o marca 3.'
  );
  vr.redirect({ method: 'POST' }, '/menu-select');
  return res.type('text/xml').send(vr.toString());
});

// ===== Procesar voz + IA (tu flujo actual) =====
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
      // max_tokens: 200,
      messages: session.history.slice(-16)
    });

    const aiText = (completion.choices?.[0]?.message?.content || '').trim() || '¿Podrías repetir, por favor?';
    session.history.push({ role: 'assistant', content: aiText });

    // Handoff a humano si aplica
    if (needsHandoff(aiText) && FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Te transfiero con un asesor humano. Un momento, por favor.');
      const dial = vr.dial();
      dial.number(FALLBACK_NUMBER);
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
      const dial = vr.dial();
      dial.number(FALLBACK_NUMBER);
    } else {
      vr.say({ voice: TTS_VOICE }, `Tuve un problema técnico, pero alcancé a escuchar: ${heard}. ¿Quieres continuar?`);
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
    }
    return res.type('text/xml').send(vr.toString());
  }
});

// ===== Status callback =====
app.post('/status', (req, res) => {
  const { CallSid, CallStatus } = req.body || {};
  console.log('[STATUS]', CallSid, CallStatus);
  res.sendStatus(200);
});

// ===== Health =====
app.get('/', (_req, res) => res.send('Nexus 360 OK'));

// ===== Test de OpenAI =====
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

// Normaliza FROMs para evitar errores de tipado
const WHATSAPP_FROM = (process.env.TWILIO_WHATSAPP_FROM || '')
  .replace(/^whatsapp:/i, '')
  .replace(/^:/, '')
  .trim();
const TWILIO_SMS_FROM = (process.env.TWILIO_SMS_FROM || '').trim();


app.listen(PORT, () => console.log(`Nexus 360 running on port ${PORT}`));
