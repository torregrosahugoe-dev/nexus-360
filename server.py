import asyncio
import base64
import json
import os
from google.oauth2 import service_account
from google.cloud import speech
import websockets

# --- Configuración de Google Speech-to-Text ---
try:
    credentials_json_str = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    credentials_info = json.loads(credentials_json_str)
    credentials = service_account.Credentials.from_service_account_info(credentials_info)
    speech_client = speech.SpeechClient(credentials=credentials)
    print("✅ Credenciales de Google cargadas exitosamente.")
except Exception as e:
    print(f"❌ ERROR: No se pudieron cargar las credenciales de Google. Error: {e}")
    speech_client = None

# --- Configuración para la transcripción en streaming ---
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

# --- Lógica del Servidor WebSocket (la aplicación principal) ---
async def twilio_handler(websocket, path):
    """
    Maneja la conexión WebSocket de Twilio Media Stream.
    """
    print("📞 Conexión de Twilio recibida.")

    if not speech_client:
        print("❌ ERROR: Speech client no está inicializado. Terminando conexión.")
        return

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
                else:
                    print(f"💬 Transcripción Parcial: {result.alternatives[0].transcript}")

    except Exception as e:
        print(f"Error durante la transcripción: {e}")
    finally:
        print("Finalizando transcripción.")

# NO NECESITAMOS MÁS CÓDIGO AQUÍ. uvicorn se encarga del resto.
