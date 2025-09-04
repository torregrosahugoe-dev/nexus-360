import asyncio
import base64
import json
import os
from google.oauth2 import service_account
from google.cloud import speech
import websockets

# --- Configuración de Google Speech-to-Text ---
# Carga las credenciales desde la variable de entorno de Heroku
try:
    credentials_json_str = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    credentials_info = json.loads(credentials_json_str)
    credentials = service_account.Credentials.from_service_account_info(credentials_info)
    speech_client = speech.SpeechClient(credentials=credentials)
except (TypeError, json.JSONDecodeError) as e:
    print(f"ERROR: No se pudieron cargar las credenciales de Google. Verifica las Config Vars en Heroku. Error: {e}")
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

# --- Lógica del Servidor WebSocket ---
async def twilio_handler(websocket, path):
    """
    Maneja la conexión WebSocket de Twilio Media Stream.
    """
    print("Conexión de Twilio recibida.")

    if not speech_client:
        print("ERROR: Speech client no está inicializado. Terminando conexión.")
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

# --- Iniciar y mantener el Servidor ---
async def main():
    # Un dyno 'web' en Heroku SIEMPRE tiene la variable PORT
    port = int(os.environ.get("PORT"))
    
    print(f"Servidor WebSocket iniciando en el puerto {port}...")
    
    # Esta sintaxis asegura que el servidor se inicie y se mantenga corriendo
    async with websockets.serve(twilio_handler, "0.0.0.0", port):
        print(f"Servidor escuchando en el puerto {port}.")
        # Esta línea le dice al programa que espere aquí para siempre
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"Error fatal al iniciar el servidor: {e}")
