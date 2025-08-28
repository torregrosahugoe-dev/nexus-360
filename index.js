// index.js
import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';

// --- Lógica ASR (Tu código existente) ---
// (Aquí va todo tu código para la gestión de credenciales de Google,
// createGoogleStream, createWhisperChunker, etc. Lo omito por brevedad
// pero DEBE estar aquí)
// --- Fin Lógica ASR ---


const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.urlencoded({ extended: false }));

const VoiceResponse = twilio.twiml.VoiceResponse;

// =================================================================
// 1. ENDPOINT DE ENTRADA (/voice) - Inicia la llamada
// =================================================================
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();

  const gather = twiml.gather({
    input: 'dtmf',      // Espera tonos del teclado
    numDigits: 1,       // Solo espera 1 dígito
    timeout: 5,         // Espera 5 segundos
    action: '/handle-menu', // Envía el dígito a este endpoint
  });

  gather.say({ voice: 'alice', language: 'es-MX' },
    'Bienvenido a Nexus 360. Para hacer su pedido, marque 1. Para recibir el menú por WhatsApp, marque 2. Para hablar con un asistente, marque 3.'
  );

  // Si el usuario no marca nada, redirige aquí
  twiml.redirect('/voice');

  res.type('text/xml');
  res.send(twiml.toString());
});

// =================================================================
// 2. ENDPOINT DE MANEJO DEL MENÚ (/handle-menu)
// =================================================================
app.post('/handle-menu', (req, res) => {
  const digit = req.body.Digits;
  const twiml = new VoiceResponse();

  switch (digit) {
    case '1':
      twiml.say({ voice: 'alice', language: 'es-MX' },
        'Excelente, vamos a tomar su pedido. Un momento por favor.'
      );
      // Redirigimos al flujo de toma de pedido por voz
      twiml.redirect('/order-speech');
      break;

    case '2':
      // Lógica para enviar WhatsApp (necesitas tu Account SID y Auth Token)
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const fromWhatsApp = 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER;
      const toWhatsApp = 'whatsapp:' + req.body.From; // Número del cliente

      client.messages.create({
        body: '¡Hola! Aquí tienes el menú de Nexus 360:\n- Hamburguesa\n- Pizza\n- Papas\n- Gaseosa',
        from: fromWhatsApp,
        to: toWhatsApp
      }).then(message => console.log(`Mensaje de WhatsApp enviado: ${message.sid}`))
        .catch(err => console.error(err));

      twiml.say({ voice: 'alice', language: 'es-MX' },
        'Te hemos enviado el menú a tu número de WhatsApp. Gracias por llamar.'
      );
      twiml.hangup();
      break;

    case '3':
      twiml.say({ voice: 'alice', language: 'es-MX' },
        'Por favor, espere mientras lo comunicamos con un asistente.'
      );
      // Reemplaza con el número de teléfono del asistente
      twiml.dial(process.env.ASSISTANT_PHONE_NUMBER);
      break;

    default:
      twiml.say({ voice: 'alice', language: 'es-MX' },
        'Opción no válida. Por favor, intente de nuevo.'
      );
      twiml.redirect('/voice');
      break;
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// =================================================================
// 3. ENDPOINT PARA INICIAR EL STREAM DE VOZ (/order-speech)
// =================================================================
app.post('/order-speech', (req, res) => {
  const twiml = new VoiceResponse();
  
  twiml.say({ voice: 'alice', language: 'es-MX' },
    'Estoy lista para tomar tu orden. ¿Qué deseas?'
  );

  // Aquí conectamos la llamada al servidor WebSocket que ya creaste
  const connect = twiml.connect();
  connect.stream({
    url: `wss://${req.headers.host}/twilio-stream`,
  });

  res.type('text/xml');
  res.send(twiml.toString());
});


// Levantar el servidor HTTP
const server = app.listen(PORT, () =>
  console.log(`Servidor Nexus 360 IVR+ASR escuchando en el puerto ${PORT}`)
);


// =================================================================
// 4. LÓGICA DEL WEBSOCKET (Tu código ASR existente)
//    Esta parte no cambia, excepto que ahora vive dentro del
//    mismo servidor Express.
// =================================================================
const wss = new WebSocketServer({ server, path: '/twilio-stream' });

wss.on('connection', async (ws) => {
    console.log('[WS] Conexión de stream iniciada.');
    
    // Aquí iría toda tu lógica de `wss.on('connection', ...)` que ya tienes:
    // - Inicializar el motor (Google o Whisper)
    // - Manejar los eventos 'start', 'media' y 'stop' de Twilio
    // - Al recibir una transcripción final, ahora la enviaremos a OpenAI
    
    // Ejemplo de cómo integrar OpenAI al recibir una transcripción:
    ws.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'media') {
            // Tu lógica de `engine.write(Buffer.from(msg.media.payload, 'base64'))`
        } else if (msg.event === 'stop') {
            console.log('[WS] Stream de Twilio detenido.');
            // Cerrar la conexión ASR
        }

        // --- ¡NUEVA INTEGRACIÓN! ---
        // Aquí es donde deberías recibir la transcripción de tu motor ASR
        // Para este ejemplo, simularemos que la recibimos:
        // const transcript = "Quiero una hamburguesa y una gaseosa";
        // processTranscript(transcript).then(responseFromAI => {
        //   console.log("Respuesta de AI:", responseFromAI);
        //   // IMPORTANTE: Para responder al usuario, necesitarías usar la API REST de Twilio
        //   // para modificar la llamada en curso y reproducir la respuesta de la IA.
        //   // Esto es un paso avanzado. Por ahora, solo la mostramos en consola.
        // });
    });
});
