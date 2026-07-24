import type { Message } from "whatsapp-web.js";
import type { WhatsAppClient } from "./client";

// Medidas anti-baneo: WhatsApp puede forzar el cierre de sesión (y banear) a
// una cuenta que responde instantáneamente o dispara mensajes en ráfaga
// (patrón típico de bot). Este módulo centraliza TODO el envío saliente
// (respuestas de IA y mensajes humanos encolados) para garantizar:
//   1. Una separación mínima aleatoria entre CUALQUIER par de mensajes
//      salientes, sin importar a qué conversación vayan.
//   2. Un delay de "escribiendo..." proporcional al largo del mensaje antes
//      de enviarlo, con presencia (typing) real.
//   3. Un techo duro de mensajes por hora: si algo (un bug, un loop del LLM)
//      generara envíos en cantidad, esto corta antes de que se vuelva un
//      patrón de spam real.
//
// OJO: esto reduce el riesgo de baneo por comportamiento de ENVÍO, pero no
// es lo único que importa. Re-vincular el dispositivo muchas veces seguidas
// y tener más de un dispositivo automatizado linkeado a la vez son señales
// igual o más fuertes para la detección de WhatsApp.

const MIN_GAP_MS = 4000;
const EXTRA_JITTER_MS = 4000;
const TYPING_MS_PER_CHAR = 45;
const MIN_TYPING_MS = 1500;
const MAX_TYPING_MS = 8000;

const MAX_SENDS_PER_WINDOW = 30;
const WINDOW_MS = 60 * 60 * 1000; // 1 hora

let nextAllowedSendAt = 0;
const recentSendTimestamps: number[] = [];

// IDs de mensajes que mandamos nosotros mismos, para poder distinguir en el
// evento 'message_create' un mensaje propio (eco de nuestro propio envío) de
// una respuesta real que el dueño tipeó en su teléfono en el chat consigo
// mismo — ambos llegan como fromMe=true.
const ownSentMessageIds = new Set<string>();
const OWN_SENT_IDS_MAX = 200;

export function isOwnSentMessage(messageId: string): boolean {
  return ownSentMessageIds.has(messageId);
}

function trackOwnSentMessage(messageId: string): void {
  ownSentMessageIds.add(messageId);
  if (ownSentMessageIds.size > OWN_SENT_IDS_MAX) {
    const oldest = ownSentMessageIds.values().next().value;
    if (oldest !== undefined) ownSentMessageIds.delete(oldest);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// "Toma un turno": reserva el próximo slot de envío de forma síncrona (JS es
// single-threaded, así que dos llamadas en el mismo tick no pueden pisarse)
// y devuelve cuánto hay que esperar para que le toque a este mensaje.
function claimSendSlot(): number {
  const now = Date.now();
  const jitter = Math.random() * EXTRA_JITTER_MS;
  const myTurn = Math.max(now, nextAllowedSendAt);
  nextAllowedSendAt = myTurn + MIN_GAP_MS + jitter;
  return myTurn - now;
}

function assertUnderRateLimit(): void {
  const now = Date.now();
  while (
    recentSendTimestamps.length > 0 &&
    now - recentSendTimestamps[0] > WINDOW_MS
  ) {
    recentSendTimestamps.shift();
  }
  if (recentSendTimestamps.length >= MAX_SENDS_PER_WINDOW) {
    throw new Error(
      `Límite de ${MAX_SENDS_PER_WINDOW} mensajes/hora alcanzado. ` +
        "Se frena el envío como protección anti-baneo (revisar si hay un loop/bug)."
    );
  }
  recentSendTimestamps.push(now);
}

export async function sendHumanLike(
  client: WhatsAppClient,
  chatId: string,
  text: string
): Promise<Message> {
  assertUnderRateLimit();

  const waitMs = claimSendSlot();
  if (waitMs > 0) await sleep(waitMs);

  const typingMs = clamp(
    text.length * TYPING_MS_PER_CHAR,
    MIN_TYPING_MS,
    MAX_TYPING_MS
  );

  try {
    const chat = await client.getChatById(chatId);
    await chat.sendStateTyping();
    await sleep(typingMs);
    await chat.clearState();
  } catch (err) {
    // no es crítico si falla la simulación de "escribiendo", seguimos
    // igual con el envío
    console.warn("[bot] No se pudo simular estado de escritura:", err);
    await sleep(typingMs);
  }

  const sent = await client.sendMessage(chatId, text);
  trackOwnSentMessage(sent.id._serialized);
  return sent;
}
