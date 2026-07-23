import type { KnowledgeSearchResult } from "./db";

// Personalizá este texto con el tono y la información de tu negocio. El
// resto del prompt (base de conocimiento, memoria del cliente, protocolo de
// escalamiento) se arma solo en buildSystemPrompt() y no hace falta tocarlo.
export const SYSTEM_PROMPT = `
Eres un asistente virtual amable. Responde en español neutro,
en mensajes breves de 2 a 4 líneas. No uses emojis.
`.trim();

const PROTOCOL_INSTRUCTIONS = `
Instrucciones importantes sobre cómo responder:
- Si la información disponible arriba NO alcanza para responder con certeza
  la pregunta del cliente, no inventes ni asumas nada. En vez de responder
  normalmente, escribí ÚNICAMENTE una línea con este formato exacto (sin
  nada más antes ni después):
  NO_SE: <resumen breve y claro de la pregunta del cliente>
- Si durante la charla te enterás de un dato nuevo y útil sobre ESTE
  cliente en particular (una preferencia, algo que ya compró, un dato de
  contacto, etc.), agregá al final de tu respuesta una línea nueva con este
  formato exacto:
  MEMORIA: <el dato nuevo, en una oración corta>
  Si no hay ningún dato nuevo que valga la pena recordar, no agregues esa
  línea.
`.trim();

export function buildSystemPrompt(params: {
  memory?: string | null;
  knowledgeChunks?: KnowledgeSearchResult[];
  includeProtocol?: boolean;
}): string {
  const parts = [SYSTEM_PROMPT];

  const chunks = params.knowledgeChunks ?? [];
  if (chunks.length > 0) {
    const context = chunks
      .map((c) => `[${c.filename}]\n${c.content}`)
      .join("\n\n---\n\n");
    parts.push(
      `Información disponible para responder (extraída de los archivos cargados):\n\n${context}`
    );
  } else {
    parts.push(
      "No hay información cargada en la base de conocimiento todavía."
    );
  }

  if (params.memory) {
    parts.push(
      `Datos conocidos sobre este cliente en particular:\n${params.memory}`
    );
  }

  if (params.includeProtocol !== false) {
    parts.push(PROTOCOL_INSTRUCTIONS);
  }

  return parts.join("\n\n");
}
