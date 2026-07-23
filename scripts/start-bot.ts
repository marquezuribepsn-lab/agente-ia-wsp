import "./env-loader";
import path from "node:path";
import fs from "node:fs";
import { start, shutdown, getSocket } from "../src/lib/baileys/client";
import { sendHumanLike } from "../src/lib/baileys/send";
import { getPendingOutbox, markOutboxSent } from "../src/lib/db";

const RESTART_FLAG = path.resolve(process.cwd(), "data", ".restart");
const AUTH_DIR = path.resolve(process.cwd(), "auth");

// sendHumanLike ahora mete un delay real (2.5-5s + tiempo de "escribiendo...")
// entre cada envío, así que un lote de 20 pendientes puede tardar bastante
// más que los 2s del interval. Este guard evita que dos corridas se pisen y
// manden el mismo pendiente dos veces.
let processingOutbox = false;

async function processOutbox(): Promise<void> {
  if (processingOutbox) return;
  processingOutbox = true;

  try {
    const sock = getSocket();
    if (!sock) return;

    const pending = getPendingOutbox(20);
    for (const item of pending) {
      // item.phone es el JID completo de WhatsApp (@s.whatsapp.net o @lid),
      // no un número de teléfono suelto — ver handler.ts.
      try {
        await sendHumanLike(sock, item.phone, item.content);
        markOutboxSent(item.id);
        console.log(`[bot] → (outbox) Enviado a ${item.phone}`);
      } catch (err) {
        // Dejamos sent=0: se reintenta solo en el próximo tick (útil si la
        // conexión cayó de forma transitoria).
        console.error(
          `[bot] Error enviando outbox #${item.id} a ${item.phone}:`,
          err
        );
      }
    }
  } finally {
    processingOutbox = false;
  }
}

async function checkRestartFlag(): Promise<void> {
  if (!fs.existsSync(RESTART_FLAG)) return;

  console.log(
    "[bot] Flag de reinicio detectado. Desconectando y borrando sesión..."
  );
  fs.unlinkSync(RESTART_FLAG);
  await shutdown();
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  await start();
}

async function main(): Promise<void> {
  console.log("[bot] Iniciando agente de WhatsApp...");
  await start();

  setInterval(() => {
    processOutbox().catch((err) =>
      console.error("[bot] Error procesando outbox:", err)
    );
  }, 2000);

  setInterval(() => {
    checkRestartFlag().catch((err) =>
      console.error("[bot] Error chequeando flag de reinicio:", err)
    );
  }, 1000);
}

main().catch((err) => {
  console.error("[bot] Error fatal iniciando el bot:", err);
  process.exit(1);
});
