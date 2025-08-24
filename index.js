require('dotenv').config();

import twilio from 'twilio';
const { VoiceResponse } = twilio.twiml;
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const express = require('express');
const { twiml } = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));

// Webhook principal para llamadas entrantes
app.post('/voice', (req, res) => {
    const response = new twiml.VoiceResponse();

    // Saludo inicial y espera por la primera entrada de voz del usuario
    const gather = response.gather({
        input: 'speech', // Capturamos voz
        action: '/process-speech', // Enviamos el resultado a este endpoint
        language: 'es-ES', // Especificamos el idioma
        speechTimeout: 'auto', // Twilio decide cuándo termina el usuario de hablar
    });
    gather.say('Hola, bienvenido a Nexus 360. ¿En qué puedo ayudarte hoy?');

    res.type('text/xml');
    res.send(response.toString());
});

// Endpoint para procesar la voz convertida a texto
app.post('/process-speech', (req, res) => {
    const response = new twiml.VoiceResponse();

    // Obtenemos el texto del usuario
    const userSpeech = req.body.SpeechResult;
    console.log(`El usuario dijo: "${userSpeech}"`);

    // Por ahora, solo repetimos lo que dijo para confirmar que funciona
    response.say(`Entendido. Dijiste: ${userSpeech}. Nuestro cerebro de IA se está conectando.`);

    res.type('text/xml');
    res.send(response.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
