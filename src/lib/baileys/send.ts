import type { BaileysSocket } from "./client";

// Medidas anti-baneo: WhatsApp puede marcar como spam (y forzar un cierre de
// sesión) a una cuenta que responde instantáneamente o dispara mensajes en
// ráfaga (patrón típico de bot). Este módulo centraliza TODO el envío
// saliente (respuestas de IA y mensajes humanos encolados) para garantizar:
//   1. Una separación mínima aleatoria entre CUALQUIER par de mensajes
//      salientes, sin importar a qué conversación vayan.
//   2. Un delay de "escribiendo..." proporcional al largo del mensaje antes
//      de enviarlo, con presencia (composing/paused) real.
//   3. Un techo duro de mensajes por hora: si algo (un bug, un loop del LLM)
//      generara envíos en cantidad, esto corta antes de que se vuelva un
//      patrón de spam real.
//
// OJO: esto reduce el riesgo de baneo por comportamiento de ENVÍO, pero no
// es lo único que importa. Re-vincular el dispositivo muchas veces seguidas
// (escanear QR, desconectar y reconectar) y tener más de un dispositivo
// automatizado linkeado a la vez son señales igual o más fuertes para la
// detección de WhatsApp — evitar eso es responsabilidad de cómo se opera el
// bot, no algo que este archivo pueda resolver.

const MIN_GAP_MS = 4000;
const EXTRA_JITTER_MS = 4000;
const TYPING_MS_PER_CHAR = 45;
const MIN_TYPING_MS = 1500;
const MAX_TYPING_MS = 8000;

const MAX_SENDS_PER_WINDOW = 30;
const WINDOW_MS = 60 * 60 * 1000; // 1 hora

let nextAllowedSendAt = 0;
const recentSendTimestamps: number[] = [];

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
  sock: BaileysSocket,
  jid: string,
  text: string
): Promise<void> {
  assertUnderRateLimit();

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
