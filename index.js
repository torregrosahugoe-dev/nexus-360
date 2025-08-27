// index.js (Nexus 360 con ASR seleccionable: Twilio o Google STT)
import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';

// Google STT
import { SpeechClient } from '@google-cloud/speech';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const { VoiceResponse } = twilio.twiml;

// ===== Config =====
const ASR_PROVIDER    = (process.env.ASR_PROVIDER || 'twilio').toLowerCase(); // 'twilio' | 'google'
const STT_LANG        = process.env.STT_LANG        || 'es-ES';
const TTS_VOICE       = process.env.TTS_VOICE       || 'Polly.Miguel';
const FALLBACK_NUMBER = process.env.FALLBACK_NUMBER || '';
const PORT            = process.env.PORT || 3000;

// ===== OpenAI =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ===== Twilio creds (para descargar grabaciones si usamos Google) =====
const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN  || '';

// ===== Google Speech client (solo si ASR_PROVIDER=google) =====
let gcpSpeech = null;
if (ASR_PROVIDER === 'google') {
  let gCreds = null;
  try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      // JSON directo
      const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
      const parsed = JSON.parse(raw);
      // Asegurar que la private_key tenga saltos reales
      if (parsed.private_key && parsed.private_key.includes('\\n')) {
        parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      }
      gCreds = { credentials: parsed };
    } else if (process.env.GOOGLE_CLOUD_CREDENTIALS_BASE64) {
      // JSON en Base64
      const decoded = Buffer.from(process.env.GOOGLE_CLOUD_CREDENTIALS_BASE64, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (parsed.private_key && parsed.private_key.includes('\\n')) {
        parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      }
      gCreds = { credentials: parsed };
    }
  } catch (e) {
    console.error('[Google creds] Error al parsear credenciales:', e.message);
  }
  gcpSpeech = new SpeechClient(gCreds || undefined);
}

// ===== Memoria por llamada =====
const sessions = new Map();
function getSession(callSid = 'ANON') {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      greeted: false,
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

// ===== Utilitarios =====
function sayAndLoop(vr, text) {
  vr.say({ voice: TTS_VOICE }, text);
  vr.redirect({ method: 'POST' }, '/voice?cont=1');
}

async function processText({ callSid, heard, from }) {
  const session = getSession(callSid);
  session.history.push({ role: 'user', content: heard });

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    messages: session.history.slice(-16)
  });

  const aiText = (completion.choices?.[0]?.message?.content || '').trim() || '¿Podrías repetir, por favor}?';
  session.history.push({ role: 'assistant', content: aiText });
  return aiText;
}

