import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const { VoiceResponse } = twilio.twiml;

// ===== Config =====
const STT_LANG        = process.env.STT_LANG        || 'es-ES';
const TTS_VOICE       = process.env.TTS_VOICE       || 'Polly.Miguel';
const FALLBACK_NUMBER = process.env.FALLBACK_NUMBER || '';
const PORT            = process.env.PORT || 3000;

// ===== OpenAI =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ===== Memoria por llamada =====
const sessions = new Map();
function getSession(callSid = 'ANON') {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      greeted: false, // <--- NUEVO: para no repetir el saludo
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

// ===== Saludo + Gather (sin repetir el "Hola" en vueltas siguientes) =====
app.all('/voice', (req, res) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || 'ANON';
  const session = getSession(callSid);

  const continuing = req.query?.cont === '1' || session.greeted; // si vuelve del loop
  const vr = new VoiceResponse();

  const gather = vr.gather({
    input: 'speech',
    action: '/process-speech',
    method: 'POST',
    language: STT_LANG,
    speechTimeout: 'auto',
    bargeIn: true
  });

  if (!continuing) {
    // Primer turno: saludo completo
    gather.say({ voice: TTS_VOICE }, 'Hola, bienvenido a Nexus 360. ¿En qué puedo ayudarte hoy?');
    session.greeted = true;
  } else {
    // Vueltas siguientes: sin saludo largo (puedes dejarlo en silencio o breve "Te escucho")
    // gather.say({ voice: TTS_VOICE }, 'Te escucho.');
  }

  // Si no habló, procesa de todas formas (Twilio redirige)
  vr.redirect({ method: 'POST' }, '/process-speech');
  res.type('text/xml').send(vr.toString());
});

// Alias por si alguna vez dejaste /ivr en Twilio
app.post('/ivr', (req, res) => { req.url = '/voice'; app._router.handle(req, res); });

// ===== Procesar voz + IA =====
app.post('/process-speech', async (req, res) => {
  const { CallSid, SpeechResult } = req.body || {};
  const heard = (SpeechResult || '').trim();
  const callSid = CallSid || 'ANON';
  const vr = new VoiceResponse();

  if (!heard) {
    vr.say({ voice: TTS_VOICE }, 'No te escuché bien. ¿Puedes repetir, por favor?');
    vr.redirect({ method: 'POST' }, '/voice?cont=1'); // <--- vuelve como continuación
    return res.type('text/xml').send(vr.toString());
  }

  try {
    const session = getSession(callSid);
    session.history.push({ role: 'user', content: heard });

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      // max_tokens: 200, // opcional para acotar costo
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

    // Responder y decidir si co
