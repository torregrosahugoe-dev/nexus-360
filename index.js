// ┌───────────────────────────────────────────────────────────────────┐
// │  Nexus 360 - Servidor IVR Inteligente con ASR                     │
// │  Versión 2.0 - Con Ciclo de Conversación Completo                 │
// └───────────────────────────────────────────────────────────────────┘

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import { SpeechClient } from '@google-cloud/speech';
import { processTranscript } from './openai-handler.js'; // Importamos el cerebro

// SECCIÓN 1: LÓGICA DEL MOTOR ASR (SIN CAMBIOS)
// (Tu código de `ensureGoogleCreds` y `createGoogleStream` va aquí, idéntico al anterior)
// 1.1) Credencial de Google: Se decodifica desde una variable de entorno
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

// 1.2) Motor Google STT (streaming)
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

// SECCIÓN 2: LÓGICA DEL IVR (SIN CAMBIOS)
const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.urlencoded({ extended: false }));
const VoiceResponse = twilio.twiml.VoiceResponse;
app.post('/voice', (req, res) => { const twiml = new VoiceResponse(); const gather = twiml.gather({ input: 'dtmf', numDigits: 1, timeout: 5, action: '/handle-menu', }); gather.say({ voice: 'alice', language: 'es-MX' }, 'Bienvenido a Nexus 360. Para hacer su pedido, marque 1. Para recibir el menú por WhatsApp, marque 2. Para hablar con un asistente, marque 3.'); twiml.redirect('/voice'); res.type('text/xml').send(twiml.toString()); });
app.post('/handle-menu', (req, res) => { const digit = req.body.Digits; const twiml = new VoiceResponse(); switch (digit) { case '1': twiml.say({ voice: 'alice', language: 'es-MX' }, 'Excelente. Estoy lista para tomar tu orden. ¿Qué deseas?'); twiml.redirect('/order-speech'); break; case '2': const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN); twilioClient.messages.create({ body: '¡Hola! Aquí tienes el menú de Nexus 360:\n- Hamburguesa\n- Pizza\n- Papas\n- Gaseosa', from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`, to: `whatsapp:${req.body.From}` }).then(message => console.log(`[OK] Mensaje de WhatsApp enviado a ${req.body.From}`)).catch(err => console.error('[ERROR] No se pudo enviar el WhatsApp:', err)); twiml.say({ voice: 'alice', language: 'es-MX' }, 'Te hemos enviado el menú a tu número de WhatsApp. Gracias por llamar.'); twiml.hangup(); break; case '3': twiml.say({ voice: 'alice', language: 'es-MX' }, 'Por favor, espere mientras lo comunicamos con un asistente.'); twiml.dial(process.env.ASSISTANT_PHONE_NUMBER); break; default: twiml.say({ voice: 'alice', language: 'es-MX' }, 'Opción no válida.'); twiml.redirect('/voice'); break; } res.type('text/xml').send(twiml.toString()); });
app.post('/order-speech', (req, res) => { const twiml = new VoiceResponse(); const connect = twiml.connect(); connect.stream({ url: `wss://${req.headers.host}/twilio-stream`, }); twiml.pause({ length: 60 }); res.type('text/xml').send(twiml.toString()); });


// SECCIÓN 3: INICIALIZACIÓN DEL SERVIDOR Y CICLO DE CONVERSACIÓN
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const callsState = new Map(); // Para guardar el estado de cada llamada

const server = app.listen(PORT, () => console.log(`[OK] Servidor Nexus 360 IVR+ASR escuchando en el puerto ${PORT}`));
const wss = new WebSocketServer({ server, path: '/twilio-stream' });

wss.on('connection', (ws) => {
  console.log('[WS] Conexión de stream iniciada.');
  let googleStream;
  let callSid;

  const onData = async (data) => {
    if (!data.isFinal || !data.transcript) {
      return; // Solo procesamos transcripciones finales
    }

    console.log(`[ASR Final]: ${data.transcript}`);
    
    // Obtenemos el estado actual de la llamada
    const state = callsState.get(callSid);
    if (!state) return; // Si no hay estado, no hacemos nada

    // 1. PENSAR: Enviamos la transcripción y el historial a OpenAI
    const aiResponse = await processTranscript(data.transcript, state.conversationHistory);
    console.log('[AI Response]:', aiResponse);

    // Actualizamos el estado de la llamada con la nueva interacción
    state.conversationHistory.push({ role: 'user', content: data.transcript });
    state.conversationHistory.push({ role: 'assistant', content: aiResponse.responseText });
    state.order.push(...aiResponse.orderItems);

    // 2. HABLAR: Creamos el nuevo TwiML para la respuesta
    const responseTwiml = new VoiceResponse();

    if (aiResponse.action === 'CONFIRM_ORDER') {
      const finalOrder = state.order.length > 0 ? state.order.join(', ') : 'ningún producto';
      responseTwiml.say({ voice: 'alice', language: 'es-MX' }, 
        `${aiResponse.responseText}. Confirmando tu pedido de: ${finalOrder}. Gracias por llamar a Nexus 360.`
      );
      responseTwiml.hangup();
      callsState.delete(callSid); // Limpiamos el estado
    } else {
      // Si la conversación continúa, decimos la respuesta y volvemos a escuchar
      responseTwiml.say({ voice: 'alice', language: 'es-MX' }, aiResponse.responseText);
      const connect = responseTwiml.connect();
      connect.stream({ url: `wss://${process.env.HEROKU_APP_NAME}.herokuapp.com/twilio-stream` });
      responseTwiml.pause({ length: 60 });
    }

    // 3. ACTUALIZAR LLAMADA: Usamos la API REST para inyectar el nuevo TwiML
    try {
      await twilioClient.calls(callSid).update({ twiml: responseTwiml.toString() });
      console.log('[Twilio API] Llamada actualizada con la respuesta de la IA.');
    } catch(error) {
      console.error('[Twilio API ERROR] No se pudo actualizar la llamada:', error);
    }
  };

  googleStream = createGoogleStream({ onData, onError: (e) => console.error('[ASR ERROR]', e) });

  ws.on('message', (message) => {
    const msg = JSON.parse(message);
    if (msg.event === 'start') {
      callSid = msg.start.callSid;
      console.log(`[Twilio] Stream iniciado para CallSid: ${callSid}`);
      // Inicializamos el estado para esta nueva llamada
      callsState.set(callSid, {
        conversationHistory: [],
        order: [],
      });
    } else if (msg.event === 'media') {
      googleStream.write(msg.media.payload);
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
