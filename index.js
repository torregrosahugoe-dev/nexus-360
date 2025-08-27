// index.js
// Nexus360 ASR bridge (Twilio Media Streams -> Google STT | Whisper)
// Node 18+, ESM

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { SpeechClient } from '@google-cloud/speech';

// ───────────────────────────────────────────────────────────────────────────────
// 1) Credencial de Google: decodifica el JSON desde GOOGLE_CREDENTIALS_B64
//    (Heroku no guarda archivos persistentes; lo recreamos en runtime)
// ───────────────────────────────────────────────────────────────────────────────
(function ensureGoogleCreds() {
  const b64 = process.env.GOOGLE_CREDENTIALS_B64;
  if (!b64) {
    console.warn('[WARN] GOOGLE_CREDENTIALS_B64 no está configurado. ' +
      'Google STT fallará si el motor activo es "google".');
    return;
  }
  const credsPath = path.join(process.cwd(), 'gcp-stt.json');
  try {
    fs.writeFileSync(credsPath, Buffer.from(b64, 'base64'));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credsPath;
    console.log('[OK] Credenciales de Google preparadas en runtime.');
  } catch (e) {
    console.error('[ERROR] No se pudo escribir gcp-stt.json:', e);
  }
})();

// ───────────────────────────────────────────────────────────────────────────────
// 2) Utilidades simples
// ───────────────────────────────────────────────────────────────────────────────
function normalizeTranscript(text = '') {
  return text
    .replace(/\b(eee+|eh+|mmm+|ajá+|este+)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// μ-law 8kHz mono = 8000 bytes/seg (1 byte por sample)
const msToBytes = (ms) => Math.floor((ms * 8000) / 1000);

// ───────────────────────────────────────────────────────────────────────────────
// 3) Motor Google STT (streaming real)
// ───────────────────────────────────────────────────────────────────────────────
function createGoogleStream({ config, onData, onError, onEnd }) {
  const client = new SpeechClient(); // usa GOOGLE_APPLICATION_CREDENTIALS

  const request = {
    config: {
      encoding: config.encoding || 'MULAW',
      sampleRateHertz: Number(config.sampleRate) || 8000,
      languageCode: config.language || 'es-CO',
      model: config.model || 'phone_call',
      useEnhanced: String(config.useEnhanced).toLowerCase() !== 'false',
    },
    interimResults: true,
    singleUtterance: false,
  };

  const recognizeStream = client
    .streamingRecognize(request)
    .on('error', (e) => onError?.(e))
    .on('data', (data) => {
      const res = data.results?.[0];
      if (!res) return;
      const alt = res.alternatives?.[0];
      onData?.({
        engine: 'google',
        transcript: alt?.transcript || '',
        isFinal: !!res.isFinal,
        confidence: alt?.confidence,
      });
    })
    .on('end', () => onEnd?.());

  return {
    write: (buf) => recognizeStream.write(buf),
    end: () => recognizeStream.end(),
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// 4) Motor Whisper (quasi-streaming por chunks) — opcional
//    NOTA: Latencia ~1–3 s. Útil como plan B o pruebas.
// ───────────────────────────────────────────────────────────────────────────────
async function createWhisperChunker({ chunkMs, overlapMs, onData, onError, onEnd }) {
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const buffers = [];
  let bytes = 0;
  let timer = null;
  let ended = false;

  const flush = async () => {
    timer = null;
    try {
      if (bytes === 0) {
        schedule();
        return;
      }
      const audio = Buffer.concat(buffers);
      // Mantener solape
      const keepFrom = Math.max(0, audio.length - msToBytes(overlapMs));
      const tail = audio.subarray(keepFrom);

      // Enviar chunk a Whisper (usa Blob disponible en Node 18+)
      const file = new Blob([audio], { type: 'audio/mulaw' });
      const resp = await openai.audio.transcriptions.create({
        file,
        model: 'whisper-1',
        language: 'es',
      });

      onData?.({
        engine: 'whisper',
        transcript: resp.text || '',
        isFinal: true,
      });

      buffers.length = 0;
      buffers.push(tail);
      bytes = tail.length;
    } catch (e) {
      onError?.(e);
    }
    if (!ended) schedule();
  };

  const schedule = () => {
    if (!timer) timer = setTimeout(flush, chunkMs);
  };

  schedule();

  return {
    write: (buf) => {
      buffers.push(buf);
      bytes += buf.length;
    },
    end: () => {
      ended = true;
      if (timer) clearTimeout(timer);
      onEnd?.();
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// 5) Server HTTP + WebSocket (ruta /twilio-stream para Twilio Media Streams)
// ───────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const ASR_ENGINE = (process.env.ASR_ENGINE || 'google').toLowerCase();

const app = express();

// Healthcheck
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    engine: ASR_ENGINE,
    googleCreds: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
  });
});

const server = app.listen(PORT, () =>
  console.log(`Nexus 360 ASR running on port ${PORT} (engine=${ASR_ENGINE})`),
);

const wss = new WebSocketServer({ server, path: '/twilio-stream' });

wss.on('connection', async (ws) => {
  console.log('[WS] conectado');

  // Call-level state
  let engine;
  const onData = ({ engine: name, transcript, isFinal, confidence }) => {
    const clean = normalizeTranscript(transcript);
    if (!clean) return;
    const msg = {
      type: 'transcript',
      engine: name,
      isFinal: !!isFinal,
      confidence,
      text: clean,
      ts: Date.now(),
    };
    // Envía la transcripción a quien esté conectado (n8n/tu app). Twilio no la usa.
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      console.warn('[WS] no se pudo enviar mensaje al cliente:', e?.message);
    }
    // Log opcional:
    if (isFinal) console.log(`[${name}] ${clean}`);
  };
  const onError = (e) => {
    console.error('[ASR error]', e?.message || e);
    try {
      ws.send(JSON.stringify({ type: 'error', message: String(e) }));
    } catch {}
  };
  const onEnd = () => console.log('[ASR] stream ended');

  // Inicializar motor seleccionado
  try {
    if (ASR_ENGINE === 'google') {
      engine = createGoogleStream({
        config: {
          encoding: process.env.GOOGLE_ENCODING,
          sampleRate: process.env.GOOGLE_SAMPLE_RATE,
          language: process.env.GOOGLE_LANGUAGE,
          model: process.env.GOOGLE_MODEL,
          useEnhanced: process.env.GOOGLE_USE_ENHANCED,
        },
        onData,
        onError,
        onEnd,
      });
    } else if (ASR_ENGINE === 'whisper') {
      engine = await createWhisperChunker({
        chunkMs: Number(process.env.WHISPER_CHUNK_MS) || 5000,
        overlapMs: Number(process.env.WHISPER_OVERLAP_MS) || 1000,
        onData,
        onError,
        onEnd,
      });
    } else {
      throw new Error(`ASR_ENGINE desconocido: ${ASR_ENGINE}`);
    }
  } catch (e) {
    onError(e);
    ws.close();
    return;
  }

  // Manejo de frames Twilio Media Streams
  ws.on('message', (raw) => {
    try {
      const evt = JSON.parse(raw.toString());
      switch (evt.event) {
        case 'start':
          console.log('[Twilio] stream start', evt.start?.callSid || '');
          break;
        case 'media': {
          // Audio μ-law 8kHz en base64
          const payload = evt.media?.payload;
          if (payload && engine?.write) {
            const audio = Buffer.from(payload, 'base64');
            engine.write(audio);
          }
          break;
        }
        case 'stop':
          console.log('[Twilio] stream stop');
          engine?.end?.();
          ws.close();
          break;
        default:
          // Ignora otros eventos (mark, dtmf, etc.)
          break;
      }
    } catch (e) {
      console.error('[WS] mensaje no parseable', e?.message || e);
    }
  });

  ws.on('close', () => {
    try { engine?.end?.(); } catch {}
    console.log('[WS] cerrado');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 6) Nota TwiML para pruebas (ejemplo):
// <Response>
//   <Connect>
//     <Stream url="wss://TU-APP.herokuapp.com/twilio-stream" />
//   </Connect>
// </Response>
// ───────────────────────────────────────────────────────────────────────────────
