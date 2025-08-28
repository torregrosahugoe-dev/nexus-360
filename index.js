// ┌───────────────────────────────────────────────────────────────────┐
// │  Nexus 360 - Servidor IVR Inteligente con ASR                     │
// │  Versión 5.0 - Prueba de Bypass de Google (Diagnóstico Final)     │
// └───────────────────────────────────────────────────────────────────┘

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import express from 'express';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
// import { SpeechClient } from '@google-cloud/speech'; // Desactivamos Google temporalmente
import { processTranscript } from './openai-handler.js';

// SECCIÓN 1: LÓGICA DEL MOTOR ASR (DESACTIVADA PARA PRUEBAS)
// La configuración de credenciales sigue siendo necesaria para que la app no falle.
(function ensureGoogleCreds() {
  const b64 = process.env.GOOGLE_CREDENTIALS_B64;
  if (!b64) { console.warn('[WARN] GOOGLE_CREDENTIALS_B64 no está configurado.'); return; }
  const credsPath = path.join(process.cwd(), 'gcp-stt.json');
  try { fs.writeFileSync(credsPath, Buffer.from(b64, 'base64')); process.env.GOOGLE_APPLICATION_CREDENTIALS = credsPath; console.log('[OK] Credenciales de Google preparadas en runtime.'); } catch (e) { console.error('[ERROR] No se pudo escribir el archivo de credenciales de Google:', e); }
})();


// SECCIÓN 2: LÓGICA DEL IVR (SIN CAMBIOS)
const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.urlencoded({ extended: false }));
const VoiceResponse = twilio.twiml.VoiceResponse;

app.post('/voice', (req, res) => { const twiml = new VoiceResponse(); const gather = twiml.gather({ input: 'dtmf', numDigits: 1, timeout: 5, action: '/handle-menu' }); gather.say({ voice: 'alice', language: 'es-MX' }, 'Bienvenido a Nexus 360. Para hacer su pedido, marque 1.'); twiml.redirect('/voice'); res.type('text/xml').send(twiml.toString()); });
app.post('/handle-menu', (req, res) => { const digit = req.body.Digits; const twiml = new VoiceResponse(); switch (digit) { case '1': twiml.say({ voice: 'alice', language: 'es-MX' }, 'Excelente. Estoy lista para tomar tu orden. ¿Qué deseas?'); twiml.redirect('/listen'); break; default: twiml.say({ voice: 'alice', language: 'es-MX' }, 'Opción no válida.'); twiml.redirect('/voice'); break; } res.type('text/xml').send(twiml.toString()); });
app.post('/listen', (req, res) => { const twiml = new VoiceResponse(); const connect = twiml.connect(); connect.stream({ url: `wss://${req.headers.host}/twilio-stream` }); twiml.say({ voice: 'alice', language: 'es-MX' }, 'Procesando...'); twiml.pause({ length: 20 }); res.type('text/xml').send(twiml.toString()); });
app.post('/speak', (req, res) => { const callSid = req.body.CallSid; const state = callsState.get(callSid); const twiml = new VoiceResponse(); if (state && state.lastAiResponse) { twiml.say({ voice: 'alice', language: 'es-MX' }, state.lastAiResponse); twiml.redirect('/listen'); } else { twiml.say({ voice: 'alice', language: 'es-MX' }, "Lo siento, hubo un error."); twiml.hangup(); } res.type('text/xml').send(twiml.toString()); });

// SECCIÓN 3: INICIALIZACIÓN Y CICLO DE CONVERSACIÓN (CON BYPASS)
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const callsState = new Map();
const server = app.listen(PORT, () => console.log(`[OK] Servidor Nexus 360 escuchando en ${PORT}`));
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => { const pathname = new URL(request.url, `http://${request.headers.host}`).pathname; if (pathname === '/twilio-stream') { wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request); }); } else { socket.destroy(); } });

wss.on('connection', (ws, request) => {
    console.log('[WS] Conexión de stream iniciada.');
    let callSid;
    let audioChunkCounter = 0; // Contador de trozos de audio
    let testTriggered = false; // Bandera para asegurar que solo se dispare una vez

    // LA FUNCIÓN onData AHORA SERÁ LLAMADA MANUALMENTE
    const onData = async (data) => {
        if (!data.isFinal || !data.transcript) return;
        console.log(`[ASR SIMULADO]: ${data.transcript}`);
        const state = callsState.get(callSid);
        if (!state) return;

        const aiResponse = await processTranscript(data.transcript, state.conversationHistory);
        console.log('[AI Response]:', aiResponse);

        state.lastAiResponse = aiResponse.responseText;
        const speakUrl = `https://${process.env.HEROKU_APP_NAME}.herokuapp.com/speak`;
        await twilioClient.calls(callSid).update({ url: speakUrl, method: 'POST' });
        console.log('[Twilio API] Llamada redirigida para el siguiente paso del ciclo.');
    };

    ws.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'start') {
            callSid = msg.start.callSid;
            console.log(`[Twilio] Stream iniciado para CallSid: ${callSid}`);
            if (!callsState.has(callSid)) {
                callsState.set(callSid, { conversationHistory: [], order: [], lastAiResponse: null });
            }
        } else if (msg.event === 'media') {
            // ---- LÓGICA DE BYPASS ----
            audioChunkCounter++;
            // Tras recibir 15 chunks de audio (aprox. 1-2 segundos de voz)...
            if (audioChunkCounter > 15 && !testTriggered) {
                console.log('[DIAGNÓSTICO] Bypass activado. Simulando transcripción...');
                testTriggered = true; // Evita que se vuelva a disparar
                // Llamamos a onData manualmente con un resultado falso
                onData({
                    transcript: 'orden de prueba',
                    isFinal: true
                });
            }
            // --------------------------
        } else if (msg.event === 'stop') {
            console.log('[Twilio] Stream detenido.');
        }
    });

    ws.on('close', () => {
        console.log(`[WS] Conexión cerrada para ${callSid}.`);
    });
});
