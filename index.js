// ┌───────────────────────────────────────────────────────────────────┐
// │  Nexus 360 - Servidor IVR Inteligente con ASR                     │
// │  Versión 4.1 - Patrón de Espera Robusto (Final)                   │
// └───────────────────────────────────────────────────────────────────┘

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import express from 'express';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import { SpeechClient } from '@google-cloud/speech';
import { processTranscript } from './openai-handler.js';

// SECCIÓN 1: LÓGICA DEL MOTOR ASR
(function ensureGoogleCreds() {
  const b64 = process.env.GOOGLE_CREDENTIALS_B64;
  if (!b64) { console.warn('[WARN] GOOGLE_CREDENTIALS_B64 no está configurado.'); return; }
  const credsPath = path.join(process.cwd(), 'gcp-stt.json');
  try {
    fs.writeFileSync(credsPath, Buffer.from(b64, 'base64'));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credsPath;
    console.log('[OK] Credenciales de Google preparadas en runtime.');
  } catch (e) {
    console.error('[ERROR] No se pudo escribir el archivo de credenciales de Google:', e);
  }
})();

function createGoogleStream({ onData, onError, onEnd }) {
  const client = new SpeechClient();
  const request = { config: { encoding: 'MULAW', sampleRateHertz: 8000, languageCode: 'es-CO', model: 'phone_call', useEnhanced: true }, interimResults: true };
  const recognizeStream = client.streamingRecognize(request).on('error', (err) => onError?.(err)).on('data', (data) => {
      const result = data.results[0];
      if (result && result.alternatives && result.alternatives[0]) {
          onData?.({ engine: 'google', transcript: result.alternatives[0].transcript, isFinal: result.isFinal });
      }
  }).on('end', () => onEnd?.());
  return { write: (buf) => recognizeStream.write(buf), end: () => recognizeStream.end() };
}

// SECCIÓN 2: LÓGICA DEL IVR
const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.urlencoded({ extended: false }));
const VoiceResponse = twilio.twiml.VoiceResponse;

app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({ input: 'dtmf', numDigits: 1, timeout: 5, action: '/handle-menu' });
  gather.say({ voice: 'alice', language: 'es-MX' }, 'Bienvenido a Nexus 360. Para hacer su pedido, marque 1. Para recibir el menú por WhatsApp, marque 2. Para hablar con un asistente, marque 3.');
  twiml.redirect('/voice');
  res.type('text/xml').send(twiml.toString());
});

app.post('/handle-menu', (req, res) => {
  const digit = req.body.Digits;
  const twiml = new VoiceResponse();
  switch (digit) {
    case '1':
      twiml.say({ voice: 'alice', language: 'es-MX' }, 'Excelente. Estoy lista para tomar tu orden. ¿Qué deseas?');
      twiml.redirect('/listen');
      break;
    default:
      twiml.say({ voice: 'alice', language: 'es-MX' }, 'Opción no válida.');
      twiml.redirect('/voice');
      break;
  }
  res.type('text/xml').send(twiml.toString());
});

app.post('/listen', (req, res) => {
  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: `wss://${req.headers.host}/twilio-stream` });
  twiml.say({ voice: 'alice', language: 'es-MX' }, 'Procesando...');
  twiml.pause({ length: 20 });
  res.type('text/xml').send(twiml.toString());
});

app.post('/speak', (req, res) => {
    const callSid = req.body.CallSid;
    const state = callsState.get(callSid);
    const twiml = new VoiceResponse();
    if (state && state.lastAiResponse) {
        twiml.say({ voice: 'alice', language: 'es-MX' }, state.lastAiResponse);
        twiml.redirect('/listen');
    } else {
        twiml.say({ voice: 'alice', language: 'es-MX' }, "Lo siento, hubo un error.");
        twiml.hangup();
    }
    res.type('text/xml').send(twiml.toString());
});

// SECCIÓN 3: INICIALIZACIÓN Y CICLO DE CONVERSACIÓN
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const callsState = new Map();
const server = app.listen(PORT, () => console.log(`[OK] Servidor Nexus 360 escuchando en ${PORT}`));
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/twilio-stream') { wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request); }); } else { socket.destroy(); }
});

wss.on('connection', (ws, request) => {
    console.log('[WS] Conexión de stream iniciada.');
    let googleStream;
    let callSid;
    const onData = async (data) => {
        if (!data.isFinal || !data.transcript) return;
        console.log(`[ASR Final]: ${data.transcript}`);
        const state = callsState.get(callSid);
        if (!state) return;
        const aiResponse = await processTranscript(data.transcript, state.conversationHistory);
        console.log('[AI Response]:', aiResponse);
        state.conversationHistory.push({ role: 'user', content: data.transcript });
        state.conversationHistory.push({ role: 'assistant', content: aiResponse.responseText });
        state.order.push(...aiResponse.orderItems);
        state.lastAiResponse = aiResponse.responseText;
        if (aiResponse.action === 'CONFIRM_ORDER') {
            const twiml = new VoiceResponse();
            const finalOrder = state.order.length > 0 ? state.order.join(', ') : 'ningún producto';
            twiml.say({ voice: 'alice', language: 'es-MX' }, `${aiResponse.responseText}. Confirmando tu pedido de: ${finalOrder}. Gracias por llamar.`);
            twiml.hangup();
            callsState.delete(callSid);
            await twilioClient.calls(callSid).update({ twiml: twiml.toString() });
        } else {
            const speakUrl = `https://${process.env.HEROKU_APP_NAME}.herokuapp.com/speak`;
            await twilioClient.calls(callSid).update({ url: speakUrl, method: 'POST' });
        }
        console.log('[Twilio API] Llamada redirigida para el siguiente paso del ciclo.');
    };
    googleStream = createGoogleStream({ onData, onError: (e) => console.error('[ASR ERROR]', e) });
    ws.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'start') {
            callSid = msg.start.callSid;
            console.log(`[Twilio] Stream iniciado para CallSid: ${callSid}`);
            if (!callsState.has(callSid)) { callsState.set(callSid, { conversationHistory: [], order: [], lastAiResponse: null }); }
        } else if (msg.event === 'media') {
            googleStream.write(Buffer.from(msg.media.payload, 'base64'));
        } else if (msg.event === 'stop') {
            console.log('[Twilio] Stream detenido.');
            googleStream.end();
        }
    });
    ws.on('close', () => { console.log(`[WS] Conexión cerrada para ${callSid}.`); googleStream.end(); });
});
