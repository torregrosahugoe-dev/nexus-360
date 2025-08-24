// index.js (ESM)
import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio manda x-www-form-urlencoded

const { VoiceResponse } = twilio.twiml;

const STT_LANG  = process.env.STT_LANG  || 'es-ES';        // idioma de reconocimiento
const TTS_VOICE = process.env.TTS_VOICE || 'Polly.Miguel';  // voz TTS
const PORT      = process.env.PORT || 3000;

// Saludo y primera espera de voz
app.post('/voice', (req, res) => {
  const vr = new VoiceResponse();

  const gather = vr.gather({
    input: 'speech',
    action: '/process-speech',   // Twilio hará POST a esta ruta
    method: 'POST',
    language: STT_LANG,
    speechTimeout: 'auto',
    bargeIn: true
  });

  gather.say({ voice: TTS_VOICE }, 'Hola, bienvenido a Nexus 360. ¿En qué puedo ayudarte hoy?');

  // Si no hubo entrada, reintenta (evita silencio eterno)
  vr.redirect({ method: 'POST' }, '/process-speech');

  res.type('text/xml').send(vr.toString());
});

// Procesa lo que dijo el usuario
app.post('/process-speech', (req, res) => {
  const heard = req.body?.SpeechResult || '';
  console.log('[SpeechResult]', heard);

  const vr = new VoiceResponse();

  if (!heard) {
    vr.say({ voice: TTS_VOICE }, 'No te escuché bien. ¿Puedes repetir, por favor?');
    vr.redirect({ method: 'POST' }, '/voice');
  } else {
    vr.say({ voice: TTS_VOICE }, `Entendido. Dijiste: ${heard}. Nuestro cerebro de inteligencia artificial se está conectando.`);
    vr.hangup();
  }

  res.type('text/xml').send(vr.toString());
});

// (Opcional) status callback para depurar
app.post('/status', (req, res) => {
  const { CallSid, CallStatus } = req.body || {};
  console.log('[STATUS]', CallSid, CallStatus);
  res.sendStatus(200);
});

// Healthcheck
app.get('/', (_req, res) => res.send('Nexus 360 OK'));

app.listen(PORT, () => console.log(`Nexus 360 running on port ${PORT}`));
