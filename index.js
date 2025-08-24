import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';

const app = express();
app.use(express.urlencoded({ extended: false }));

const { VoiceResponse } = twilio.twiml;

const STT_LANG  = process.env.STT_LANG  || 'es-ES';
const TTS_VOICE = process.env.TTS_VOICE || 'Polly.Miguel';
const PORT      = process.env.PORT || 3000;

app.post('/voice', (req, res) => {
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
  vr.redirect({ method: 'POST' }, '/process-speech');
  res.type('text/xml').send(vr.toString());
});

app.post('/process-speech', (req, res) => {
  const heard = req.body?.SpeechResult || '';
  const vr = new VoiceResponse();
  if (!heard) {
    vr.say({ voice: TTS_VOICE }, 'No te escuché bien. ¿Puedes repetir, por favor?');
    vr.redirect({ method: 'POST' }, '/voice');
  } else {
    vr.say({ voice: TTS_VOICE }, `Entendido. Dijiste: ${heard}. Gracias por llamar.`);
    vr.hangup();
  }
  res.type('text/xml').send(vr.toString());
});

app.post('/status', (req, res) => {
  const { CallSid, CallStatus } = req.body || {};
  console.log('[STATUS]', CallSid, CallStatus);
  res.sendStatus(200);
});

app.get('/', (_req, res) => res.send('Nexus 360 OK'));
app.listen(PORT, () => console.log(`Nexus 360 running on port ${PORT}`));
