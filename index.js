// ┌───────────────────────────────────────────────────────────────────┐
// │  Nexus 360 - Servidor IVR Inteligente con ASR                     │
// │  (c) 2025 - Creado por Hugo Torregrosa & Asistido por Gemini      │
// └───────────────────────────────────────────────────────────────────┘

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import { SpeechClient } from '@google-cloud/speech';

// ╔══════════════════════════════════════════════════════════════════╗
// ║ SECCIÓN 1: LÓGICA DEL MOTOR DE RECONOCIMIENTO DE VOZ (ASR)         ║
// ╚══════════════════════════════════════════════════════════════════╝

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
      // Corregido: El <Say> se reproduce ANTES de la redirección al stream
      twiml.say({ voice: 'alice', language: 'es-MX' },
        'Excelente. Estoy lista para tomar tu orden. ¿Qué deseas?'
      );
      twiml.redirect('/order-speech');
      break;

    case '2':
      const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      twilioClient.messages.create({
        body: '¡Hola! Aquí tienes el menú de Nexus 360:\n- Hamburguesa\n- Pizza\n- Papas\n- Gaseosa',
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        to: `whatsapp:${req.body.From}`
      }).then(message => console.log(`[OK] Mensaje de WhatsApp enviado a ${req.body.From}`))
        .catch(err => console.error('[ERROR] No se pudo enviar el WhatsApp:', err));
      
      twiml.say({ voice: 'alice', language: 'es-MX' },
        'Te hemos enviado el menú a tu número de WhatsApp. Gracias por llamar.'
      );
      twiml.hangup();
      break;

    case '3':
      twiml.say({ voice: 'alice', language: 'es-MX' },
        'Por favor, espere mientras lo comunicamos con un asistente.'
      );
      twiml.dial(process.env.ASSISTANT_PHONE_NUMBER);
      break;

    default:
      twiml.say({ voice: 'alice', language: 'es-MX' }, 'Opción no válida.');
      twiml.redirect('/voice');
      break;
  }

  res.type('text/xml').send(twiml.toString());
});

// 2.3) Endpoint para iniciar el stream de voz (/order-speech)
app.post('/order-speech', (req, res) => {
  const twiml = new VoiceResponse();
  
  // Corregido: Este endpoint ahora SOLO inicia la conexión, sin <Say>
  const connect = twiml.connect();
  connect.stream({
    url: `wss://${req.headers.host}/twilio-stream`,
  });

  // Agregamos una pausa para mantener la llamada activa mientras el stream funciona
  twiml.pause({ length: 60 });
  
  res.type('text/xml').send(twiml.toString());
});


// ╔══════════════════════════════════════════════════════════════════╗
// ║ SECCIÓN 3: INICIALIZACIÓN DEL SERVIDOR Y WEBSOCKETS                ║
// ╚══════════════════════════════════════════════════════════════════╝

// 3.1) Inicialización del servidor HTTP
const server = app.listen(PORT, () =>
  console.log(`[OK] Servidor Nexus 360 IVR+ASR escuchando en el puerto ${PORT}`)
);

// 3.2) Inicialización del servidor WebSocket, adjunto al servidor HTTP
const wss = new WebSocketServer({ server, path: '/twilio-stream' });

wss.on('connection', async (ws) => {
  console.log('[WS] Conexión de stream iniciada.');

  let googleStream;
  const ASR_ENGINE = (process.env.ASR_ENGINE || 'google').toLowerCase();

  if (ASR_ENGINE === 'google') {
    googleStream = createGoogleStream({
      onData: (data) => {
        // En una implementación avanzada, aquí enviarías la transcripción (data.transcript)
        // a la lógica de OpenAI y devolverías la respuesta a la llamada.
        if (data.isFinal) {
            console.log(`[ASR Final]: ${data.transcript}`);
        }
      },
      onError: (error) => {
        console.error('[ASR ERROR]', error);
      },
      onEnd: () => {
        console.log('[ASR] Stream de Google finalizado.');
      },
    });
  }
  
  ws.on('message', (message) => {
    const msg = JSON.parse(message);
    switch (msg.event) {
      case 'start':
        console.log('[Twilio] Stream iniciado:', msg.start.callSid);
        break;
      case 'media':
        // Escribe el audio en el stream del motor ASR
        if (googleStream) {
            googleStream.write(Buffer.from(msg.media.payload, 'base64'));
        }
        break;
      case 'stop':
        console.log('[Twilio] Stream detenido.');
        if (googleStream) {
            googleStream.end();
        }
        ws.close();
        break;
    }
  });

  ws.on('close', () => {
    console.log('[WS] Conexión cerrada.');
    if (googleStream) {
        googleStream.end();
    }
  });
});
