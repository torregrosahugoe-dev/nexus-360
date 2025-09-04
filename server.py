import asyncio
import base64
import json
import os
from google.oauth2 import service_account
from google.cloud import speech
import websockets

# --- Configuración de Google Speech-to-Text ---
# Carga las credenciales desde la variable de entorno de Heroku
credentials_json_str = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
credentials_info = json.loads(credentials_json_str)
credentials = service_account.Credentials.from_service_account_info(credentials_info)

speech_client = speech.SpeechClient(credentials=credentials)

# Configuración para la transcripción en streaming
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
