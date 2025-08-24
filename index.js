import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio envía x-www-form-urlencoded
app.use(express.json());

const { VoiceResponse } = twilio.twiml;

// ===== Config básica =====
const STT_LANG        = process.env.STT_LANG        || 'es-ES';        // idioma de reconocimiento
const TTS_VOICE       = process.env.TTS_VOICE       || 'Polly.Miguel';  // voz TTS
const FALLBACK_NUMBER = process.env.FALLBACK_NUMBER || '';             // opcional (transferencia a humano)
const PORT            = process.env.PORT || 3000;

// ===== OpenAI =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Memoria por llamada =====
const sessions = new Map();
function getSession(callSid = 'ANON') {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
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

// ===== Webhook principal: saludo + Gather =====
app.all('/voice', (req, res) => {
  const vr = new VoiceResponse();
  const gather = vr.gather({
    input: 'speech',
    action: '/process-speech',
    method: 'POST',
    language: STT_LANG,
    speechTimeout: 'auto',
    bargeIn: true
  });
  gather.say({ voice: TTS_VOICE }, 'Hola, bienvenido a Nexus 360. ¿En qué puedo ayudarte hoy?');

  // Si no habló, pasamos a procesar igualmente:
  vr.redirect({ method: 'POST' }, '/process-speech');
  res.type('text/xml').send(vr.toString());
});

// Alias por si alguna vez dejaste /ivr en Twilio
app.post('/ivr', (req, res) => { req.url = '/voice'; app._router.handle(req, res); });

// ===== Procesa lo que dijo el usuario =====
app.post('/process-speech', async (req, res) => {
  const { CallSid, SpeechResult } = req.body || {};
  const heard = (SpeechResult || '').trim();
  const vr = new VoiceResponse();

  if (!heard) {
    vr.say({ voice: TTS_VOICE }, 'No te escuché bien. ¿Puedes repetir, por favor?');
    vr.redirect({ method: 'POST' }, '/voice');
    return res.type('text/xml').send(vr.toString());
  }

  try {
    const session = getSession(CallSid || 'ANON');
    session.history.push({ role: 'user', content: heard });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
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
    const shouldHangup = end.includes('hasta luego') || end.includes('adiós') ||
                         end.includes('gracias por llamar') || end.includes('cerrar pedido');

    if (shouldHangup) {
      vr.hangup();
      sessions.delete(CallSid);
    } else {
      vr.redirect({ method: 'POST' }, '/voice');
    }

    return res.type('text/xml').send(vr.toString());
  } catch (err) {
    console.error('AI error', err);
    if (FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Tuve un problema. Te transfiero con un asesor.');
      const dial = vr.dial();
      dial.number(FALLBACK_NUMBER);
    } else {
      vr.say({ voice: TTS_VOICE }, 'Tuvimos un problema técnico. Gracias por llamar.');
      vr.hangup();
    }
    return res.type('text/xml').send(vr.toString());
  }
});

// Status callback (para ver estados en logs)
app.post('/status', (req, res) => {
  const { CallSid, CallStatus } = req.body || {};
  console.log('[STATUS]', CallSid, CallStatus);
  res.sendStatus(200);
});

// Healthcheck
app.get('/', (_req, res) => res.send('Nexus 360 OK'));

app.listen(PORT, () => console.log(`Nexus 360 running on port ${PORT}`));
