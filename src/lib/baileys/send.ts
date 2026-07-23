import type { BaileysSocket } from "./client";

// Medidas anti-baneo: WhatsApp puede marcar como spam a una cuenta que
// responde instantáneamente o dispara mensajes en ráfaga (patrón típico de
// bot). Este módulo centraliza TODO el envío saliente (respuestas de IA y
// mensajes humanos encolados) para garantizar:
//   1. Una separación mínima aleatoria entre CUALQUIER par de mensajes
//      salientes, sin importar a qué conversación vayan.
//   2. Un delay de "escribiendo..." proporcional al largo del mensaje antes
//      de enviarlo, con presencia (composing/paused) real.

const MIN_GAP_MS = 2500;
const EXTRA_JITTER_MS = 2500;
const TYPING_MS_PER_CHAR = 40;
const MIN_TYPING_MS = 1200;
const MAX_TYPING_MS = 6000;

let nextAllowedSendAt = 0;

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

export async function sendHumanLike(
  sock: BaileysSocket,
  jid: string,
  text: string
): Promise<void> {
  const waitMs = claimSendSlot();
  if (waitMs > 0) await sleep(waitMs);

  const typingMs = clamp(
    text.length * TYPING_MS_PER_CHAR,
    MIN_TYPING_MS,
    MAX_TYPING_MS
  );

  try {
    await sock.sendPresenceUpdate("composing", jid);
  } catch {
    // no es crítico si falla la presencia, seguimos igual con el envío
  }

  await sleep(typingMs);

  try {
    await sock.sendPresenceUpdate("paused", jid);
  } catch {
    // ignore
  }

  await sock.sendMessage(jid, { text });
}
