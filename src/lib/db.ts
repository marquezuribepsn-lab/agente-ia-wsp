import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

// La conexión se abre de forma perezosa (en el primer uso real) y no al
// importar el módulo. Next.js evalúa los route handlers en varios workers
// en paralelo durante `next build` (fase "collecting page data") solo para
// inspeccionar sus exports, sin invocarlos — si abriéramos la conexión a
// nivel de módulo, varios workers abrirían el mismo archivo SQLite a la vez
// y el build fallaba con SQLITE_BUSY ("database is locked").
let instance: Database.Database | null = null;

function getDb(): Database.Database {
  if (instance) return instance;

  const dataDir = path.resolve(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(path.join(dataDir, "messages.db"));

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      mode TEXT CHECK(mode IN ('AI','HUMAN')) NOT NULL DEFAULT 'AI',
      last_message_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      role TEXT CHECK(role IN ('user','assistant','human')) NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv
      ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS connection_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT CHECK(status IN ('disconnected','qr','connecting','connected'))
        NOT NULL DEFAULT 'disconnected',
      qr_string TEXT,
      phone TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    INSERT OR IGNORE INTO connection_state (id, status) VALUES (1, 'disconnected');

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      content TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_pending
      ON outbox(sent, created_at);
  `);

  instance = db;
  return db;
}

export type ConversationMode = "AI" | "HUMAN";

export interface Conversation {
  id: number;
  /** JID completo de WhatsApp (ej. "549...@s.whatsapp.net" o "...@lid"), no un número suelto. */
  phone: string;
  name: string | null;
  mode: ConversationMode;
  last_message_at: number | null;
  created_at: number;
}

export interface ConversationWithPreview extends Conversation {
  last_message_preview: string | null;
}

export type MessageRole = "user" | "assistant" | "human";

export interface Message {
  id: number;
  conversation_id: number;
  role: MessageRole;
  content: string;
  created_at: number;
}

export type ConnectionStatus = "disconnected" | "qr" | "connecting" | "connected";

export interface ConnectionState {
  id: 1;
  status: ConnectionStatus;
  qr_string: string | null;
  phone: string | null;
  updated_at: number;
}

export interface OutboxItem {
  id: number;
  conversation_id: number;
  phone: string;
  content: string;
  sent: 0 | 1;
  created_at: number;
}

export function getOrCreateConversation(
  phone: string,
  name?: string | null
): Conversation {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM conversations WHERE phone = ?")
    .get(phone) as Conversation | undefined;

  if (existing) {
    if (name && !existing.name) {
      db.prepare("UPDATE conversations SET name = ? WHERE id = ?").run(
        name,
        existing.id
      );
      existing.name = name;
    }
    return existing;
  }

  const info = db
    .prepare("INSERT INTO conversations (phone, name) VALUES (?, ?)")
    .run(phone, name ?? null);

  return getConversationById(info.lastInsertRowid as number) as Conversation;
}

export function getConversationById(id: number): Conversation | null {
  const row = getDb()
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .get(id) as Conversation | undefined;
  return row ?? null;
}

export function insertMessage(
  conversationId: number,
  role: MessageRole,
  content: string
): Message {
  const db = getDb();
  const txn = db.transaction(
    (cid: number, r: MessageRole, c: string) => {
      const info = db
        .prepare(
          "INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)"
        )
        .run(cid, r, c);
      db.prepare(
        "UPDATE conversations SET last_message_at = unixepoch() WHERE id = ?"
      ).run(cid);
      return info.lastInsertRowid as number;
    }
  );

  const id = txn(conversationId, role, content);
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Message;
}

function queryRecentMessages(conversationId: number, limit: number): Message[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?"
    )
    .all(conversationId, limit) as Message[];
  return rows.reverse();
}

export function getMessages(conversationId: number, limit = 50): Message[] {
  return queryRecentMessages(conversationId, limit);
}

export function getRecentHistory(conversationId: number, limit = 20): Message[] {
  return queryRecentMessages(conversationId, limit);
}

export function setMode(conversationId: number, mode: ConversationMode): void {
  getDb()
    .prepare("UPDATE conversations SET mode = ? WHERE id = ?")
    .run(mode, conversationId);
}

export function listConversations(): ConversationWithPreview[] {
  return getDb()
    .prepare(
      `
      SELECT
        c.*,
        (
          SELECT m.content FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
        ) AS last_message_preview
      FROM conversations c
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
      `
    )
    .all() as ConversationWithPreview[];
}

export function getConnectionState(): ConnectionState {
  return getDb()
    .prepare("SELECT * FROM connection_state WHERE id = 1")
    .get() as ConnectionState;
}

export function setConnectionState(input: {
  status?: ConnectionStatus;
  qr_string?: string | null;
  phone?: string | null;
}): void {
  const current = getConnectionState();
  const next = {
    status: input.status !== undefined ? input.status : current.status,
    qr_string:
      input.qr_string !== undefined ? input.qr_string : current.qr_string,
    phone: input.phone !== undefined ? input.phone : current.phone,
  };
  getDb()
    .prepare(
      "UPDATE connection_state SET status = ?, qr_string = ?, phone = ?, updated_at = unixepoch() WHERE id = 1"
    )
    .run(next.status, next.qr_string, next.phone);
}

export function enqueueOutbox(
  conversationId: number,
  phone: string,
  content: string
): number {
  const info = getDb()
    .prepare(
      "INSERT INTO outbox (conversation_id, phone, content) VALUES (?, ?, ?)"
    )
    .run(conversationId, phone, content);
  return info.lastInsertRowid as number;
}

export function getPendingOutbox(limit = 20): OutboxItem[] {
  return getDb()
    .prepare(
      "SELECT * FROM outbox WHERE sent = 0 ORDER BY created_at ASC, id ASC LIMIT ?"
    )
    .all(limit) as OutboxItem[];
}

export function markOutboxSent(id: number): void {
  getDb().prepare("UPDATE outbox SET sent = 1 WHERE id = ?").run(id);
}

export function deleteConversation(id: number): void {
  const db = getDb();
  const txn = db.transaction((cid: number) => {
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(cid);
    db.prepare(
      "DELETE FROM outbox WHERE conversation_id = ? AND sent = 0"
    ).run(cid);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(cid);
  });
  txn(id);
}
