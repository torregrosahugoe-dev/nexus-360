import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const { VoiceResponse } = twilio.twiml;

// ===== Config =====
const STT_LANG  = process.env.STT_LANG  || 'es-ES';
const TTS_VOICE = process.env.TTS_VOICE || 'Polly.Miguel';

const FALLBACK_NUMBER      = (process.env.FALLBACK_NUMBER || '').trim();           // para transferir a asesor
const TWILIO_WHATSAPP_FROM = (process.env.TWILIO_WHATSAPP_FROM || '').trim();     // ej +14155238886 (sandbox)
const TWILIO_SMS_FROM      = (process.env.TWILIO_SMS_FROM || '').trim();          // opcional, E.164
const MENU_URL             = (process.env.MENU_URL || '').trim();                 // link al menú
const TEST_TOKEN           = (process.env.TEST_TOKEN || '').trim();
const PORT                 = process.env.PORT || 3000;

// ===== Twilio REST client =====
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ===== OpenAI =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ===== Memoria por llamada =====
/**
 * session = {
 *   greeted: boolean,
 *   mode: 'menu' | 'ordering',
 *   history: OpenAI messages[]
 * }
 */
const sessions = new Map();
function getSession(callSid = 'ANON') {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      greeted: false,
      mode: 'menu',
      history: [
        {
          role: 'system',
          content:
`Eres un agente de voz en español para pedidos y consultas.
- Responde breve y natural (apto para TTS).
- Pide confirmaciones cuando haga falta.
- Si el usuario pide humano o no puedes resolverlo, responde exactamente la palabra: HANDOFF.`
        }
      ]
    });
  }
  return sessions.get(callSid);
}

function needsHandoff(text = '') {
  const t = text.toLowerCase();
  return t.includes('handoff') || t.includes('humano') || t.includes('agente') || t.includes('asesor');
}

// ===== Utilidades =====
const onlyDigits = s => (s || '').replace(/\D+/g, '');
const toE164 = s => {
  if (!s) return '';
  const trimmed = s.trim();
  if (/^\+/.test(trimmed)) return trimmed;
  const digits = onlyDigits(trimmed);
  return digits ? `+${digits}` : '';
};

function whatsAddr(numE164) {
  const n = numE164.replace(/^whatsapp:/i, '').trim();
  return `whatsapp:${n}`;
}

// Enviar menú por WhatsApp (sandbox) con fallback SMS
async function sendMenuToUser(toE164) {
  const to = toE164.replace(/^whatsapp:/i, '').trim();
  const fromWa = toE164 ? whatsAddr(TWILIO_WHATSAPP_FROM) : '';
  const toWa   = whatsAddr(to);
  const text   = MENU_URL
    ? `Aquí tienes nuestro menú: ${MENU_URL}`
    : `Hola, te comparto nuestro menú. Si necesitas ayuda, responde a este chat o vuelve a llamar.`;

  // Intento por WhatsApp
  try {
    if (!TWILIO_WHATSAPP_FROM) throw new Error('TWILIO_WHATSAPP_FROM vacío');
    const msg = await twilioClient.messages.create({
      from: fromWa,  // 'whatsapp:+14155238886'
      to: toWa,      // 'whatsapp:+57311...'
      body: text
    });
    return { ok: true, via: 'whatsapp', sid: msg.sid };
  } catch (e) {
    // Fallback a SMS si está configurado
    if (TWILIO_SMS_FROM) {
      try {
        const sms = await twilioClient.messages.create({
          from: TWILIO_SMS_FROM,
          to,
          body: text
        });
        return { ok: true, via: 'sms', sid: sms.sid };
      } catch (smsErr) {
        return { ok: false, via: 'none', error: smsErr?.message || String(smsErr) };
      }
    }
    return { ok: false, via: 'none', error: e?.message || String(e) };
  }
}

// ===== Menú / Inicio de llamada =====
app.all('/voice', (req, res) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || 'ANON';
  const session = getSession(callSid);
  const continuing = req.query?.cont === '1';
  const vr = new VoiceResponse();

  if (session.mode === 'ordering') {
    // Ya en modo tomar pedido -> solo escuchar al cliente
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

  // Si no responde, reintenta menú
  vr.redirect({ method: 'POST' }, '/menu-select');
  res.type('text/xml').send(vr.toString());
});

