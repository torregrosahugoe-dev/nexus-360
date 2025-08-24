import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio envía x-www-form-urlencoded
app.use(express.json());

const { VoiceResponse } = twilio.twiml;

// ===== Config =====
const STT_LANG        = process.env.STT_LANG        || 'es-ES';
const TTS_VOICE       = process.env.TTS_VOICE       || 'Polly.Miguel';
const FALLBACK_NUMBER = process.env.FALLBACK_NUMBER || '';
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

// ===== Saludo + Gather =====
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
  vr.redirect({ method: 'POST' }, '/process-speech'); // si no habló
  res.type('text/xml').send(vr.toString());
});

// Alias por si alguna vez dejaste /ivr en Twilio
app.post('/ivr', (req, res) => { req.url = '/voice'; app._router.handle(req, res); });

// ===== Procesar voz =====
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
    // ===== DIAGNÓSTICO DETALLADO + FALLBACK ELEGANTE =====
    const status = err?.status || err?.response?.status;
    const data   = err?.response?.data;
    console.error('[AI error]', { status, message: err?.message, data });

    // Fallback: responde con eco y sigue, para no cortar la conversación
    vr.say({ voice: TTS_VOICE }, `Tuve un problema técnico, pero alcancé a escuchar: ${heard}. ¿Quieres continuar?`);
    vr.redirect({ method: 'POST' }, '/voice');

    // Si prefieres transferir a humano cuando falle la IA, descomenta:
    /*
    if (FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Tuve un problema. Te transfiero con un asesor.');
      const dial = vr.dial();
      dial.number(FALLBACK_NUMBER);
    } else {
      vr.say({ voice: TTS_VOICE }, 'Tuve un problema técnico. Gracias por llamar.');
      vr.hangup();
    }
    */
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

// ===== Test de OpenAI desde el navegador =====
app.get('/ai-test', async (_req, res) => {
  try {
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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
