// ┌───────────────────────────────────────────────────────────────────┐
// │  Nexus 360 - Servidor IVR Inteligente con ASR                     │
// │  Versión 2.2 - Final Estable                                      │
// └───────────────────────────────────────────────────────────────────┘

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import { SpeechClient } from '@google-cloud/speech';
import { processTranscript } from './openai-handler.js';

// ╔══════════════════════════════════════════════════════════════════╗
// ║ SECCIÓN 1: LÓGICA DEL MOTOR DE RECONOCIMIENTO DE VOZ (ASR)         ║
// ╚══════════════════════════════════════════════════════════════════╝

(function ensureGoogleCreds() {
  const b64 = process.env.GOOGLE_CREDENTIALS_B64;
  if (!b64) {
    console.warn('[WARN] GOOGLE_CREDENTIALS_B64 no está configurado. Google STT fallará.');
    return;
  }
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
  const request = {
    config: {
      encoding: 'MULAW',
      sampleRateHertz: 8000,
      languageCode: 'es-CO',
      model: 'phone_call',
      useEnhanced: true,
    },
    interimResults: true,
  };

  const recognizeStream = client
    .streamingRecognize(request)
    .on('error', (e) => onError?.(e))
    .on('data', (data) => {
      const result = data.results?.[0];
      if (result?.alternatives?.[0]) {
        onData?.({
          engine: 'google',
          transcript: result.alternatives[0].transcript,
          isFinal: result.isFinal,
        });
      }
    })
    .on('end', () => onEnd?.());

  return {
    write: (buf) => recognizeStream.write(buf),
    end: () => recognizeStream.end(),
  };
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║ SECCIÓN 2: LÓGICA DEL IVR (ENDPOINTS HTTP PARA TWILIO)             ║
// ╚══════════════════════════════════════════════════════════════════╝

const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.urlencoded({ extended: false }));

const VoiceResponse = twilio.twiml.VoiceResponse;

// 2.1) Endpoint de entrada (/voice) - Inicia la llamada
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'dtmf',
    numDigits: 1,
    timeout: 5,
    action: '/handle-menu',
  });
  gather.say({ voice: 'alice', language: 'es-MX' },
    'Bienvenido a Nexus 360. Para hacer su pedido, marque 1. Para recibir el menú por WhatsApp, marque 2. Para hablar con un asistente, marque 3.'
  );
  twiml.redirect('/voice');
  res.type('text/xml').send(twiml.toString());
});

// 2.2) Endpoint de manejo del menú (/handle-menu)
app.post('/handle-menu', (req, res) => {
  const digit = req.body.Digits;
  const twiml = new VoiceResponse();

  switch (digit) {
    case '1':
      twiml.say({ voice: 'alice', language: 'es-MX' }, 'Excelente. Estoy lista para tomar tu orden. ¿Qué deseas?');
      twiml.redirect('/order-speech');
      break;
    case '2':
      twiml.say({ voice: 'alice', language: 'es-MX' }, 'La función de WhatsApp será implementada próximamente.');
      twiml.hangup();
      break;
    case '3':
      twiml.say({ voice: 'alice', language: 'es-MX' }, 'Transfiriendo su llamada a un asistente.');
      twiml.dial(process.env.ASSISTANT_PHONE_NUMBER);
      break;
    default:
      twiml.say({ voice: 'alice', language: 'es-MX' }, 'Opción no válida. Por favor, intente de nuevo.');
      twiml.redirect('/voice');
      break;
  }
  res.type('text/xml').send(twiml.toString());
});

// 2.3) Endpoint para iniciar el stream de voz (/order-speech)
app.post('/order-speech', (req, res) => {
  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: `wss://${req.headers.host}/twilio-stream` });
  twiml.pause({ length: 60 });
  res.type('text/xml').send(twiml.toString());
});

// 2.4) Endpoint para continuar la conversación
app.post('/continue-conversation', (req, res) => {
    const callSid = req.body.CallSid;
    const state = callsState.get(callSid);
    const twiml = new VoiceResponse();

    if (state && state.lastAiResponse) {
        twiml.say({ voice: 'alice', language: 'es-MX' }, state.lastAiResponse);
        const connect = twiml.connect();
        connect.stream({ url: `wss://${req.headers.host}/twilio-stream` });
        twiml.pause({ length: 60 });
    } else {
        twiml.say({ voice: 'alice', language: 'es-MX' }, "Lo siento, hubo un error. Por favor, intente de nuevo.");
        twiml.hangup();
    }
    res.type('text/xml').send(twiml.toString());
});


// ╔══════════════════════════════════════════════════════════════════╗
// ║ SECCIÓN 3: INICIALIZACIÓN DEL SERVIDOR Y CICLO DE CONVERSACIÓN     ║
// ╚══════════════════════════════════════════════════════════════════╝

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const callsState = new Map();

const server = app.listen(PORT, () => console.log(`[OK] Servidor Nexus 360 escuchando en el puerto ${PORT}`));
const wss = new WebSocketServer({ server, path: '/twilio-stream' });

wss.on('connection', (ws) => {
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

        const twiml = new VoiceResponse();
        if (aiResponse.action === 'CONFIRM_ORDER') {
            const finalOrder = state.order.length > 0 ? state.order.join(', ') : 'ningún producto';
            twiml.say({ voice: 'alice', language: 'es-MX' }, `${aiResponse.responseText}. Confirmando tu pedido de: ${finalOrder}. Gracias por llamar a Nexus 360.`);
            twiml.hangup();
            callsState.delete(callSid);
            await twilioClient.calls(callSid).update({ twiml: twiml.toString() });
        } else {
            const nextStepUrl = `https://${process.env.HEROKU_APP_NAME}.herokuapp.com/continue-conversation`;
            await twilioClient.calls(callSid).update({ url: nextStepUrl, method: 'POST' });
        }
        console.log('[Twilio API] La llamada ha sido redirigida para continuar el ciclo.');
    };

    googleStream = createGoogleStream({ onData, onError: (e) => console.error('[ASR ERROR]', e) });

    ws.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'start') {
            callSid = msg.start.callSid;
            console.log(`[Twilio] Stream iniciado para CallSid: ${callSid}`);
            if (!callsState.has(callSid)) {
                callsState.set(callSid, { conversationHistory: [], order: [], lastAiResponse: null });
            }
        } else if (msg.event === 'media') {
            googleStream.write(Buffer.from(msg.media.payload, 'base64'));
        } else if (msg.event === 'stop') {
            console.log('[Twilio] Stream detenido.');
            googleStream.end();
        }
    });

    ws.on('close', () => {
        console.log(`[WS] Conexión cerrada para ${callSid}.`);
        googleStream.end();
    });
});
