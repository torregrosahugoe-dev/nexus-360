// openai-handler.js
import OpenAI from 'openai';
import menu from './menu.json' assert { type: 'json' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Esta función es el "cerebro". Toma la transcripción y el historial de la conversación.
export async function processTranscript(transcript, conversationHistory = []) {
  const menuItems = Object.keys(menu.items).join(', ');

  // El historial ayuda a GPT a recordar de qué se está hablando.
  const messages = [
    {
      role: 'system',
      content: `Eres un asistente de toma de pedidos para un restaurante llamado Nexus 360. El menú disponible es: ${menuItems}.
      Tu objetivo es identificar los productos que el cliente quiere, agregarlos a un pedido y preguntar si desea algo más.
      Si no entiendes algo, pide que lo repitan.
      Cuando el cliente diga que no quiere nada más, responde con la palabra clave "CONFIRMAR_PEDIDO".
      Si el cliente pregunta por algo que no está en el menú, indícalo amablemente.
      Sé breve y directo.`
    },
    ...conversationHistory, // Historial de turnos anteriores
    {
      role: 'user',
      content: transcript
    }
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // O el modelo que prefieras
      messages: messages,
    });

    const responseText = completion.choices[0].message.content;

    // Puedes agregar lógica más avanzada para extraer los items del pedido aquí.
    // Por ahora, devolvemos la respuesta directa de la IA.
    return responseText;

  } catch (error) {
    console.error("Error al contactar OpenAI:", error);
    return "Lo siento, tuve un problema para procesar tu pedido. Intenta de nuevo.";
  }
}
