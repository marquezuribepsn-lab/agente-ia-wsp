import {
  isJidUser,
  isLidUser,
  type WAMessage,
  type MessageUpsertType,
} from "@whiskeysockets/baileys";
import type { BaileysSocket } from "./client";
import {
  getOrCreateConversation,
  insertMessage,
  getConversationById,
  getRecentHistory,
} from "../db";
import { generateReply } from "../openrouter";
import { sendHumanLike } from "./send";

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
  if (msg.key.fromMe) return;

  // Chats 1:1 reales: JID clásico basado en número (@s.whatsapp.net) o el
  // esquema de privacidad más nuevo de WhatsApp (@lid, "Linked ID"), que
  // oculta el número real. Todo lo demás (grupos, newsletters, broadcasts,
  // status) queda fuera del scope v1.
  if (!isJidUser(remoteJid) && !isLidUser(remoteJid)) return;

  const text =
    msg.message?.conversation ?? msg.message?.extendedTextMessage?.text;
  if (!text) return;

  // Guardamos el JID completo (no solo la parte numérica): con @lid la parte
  // numérica no es un teléfono real, y necesitamos el JID exacto para poder
  // responderle después vía sock.sendMessage.
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
  let reply: string;
  try {
    reply = await generateReply(history);
  } catch (err) {
    console.error("[bot] Error llamando al LLM:", err);
    return;
  }
  console.log(`[bot] LLM respondió en ${Date.now() - startedAt}ms`);

  insertMessage(convo.id, "assistant", reply);

  // sendHumanLike aplica un delay de "escribiendo..." + separación mínima
  // entre envíos, para no responder de forma instantánea/robótica.
  await sendHumanLike(sock, remoteJid, reply);
  console.log(`[bot] → Enviado a ${remoteJid}`);
}
