import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./system-prompt";
import type { Message } from "./db";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "Falta OPENROUTER_API_KEY en las variables de entorno. Configurala en .env.local."
    );
  }
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });
  }
  return client;
}

export async function generateReply(history: Message[]): Promise<string> {
  const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map(
      (m): OpenAI.Chat.ChatCompletionMessageParam => ({
        // Los mensajes 'human' salieron del lado del bot (dashboard), así que
        // el LLM debe verlos como respuestas suyas previas.
        role: m.role === "human" ? "assistant" : m.role,
        content: m.content,
      })
    ),
  ];

  const completion = await getClient().chat.completions.create({
    model,
    messages,
  });

  const reply = completion.choices[0]?.message?.content;
  if (!reply) {
    throw new Error("El LLM no devolvió contenido en la respuesta.");
  }
  return reply.trim();
}
