import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import path from "node:path";
import qrcodeTerminal from "qrcode-terminal";
import { setConnectionState, getConnectionState } from "../db";
import { handleIncomingMessages } from "./handler";

export type BaileysSocket = ReturnType<typeof makeWASocket>;

interface BoomLike extends Error {
  output?: { statusCode?: number };
}

const AUTH_DIR = path.resolve(process.cwd(), "auth");
const logger = pino({ level: "silent" });

let sock: BaileysSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function getSocket(): BaileysSocket | null {
  return sock;
}

export async function start(): Promise<void> {
  // No es un hook de React: es una utilidad de Baileys cuyo nombre por convención empieza con "use".
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version: [number, number, number] | undefined;
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
    console.log(`[bot] Usando versión de WhatsApp Web: ${version.join(".")}`);
  } catch (err) {
    console.warn(
      "[bot] No se pudo obtener la última versión de Baileys, se usará la del paquete:",
      err
    );
  }

  const newSock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS("Desktop"),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock = newSock;

  newSock.ev.on("creds.update", saveCreds);

  newSock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(
        "[bot] QR recibido. Escaneá desde el dashboard en localhost:3000 (o desde la terminal abajo)."
      );
      qrcodeTerminal.generate(qr, { small: true });
      setConnectionState({ status: "qr", qr_string: qr, phone: null });
    }

    if (connection === "connecting") {
      // Solo degradamos a 'connecting' en el primer arranque. Si ya estábamos
      // 'qr' o 'connected', mantenemos ese estado mientras reconecta transparentemente.
      const current = getConnectionState();
      if (current.status === "disconnected") {
        setConnectionState({ status: "connecting" });
      }
    }

    if (connection === "open") {
      const rawId = newSock.user?.id ?? "";
      const phone = rawId.split(":")[0] || null;
      console.log(`[bot] Conectado. Número: ${phone}`);
      setConnectionState({ status: "connected", qr_string: null, phone });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as BoomLike | undefined)
        ?.output?.statusCode;
      console.log(`[bot] Conexión cerrada (code=${statusCode ?? "?"})`);

      if (statusCode === DisconnectReason.loggedOut) {
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

      // Cualquier otro código: no tocamos el estado en DB (para no pisar 'connected'
      // mientras reconectamos). Si hace falta un QR nuevo, el evento 'qr' lo va a sobreescribir.
      scheduleReconnect(statusCode);
    }
  });

  newSock.ev.on("messages.upsert", (payload) => {
    handleIncomingMessages(newSock, payload).catch((err) => {
      console.error("[bot] Error procesando mensajes entrantes:", err);
    });
  });
}

function scheduleReconnect(code?: number): void {
  if (reconnectTimer) return;

  // Code 440 (connectionReplaced) ocurre típicamente justo después del pairing:
  // WhatsApp abre un socket "definitivo" y kickea el de pairing. Reintentar rápido
  // entra en loop, por eso el backoff más largo para ese caso puntual.
  const delay = code === 440 ? 15000 : 5000;
  console.log(`[bot] Reintentando conexión en ${delay / 1000}s...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (sock) {
      try {
        sock.end(undefined);
      } catch {
        // el socket puede ya estar cerrado, no importa
      }
      sock = null;
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
  if (sock) {
    try {
      await sock.logout();
    } catch (err) {
      console.warn("[bot] Error en logout (puede ser normal):", err);
    }
    try {
      sock.end(undefined);
    } catch {
      // ignore
    }
    sock = null;
  }
}