// ===== Selección del menú =====
app.post('/menu-select', async (req, res) => {
  const callSid   = req.body?.CallSid || 'ANON';
  const fromRaw   = (req.body?.From || '').replace(/^whatsapp:/i, '').trim(); // podría venir 'whatsapp:+57...'
  const fromE164  = toE164(fromRaw);
  const digits    = (req.body?.Digits || '').trim();
  const speechRaw = (req.body?.SpeechResult || '').toLowerCase().trim();

  const vr = new VoiceResponse();
  const session = getSession(callSid);

  const isOrder =
    digits === '1' ||
    /(tomar pedido|hacer pedido|pedido|orden|ordenar|comprar)/i.test(speechRaw);

  const isMenu =
    digits === '2' ||
    /(enviar menú|mandar menú|menú|menu|whatsapp)/i.test(speechRaw);

  const isAgent =
    digits === '3' ||
    /(asesor|agente|humano|vendedor|hablar con un asesor|transferir)/i.test(speechRaw);

  // 1) Tomar pedido
  if (isOrder) {
    session.mode = 'ordering';
    vr.say({ voice: TTS_VOICE }, 'Perfecto. Seguimos en la llamada. ¿Qué deseas ordenar?');
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());
  }

  // 2) Enviar menú y luego preguntar si sigue o asesor
  if (isMenu) {
    try {
      const result = await sendMenuToUser(fromE164 || '+573115601472'); // fallback para pruebas
      if (!result?.ok) {
        vr.say({ voice: TTS_VOICE }, 'No pude enviar el menú automáticamente.');
      }
    } catch (err) {
      console.error('[sendMenu error]', err?.message || err);
      vr.say({ voice: TTS_VOICE }, 'Tuve un problema al enviar el menú.');
    }

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

  // 3) Asesor
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

  // No entendido -> repetir menú
  const rep = vr.gather({
    input: 'dtmf speech',
    numDigits: 1,
    action: '/menu-select',
    method: 'POST',
    language: STT_LANG,
    speechTimeout: 'auto',
    bargeIn: true
  });
  rep.say({ voice: TTS_VOICE }, 'No te entendí. Marca 1 para tomar pedido, 2 para enviar menú, 3 para hablar con un asesor.');
  vr.redirect({ method: 'POST' }, '/menu-select');
  return res.type('text/xml').send(vr.toString());
});

// ===== Después de enviar menú: seguir en llamada o asesor =====
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

  // Repreguntar
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
    'No te entendí. ' +
    'Marca 1 o di: seguir en la llamada. ' +
    'Marca 2 o di: hablar con un asesor.'
  );
  vr.redirect({ method: 'POST' }, '/post-menu-choice');
  return res.type('text/xml').send(vr.toString());
});

// ===== ChatGPT: procesar voz cuando estamos en "ordering" =====
app.post('/process-speech', async (req, res) => {
  const { CallSid, SpeechResult } = req.body || {};
  const heard   = (SpeechResult || '').trim();
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

    // handoff a humano si aplica
    if (needsHandoff(aiText) && FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Te transfiero con un asesor humano. Un momento, por favor.');
      vr.dial().number(FALLBACK_NUMBER);
      return res.type('text/xml').send(vr.toString());
    }

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
      vr.say({ voice: TTS_VOICE }, 'Nuestro asistente no está disponible. Te transfiero con un asesor.');
      vr.dial().number(FALLBACK_NUMBER);
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

// ===== Test de WhatsApp / SMS =====
app.get('/wa/test', async (req, res) => {
  try {
    if (TEST_TOKEN && req.query.token !== TEST_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const to = toE164(req.query.to || '+573115601472');
    const result = await sendMenuToUser(to);
    res.json({ ok: !!result.ok, via: result.via, sid: result.sid || null, to });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

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

app.listen(PORT, () => console.log(`Nexus 360 running on port ${PORT}`));