// === Google STT: descarga la grabación y la transcribe ===
async function googleTranscribeFromRecordingUrl(recordingUrl) {
  // Twilio manda RecordingUrl como .../Accounts/AC.../Recordings/RE...
  // el audio se baja con .wav y Basic Auth
  const wavUrl = `${recordingUrl}.wav`;
  const auth = 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64');

  const resp = await fetch(wavUrl, { headers: { Authorization: auth } });
  if (!resp.ok) throw new Error(`No pude descargar la grabación: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const audioBytes = buffer.toString('base64');

  const [stt] = await gcpSpeech.recognize({
    audio: { content: audioBytes },
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: 8000,
      languageCode: STT_LANG,
      // Suma variantes por si el usuario alterna acentos
      alternativeLanguageCodes: ['es-CO','es-ES','es-MX'],
      useEnhanced: true,
      model: 'phone_call',
      enableAutomaticPunctuation: true,
      profanityFilter: false
    }
  });

  const transcript = stt.results?.map(r => r.alternatives?.[0]?.transcript).join(' ').trim() || '';
  return transcript;
}

// ===== Saludo + Captura (Twilio Gather o Google Record) =====
app.all('/voice', (req, res) => {
  const callSid   = req.body?.CallSid || req.query?.CallSid || 'ANON';
  const session   = getSession(callSid);
  const continuing = req.query?.cont === '1' || session.greeted;
  const vr = new VoiceResponse();

  if (ASR_PROVIDER === 'google') {
    // --- Modo Google: usamos <Record> en cada turno ---
    const sayText = continuing
      ? 'Te escucho.'
      : 'Hola, bienvenido a Nexus 360. ¿En qué puedo ayudarte hoy?';

    vr.say({ voice: TTS_VOICE }, sayText);
    session.greeted = true;

    // Captura un turno corto y llama a /record-process
    vr.record({
      action: '/record-process',
      method: 'POST',
      maxLength: 10,           // segundos por turno
      timeout: 3,              // silencio para terminar
      playBeep: false,
      trim: 'do-not-trim'
    });

    // Si no se grabó nada
    vr.say({ voice: TTS_VOICE }, 'No recibí audio. ¿Puedes repetir?');
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());
  }

  // --- Modo Twilio ASR (tu flujo anterior con Gather) ---
  const gather = vr.gather({
    input: 'speech',
    action: '/process-speech',
    method: 'POST',
    language: STT_LANG,
    speechTimeout: 'auto',
    bargeIn: true
  });

  if (!continuing) {
    gather.say({ voice: TTS_VOICE }, 'Hola, bienvenido a Nexus 360. ¿En qué puedo ayudarte hoy?');
    session.greeted = true;
  }
  vr.redirect({ method: 'POST' }, '/process-speech');
  res.type('text/xml').send(vr.toString());
});

// Alias /ivr (por compatibilidad con tu número)
app.post('/ivr', (req, res) => { req.url = '/voice'; app._router.handle(req, res); });

// ===== Procesar voz (Twilio ASR) =====
app.post('/process-speech', async (req, res) => {
  const { CallSid, SpeechResult } = req.body || {};
  const heard = (SpeechResult || '').trim();
  const callSid = CallSid || 'ANON';
  const vr = new VoiceResponse();

  if (!heard) {
    return sayAndLoop(vr, 'No te escuché bien. ¿Puedes repetir, por favor?') || res.type('text/xml').send(vr.toString());
  }

  try {
    const aiText = await processText({ callSid, heard, from: req.body?.From });

    if (needsHandoff(aiText) && FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Te transfiero con un asesor humano. Un momento, por favor.');
      vr.dial().number(FALLBACK_NUMBER);
      return res.type('text/xml').send(vr.toString());
    }

    // Cierre o bucle
    const end = aiText.toLowerCase();
    if (end.includes('hasta luego') || end.includes('adiós') || end.includes('gracias por llamar') || end.includes('cerrar pedido')) {
      vr.say({ voice: TTS_VOICE }, aiText);
      vr.hangup();
      sessions.delete(callSid);
    } else {
      sayAndLoop(vr, aiText);
    }
    return res.type('text/xml').send(vr.toString());
  } catch (err) {
    console.error('[AI error]', err?.status || err?.message);
    vr.say({ voice: TTS_VOICE }, `Tuve un problema técnico. ¿Quieres intentar de nuevo?`);
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());
  }
});

// ===== Procesar grabación (Google STT) =====
app.post('/record-process', async (req, res) => {
  const callSid = req.body?.CallSid || 'ANON';
  const recUrl  = req.body?.RecordingUrl;
  const vr = new VoiceResponse();

  if (!recUrl) {
    vr.say({ voice: TTS_VOICE }, 'No recibí audio. ¿Puedes repetir?');
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());
  }

  try {
    const heard = await googleTranscribeFromRecordingUrl(recUrl);
    if (!heard) {
      vr.say({ voice: TTS_VOICE }, 'No te entendí bien. ¿Puedes repetir, por favor?');
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
      return res.type('text/xml').send(vr.toString());
    }

    const aiText = await processText({ callSid, heard, from: req.body?.From });

    if (needsHandoff(aiText) && FALLBACK_NUMBER) {
      vr.say({ voice: TTS_VOICE }, 'Te transfiero con un asesor humano. Un momento, por favor.');
      vr.dial().number(FALLBACK_NUMBER);
      return res.type('text/xml').send(vr.toString());
    }

    const end = (aiText || '').toLowerCase();
    if (end.includes('hasta luego') || end.includes('adiós') || end.includes('gracias por llamar') || end.includes('cerrar pedido')) {
      vr.say({ voice: TTS_VOICE }, aiText);
      vr.hangup();
      sessions.delete(callSid);
    } else {
      // Responde y vuelve a pedir audio (siguiente turno)
      vr.say({ voice: TTS_VOICE }, aiText);
      vr.redirect({ method: 'POST' }, '/voice?cont=1');
    }
    return res.type('text/xml').send(vr.toString());
  } catch (e) {
    console.error('[Google STT]', e.message);
    vr.say({ voice: TTS_VOICE }, 'Tuve un problema transcribiendo tu audio. ¿Probamos de nuevo?');
    vr.redirect({ method: 'POST' }, '/voice?cont=1');
    return res.type('text/xml').send(vr.toString());
  }
});

// ===== Status callback (opcional) =====
app.post('/status', (req, res) => {
  const { CallSid, CallStatus } = req.body || {};
  console.log('[STATUS]', CallSid, CallStatus);
  res.sendStatus(200);
});

// ===== Health =====
app.get('/', (_req, res) => res.send(`Nexus 360 OK (ASR: ${ASR_PROVIDER})`));

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
    res.status(500).json({ ok: false, status: e?.status || e?.response?.status, message: e?.message, data: e?.response?.data || null });
  }
});

app.listen(PORT, () => console.log(`Nexus 360 running on port ${PORT} (ASR=${ASR_PROVIDER})`));
