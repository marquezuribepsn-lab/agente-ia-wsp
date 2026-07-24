import type { Message } from "whatsapp-web.js";
import type { WhatsAppClient } from "./client";
import { sendHumanLike, isOwnSentMessage } from "./send";
import {
  getOrCreateConversation,
  insertMessage,
  getConversationById,
  getRecentHistory,
  appendConversationMemory,
  insertDocument,
  createEscalation,
  findEscalationByOwnerMessageId,
  getPendingEscalationById,
  setEscalationOwnerMessageId,
  resolveEscalation,
  type Conversation,
} from "../db";
import { generateReply, generateFollowUpReply, type ParsedReply } from "../llm";
import { formatJidForDisplay } from "../format";

const HOLDING_MESSAGE =
  "Dejame confirmar esa información y te aviso en un rato.";

export async function handleIncomingMessage(
  client: WhatsAppClient,
  message: Message
): Promise<void> {
  if (message.fromMe) return;
  if (message.isStatus) return;
  if (!message.body) return; // audio/imagen/sticker fuera del scope v1

  const chat = await message.getChat();
  if (chat.isGroup) return;

  const chatId = chat.id._serialized;
  const contact = await message.getContact();
  const pushName = contact.pushname || contact.name || undefined;

  const convo = getOrCreateConversation(chatId, pushName);

  console.log(`[bot] ← Mensaje de ${chatId}: "${message.body}"`);
  insertMessage(convo.id, "user", message.body);

  // Marcar como leído: una cuenta humana real lee los mensajes que le
  // llegan. No hacerlo es una señal más de comportamiento de bot.
  try {
    await chat.sendSeen();
  } catch (err) {
    console.warn("[bot] No se pudo marcar el mensaje como leído:", err);
  }

  // Re-leemos por si el modo cambió entre la creación de la conversación y este check.
  const fresh = getConversationById(convo.id);
  if (!fresh || fresh.mode !== "AI") return;

  const history = getRecentHistory(convo.id, 20);
  console.log(`[bot] llamando LLM con ${history.length} mensajes...`);

  const startedAt = Date.now();
  let parsed: ParsedReply;
  try {
    parsed = await generateReply(history, fresh.memory);
  } catch (err) {
    console.error("[bot] Error llamando al LLM:", err);
    return;
  }
  console.log(`[bot] LLM respondió en ${Date.now() - startedAt}ms`);

  if (parsed.memoryUpdate) {
    appendConversationMemory(convo.id, parsed.memoryUpdate);
  }

  if (parsed.escalationQuestion) {
    insertMessage(convo.id, "assistant", HOLDING_MESSAGE);
    await sendHumanLike(client, chatId, HOLDING_MESSAGE);
    console.log(`[bot] → (holding) Enviado a ${chatId}`);
    await escalateToOwner(client, fresh, parsed.escalationQuestion);
    return;
  }

  insertMessage(convo.id, "assistant", parsed.customerReply);

  // sendHumanLike aplica un delay de "escribiendo..." + separación mínima
  // entre envíos, para no responder de forma instantánea/robótica.
  await sendHumanLike(client, chatId, parsed.customerReply);
  console.log(`[bot] → Enviado a ${chatId}`);
}

async function escalateToOwner(
  client: WhatsAppClient,
  convo: Conversation,
  question: string
): Promise<void> {
  const ownJid = client.info?.wid?._serialized;
  if (!ownJid) return;

  const customerLabel = convo.name || formatJidForDisplay(convo.phone);

  // Creamos la escalación primero para tener el ID: así el dueño puede
  // responder citando el mensaje O escribiendo "#<id> respuesta" como
  // respaldo si por algún motivo la cita no queda registrada.
  const escalation = createEscalation(convo.id, question, null);

  const text =
    `❓ [#${escalation.id}] ${customerLabel} pregunta:\n"${question}"\n\n` +
    `No lo encontré en la base de conocimiento. Respondé CITANDO este ` +
    `mensaje (mantené presionado → Responder) con la información, o ` +
    `escribí "#${escalation.id} " seguido de la respuesta.`;

  const sent = await sendHumanLike(client, ownJid, text);
  setEscalationOwnerMessageId(escalation.id, sent.id._serialized);
  console.log(`[bot] → Escalé pregunta #${escalation.id} al dueño`);
}

// Disparado para CUALQUIER mensaje fromMe=true (message_create), incluyendo
// los que manda nuestro propio código. Filtramos esos ecos y solo procesamos
// mensajes reales tipeados por el dueño en su chat consigo mismo.
export async function handleOwnSentMessage(
  client: WhatsAppClient,
  message: Message
): Promise<void> {
  if (isOwnSentMessage(message.id._serialized)) return;
  if (!message.body) return;

  const ownJid = client.info?.wid?._serialized;
  if (!ownJid) return;

  const chat = await message.getChat();
  if (chat.id._serialized !== ownJid) return; // no es el chat consigo mismo

  let escalation = null;
  if (message.hasQuotedMsg) {
    const quoted = await message.getQuotedMessage();
    escalation = findEscalationByOwnerMessageId(quoted.id._serialized);
  }

  let answerText = message.body;
  if (!escalation) {
    const hashMatch = message.body.match(/^\s*#(\d+)\s+([\s\S]+)$/);
    if (hashMatch) {
      escalation = getPendingEscalationById(Number(hashMatch[1]));
      answerText = hashMatch[2].trim();
    }
  }

  if (!escalation) return; // no es una respuesta a ninguna pregunta pendiente

  console.log(
    `[bot] ← Respuesta del dueño para #${escalation.id}: "${answerText}"`
  );
  resolveEscalation(escalation.id, answerText);

  insertDocument(`Pregunta respondida #${escalation.id}`, [
    `Pregunta: ${escalation.question}\nRespuesta: ${answerText}`,
  ]);

  const convo = getConversationById(escalation.conversation_id);

  if (!convo) {
    await sendHumanLike(
      client,
      ownJid,
      `Guardé la respuesta para la #${escalation.id}, pero no encontré la conversación original.`
    );
    return;
  }

  if (convo.mode !== "AI") {
    await sendHumanLike(
      client,
      ownJid,
      `Guardé tu respuesta en la base de conocimiento, pero la conversación con ` +
        `${convo.name || formatJidForDisplay(convo.phone)} está en modo Humano ` +
        `así que no le mandé nada automático — respondele vos desde el dashboard.`
    );
    return;
  }

  const history = getRecentHistory(convo.id, 20);
  let parsed: ParsedReply;
  try {
    parsed = await generateFollowUpReply(
      history,
      convo.memory,
      escalation.question,
      answerText
    );
  } catch (err) {
    console.error("[bot] Error generando la respuesta de seguimiento:", err);
    return;
  }

  if (parsed.memoryUpdate) {
    appendConversationMemory(convo.id, parsed.memoryUpdate);
  }

  const finalReply = parsed.customerReply || answerText;
  insertMessage(convo.id, "assistant", finalReply);
  await sendHumanLike(client, convo.phone, finalReply);
  console.log(
    `[bot] → Enviado seguimiento de #${escalation.id} a ${convo.phone}`
  );

  await sendHumanLike(
    client,
    ownJid,
    `Listo, ya le respondí a ${convo.name || formatJidForDisplay(convo.phone)}. ` +
      "Guardé tu respuesta para la próxima vez que pregunten algo parecido."
  );
}
