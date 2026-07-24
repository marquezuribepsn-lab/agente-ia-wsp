import { Client, LocalAuth } from "whatsapp-web.js";
import path from "node:path";
import qrcodeTerminal from "qrcode-terminal";
import { setConnectionState, getConnectionState } from "../db";
import { handleIncomingMessage, handleOwnSentMessage } from "./handler";

export type WhatsAppClient = Client;

const AUTH_DIR = path.resolve(process.cwd(), "auth");

let client: Client | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function getClient(): Client | null {
  return client;
}

export async function start(): Promise<void> {
  const current = getConnectionState();
  if (current.status === "disconnected") {
    setConnectionState({ status: "connecting" });
  }

  const newClient = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
    puppeteer: {
      headless: true,
      // En Docker usamos el Chromium del sistema (instalado vía apt, ver
      // Dockerfile) en vez del que Puppeteer bajaría por su cuenta — más
      // liviano y confiable en contenedores. En Windows queda undefined y
      // Puppeteer usa el Chrome que bajó `npm run setup:chromium`.
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      // --no-sandbox es obligatorio para correr como root en Docker (VPS).
      // --disable-dev-shm-usage evita crashes en contenedores con /dev/shm chico.
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    },
  });

  client = newClient;

  newClient.on("qr", (qr) => {
    console.log(
      "[bot] QR recibido. Escaneá desde el dashboard en localhost:3000 (o desde la terminal abajo)."
    );
    qrcodeTerminal.generate(qr, { small: true });
    setConnectionState({ status: "qr", qr_string: qr, phone: null });
  });

  newClient.on("ready", () => {
    const phone = newClient.info?.wid?.user ?? null;
    console.log(`[bot] Conectado. Número: ${phone}`);
    setConnectionState({ status: "connected", qr_string: null, phone });
  });

  newClient.on("disconnected", (reason) => {
    console.log(`[bot] Conexión cerrada (reason=${reason})`);

    if (reason === "LOGOUT") {
      console.log(
        "[bot] Sesión cerrada desde el teléfono. Esperando que escaneen un nuevo QR."
      );
      setConnectionState({
        status: "disconnected",
        qr_string: null,
        phone: null,
      });
      return;
    }

    // Cualquier otro motivo: no tocamos el estado en DB (para no pisar
    // 'connected' mientras reconectamos). Si hace falta un QR nuevo, el
    // evento 'qr' lo va a sobreescribir.
    scheduleReconnect();
  });

  newClient.on("auth_failure", (message) => {
    console.error("[bot] Falló la autenticación:", message);
    scheduleReconnect();
  });

  newClient.on("message", (message) => {
    handleIncomingMessage(newClient, message).catch((err) => {
      console.error("[bot] Error procesando mensaje entrante:", err);
    });
  });

  // message_create incluye TODOS los mensajes (propios y ajenos). Lo usamos
  // solo para detectar respuestas del dueño en su chat consigo mismo — los
  // mensajes de clientes ya se manejan en 'message' arriba.
  newClient.on("message_create", (message) => {
    if (!message.fromMe) return;
    handleOwnSentMessage(newClient, message).catch((err) => {
      console.error("[bot] Error procesando mensaje propio:", err);
    });
  });

  await newClient.initialize();
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  const delay = 5000;
  console.log(`[bot] Reintentando conexión en ${delay / 1000}s...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    const dead = client;
    client = null;
    if (dead) {
      dead.destroy().catch(() => {
        // el cliente puede haber quedado en un estado raro, no importa
      });
    }
    start().catch((err) => {
      console.error("[bot] Error reiniciando la conexión:", err);
    });
  }, delay);
}

export async function shutdown(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (client) {
    const current = client;
    client = null;
    try {
      await current.logout();
    } catch (err) {
      console.warn("[bot] Error en logout (puede ser normal):", err);
    }
    try {
      await current.destroy();
    } catch {
      // ignore
    }
  }
}
