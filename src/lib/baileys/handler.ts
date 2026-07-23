import {
  isJidUser,
  isLidUser,
  jidNormalizedUser,
  type WAMessage,
  type MessageUpsertType,
} from "@whiskeysockets/baileys";
import type { BaileysSocket } from "./client";
import { sendHumanLike } from "./send";
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

export async function handleIncomingMessages(
  sock: BaileysSocket,
  payload: { messages: WAMessage[]; type: MessageUpsertType }
): Promise<void> {
  if (payload.type !== "notify") return;

  for (const msg of payload.messages) {
    await handleSingleMessage(sock, msg);
  }
}

async function handleSingleMessage(
  sock: BaileysSocket,
  msg: WAMessage
): Promise<void> {
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid) return;

  const text =
    msg.message?.conversation ?? msg.message?.extendedTextMessage?.text;
  if (!text) return;

  const ownJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
  const isSelfChat = !!ownJid && jidNormalizedUser(remoteJid) === ownJid;

  if (msg.key.fromMe) {
    // Solo nos interesan los mensajes que el dueño se manda a sí mismo (para
    // responder una pregunta escalada). Cualquier otro mensaje saliente
    // (charla normal con otro contacto desde el teléfono) no nos incumbe.
    if (isSelfChat) {
      await handleOwnerReply(sock, msg, text);
    }
    return;
  }

  // Chats 1:1 reales: JID clásico basado en número (@s.whatsapp.net) o el
  // esquema de privacidad más nuevo de WhatsApp (@lid, "Linked ID"), que
  // oculta el número real. Todo lo demás (grupos, newsletters, broadcasts,
  // status) queda fuera del scope v1.
  if (!isJidUser(remoteJid) && !isLidUser(remoteJid)) return;

  const convo = getOrCreateConversation(remoteJid, msg.pushName ?? undefined);

  console.log(`[bot] ← Mensaje de ${remoteJid}: "${text}"`);
  insertMessage(convo.id, "user", text);

  // Marcar como leído: una cuenta humana real lee los mensajes que le
  // llegan. No hacerlo es una señal más de comportamiento de bot.
  try {
    await sock.readMessages([msg.key]);
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
    await sendHumanLike(sock, remoteJid, HOLDING_MESSAGE);
    console.log(`[bot] → (holding) Enviado a ${remoteJid}`);
    await escalateToOwner(sock, fresh, parsed.escalationQuestion);
    return;
  }

  insertMessage(convo.id, "assistant", parsed.customerReply);

  // sendHumanLike aplica un delay de "escribiendo..." + separación mínima
  // entre envíos, para no responder de forma instantánea/robótica.
  await sendHumanLike(sock, remoteJid, parsed.customerReply);
  console.log(`[bot] → Enviado a ${remoteJid}`);
}

async function escalateToOwner(
  sock: BaileysSocket,
  convo: Conversation,
  question: string
): Promise<void> {
  const ownJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
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

  const sent = await sendHumanLike(sock, ownJid, text);
  const ownerMessageId = sent?.key?.id ?? null;
  if (ownerMessageId) {
    setEscalationOwnerMessageId(escalation.id, ownerMessageId);
  }
  console.log(`[bot] → Escalé pregunta #${escalation.id} al dueño`);
}

async function handleOwnerReply(
  sock: BaileysSocket,
  msg: WAMessage,
  text: string
): Promise<void> {
  const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
  let escalation = quotedId ? findEscalationByOwnerMessageId(quotedId) : null;

  let answerText = text;
  if (!escalation) {
    const hashMatch = text.match(/^\s*#(\d+)\s+([\s\S]+)$/);
    if (hashMatch) {
      escalation = getPendingEscalationById(Number(hashMatch[1]));
      answerText = hashMatch[2].trim();
    }
  }

  if (!escalation) return; // no es una respuesta a ninguna pregunta pendiente

  console.log(`[bot] ← Respuesta del dueño para #${escalation.id}: "${answerText}"`);
  resolveEscalation(escalation.id, answerText);

  insertDocument(`Pregunta respondida #${escalation.id}`, [
    `Pregunta: ${escalation.question}\nRespuesta: ${answerText}`,
  ]);

  const convo = getConversationById(escalation.conversation_id);
  const ownJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;

  if (!convo) {
    if (ownJid) {
      await sendHumanLike(
        sock,
        ownJid,
        `Guardé la respuesta para la #${escalation.id}, pero no encontré la conversación original.`
      );
    }
    return;
  }

  if (convo.mode !== "AI") {
    if (ownJid) {
      await sendHumanLike(
        sock,
        ownJid,
        `Guardé tu respuesta en la base de conocimiento, pero la conversación con ` +
          `${convo.name || formatJidForDisplay(convo.phone)} está en modo Humano ` +
          `así que no le mandé nada automático — respondele vos desde el dashboard.`
      );
    }
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
  await sendHumanLike(sock, convo.phone, finalReply);
  console.log(`[bot] → Enviado seguimiento de #${escalation.id} a ${convo.phone}`);

  if (ownJid) {
    await sendHumanLike(
      sock,
      ownJid,
      `Listo, ya le respondí a ${convo.name || formatJidForDisplay(convo.phone)}. ` +
        "Guardé tu respuesta para la próxima vez que pregunten algo parecido."
    );
  }
}
