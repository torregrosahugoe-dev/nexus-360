// openai-handler.js
import OpenAI from 'openai';
import menu from './menu.json' assert { type: 'json' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const menuItems = Object.keys(menu.items).join(', ');

export async function processTranscript(transcript, conversationHistory = []) {
  const messages = [
    {
      role: 'system',
      content: `Eres un asistente de voz para tomar pedidos en "Nexus 360". El menú es: ${menuItems}.
      Tu tarea es conversar con el cliente para armar su pedido.
      RESPONDE SIEMPRE CON UN OBJETO JSON con la siguiente estructura:
      {
        "responseText": "Tu respuesta conversacional para el cliente. Sé breve y amigable.",
        "action": "CONTINUE", // o "CONFIRM_ORDER" si el cliente ya no quiere nada más.
        "orderItems": ["item1", "item2"] // Solo los items que el cliente mencionó en ESTE turno.
      }
      Ejemplo: si el usuario dice 'quiero una pizza', tu respuesta JSON sería:
      {"responseText": "Claro, una pizza. ¿Algo más?","action": "CONTINUE","orderItems": ["pizza"]}
      `
    },
    ...conversationHistory, // Carga el historial para tener contexto
    {
      role: 'user',
      content: transcript
    }
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messages,
      response_format: { type: "json_object" }, // ¡Forzamos la respuesta a ser JSON!
    });

    const responseContent = completion.choices[0].message.content;
    return JSON.parse(responseContent);

  } catch (error) {
    console.error("Error al procesar con OpenAI:", error);
    return {
      responseText: "Lo siento, estoy teniendo problemas para procesar tu pedido. Intenta de nuevo.",
      action: "CONTINUE",
      orderItems: []
    };
  }
}
