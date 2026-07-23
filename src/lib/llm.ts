import OpenAI from "openai";
import { buildSystemPrompt } from "./system-prompt";
import { searchKnowledgeBase, type Message } from "./db";

// Proveedor de LLM configurable vía env vars — cualquier API compatible con
// el formato de OpenAI sirve (OpenRouter, Groq, Google Gemini, OpenAI
// directo, etc.), no está atado a uno en particular.
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!process.env.LLM_API_KEY) {
    throw new Error(
      "Falta LLM_API_KEY en las variables de entorno. Configurala en .env.local."
    );
  }
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.LLM_API_KEY,
      baseURL: process.env.LLM_BASE_URL || DEFAULT_BASE_URL,
    });
  }
  return client;
}

export interface ParsedReply {
  /** Texto final para mandarle al cliente (puede venir vacío si se escaló). */
  customerReply: string;
  /** Dato nuevo sobre el cliente que el modelo marcó con MEMORIA:, si hubo. */
  memoryUpdate: string | null;
  /** Pregunta que el modelo no pudo responder (marcada con NO_SE:), si hubo. */
  escalationQuestion: string | null;
}

// Interpreta la convención de marcadores en texto plano que usamos para que
// el mismo llamado al LLM devuelva, además de la respuesta, si hay que
// escalar la pregunta o si aprendió algo nuevo del cliente — sin necesitar
// una segunda llamada ni depender de que el modelo soporte "JSON mode"
// (distintos proveedores/modelos varían mucho en ese soporte).
export function parseModelOutput(raw: string): ParsedReply {
  const lines = raw.split(/\r?\n/);
  const replyLines: string[] = [];
  let memoryUpdate: string | null = null;
  let escalationQuestion: string | null = null;

  for (const line of lines) {
    const noSeMatch = line.match(/^\s*NO_SE:\s*(.+)$/i);
    const memoriaMatch = line.match(/^\s*MEMORIA:\s*(.+)$/i);
    if (noSeMatch) {
      escalationQuestion = noSeMatch[1].trim();
    } else if (memoriaMatch) {
      memoryUpdate = memoriaMatch[1].trim();
    } else {
      replyLines.push(line);
    }
  }

  return {
    customerReply: replyLines.join("\n").trim(),
    memoryUpdate,
    escalationQuestion,
  };
}

function toOpenAiMessage(m: Message): OpenAI.Chat.ChatCompletionMessageParam {
  return {
    // Los mensajes 'human' salieron del lado del bot (dashboard), así que
    // el LLM debe verlos como respuestas suyas previas.
    role: m.role === "human" ? "assistant" : m.role,
    content: m.content,
  };
}

async function callModel(
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
): Promise<ParsedReply> {
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;

  const completion = await getClient().chat.completions.create({
    model,
    messages,
  });

  // Algunos proveedores devuelven una respuesta de error/rate-limit con
  // HTTP 200 pero sin "choices" (en vez de tirar una excepción). Chequeamos
  // explícito para dar un error claro en logs en vez de un TypeError críptico.
  if (!Array.isArray(completion.choices) || completion.choices.length === 0) {
    console.error(
      "[llm] Respuesta sin 'choices':",
      JSON.stringify(completion)
    );
    throw new Error(
      "El LLM no devolvió 'choices' en la respuesta (puede ser un límite de rate del proveedor)."
    );
  }

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    throw new Error("El LLM no devolvió contenido en la respuesta.");
  }

  return parseModelOutput(raw);
}

export async function generateReply(
  history: Message[],
  memory: string | null
): Promise<ParsedReply> {
  const lastUserMessage = [...history].reverse().find((m) => m.role === "user");
  const knowledgeChunks = lastUserMessage
    ? searchKnowledgeBase(lastUserMessage.content, 5)
    : [];

  const systemPrompt = buildSystemPrompt({ memory, knowledgeChunks });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map(toOpenAiMessage),
  ];

  return callModel(messages);
}

// Se usa después de que el dueño responde una pregunta escalada: ya
// tenemos la respuesta correcta, así que no hace falta volver a buscar en
// la base de conocimiento ni permitir un nuevo escalamiento.
export async function generateFollowUpReply(
  history: Message[],
  memory: string | null,
  originalQuestion: string,
  ownerAnswer: string
): Promise<ParsedReply> {
  const systemPrompt = buildSystemPrompt({
    memory,
    knowledgeChunks: [],
    includeProtocol: false,
  });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map(toOpenAiMessage),
    {
      role: "system",
      content:
        `El dueño del negocio te dio esta información para responder la ` +
        `pregunta pendiente "${originalQuestion}": "${ownerAnswer}". ` +
        `Respondele ahora al cliente de forma natural usando este dato, ` +
        `como si lo hubieras sabido desde el principio.`,
    },
  ];

  return callModel(messages);
}
