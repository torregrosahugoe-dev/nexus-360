import asyncio
import base64
import json
import websockets
from google.cloud import speech

# --- Configuración de Google Speech-to-Text ---
speech_client = speech.SpeechClient()

config = speech.RecognitionConfig(
    encoding=speech.RecognitionConfig.AudioEncoding.MULAW,
    sample_rate_hertz=8000,
    language_code="es-ES",
    model="telephony",
    enable_automatic_punctuation=True,
)

streaming_config = speech.StreamingRecognitionConfig(
    config=config,
    interim_results=True,
)

# --- Lógica del Servidor WebSocket ---
async def twilio_handler(websocket, path):
    """
    Maneja la conexión WebSocket de Twilio Media Stream.
    """
    print("Conexión de Twilio recibida.")

    async def audio_generator():
        async for message in websocket:
            data = json.loads(message)
            if data['event'] == 'media':
                payload = data['media']['payload']
                chunk = base64.b64decode(payload)
                yield speech.StreamingRecognizeRequest(audio_content=chunk)

    requests = audio_generator()
    responses = speech_client.streaming_recognize(
        config=streaming_config,
        requests=requests
    )

    try:
        for response in responses:
            for result in response.results:
                if result.is_final:
                    transcript = result.alternatives[0].transcript
                    print(f"✅ Transcripción Final: {transcript}")
                    # AQUÍ: Envía 'transcript' a tu módulo de LLM (OpenAI)
                else:
                    print(f"💬 Transcripción Parcial: {result.alternatives[0].transcript}")

    except Exception as e:
        print(f"Error durante la transcripción: {e}")
    finally:
        print("Finalizando transcripción.")

import os # Asegúrate de que esta línea esté al inicio del archivo

# --- Iniciar el Servidor ---
async def main():
    # Heroku asigna el puerto a través de una variable de entorno
    port = int(os.environ.get("PORT", 8080))
    server = await websockets.serve(twilio_handler, "0.0.0.0", port)
    print(f"Servidor WebSocket escuchando en el puerto {port}...")
    await server.wait_closed()