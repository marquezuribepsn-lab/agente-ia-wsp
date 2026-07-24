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

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS document_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id),
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
      content,
      content='document_chunks',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS document_chunks_ai AFTER INSERT ON document_chunks BEGIN
      INSERT INTO document_chunks_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS document_chunks_ad AFTER DELETE ON document_chunks BEGIN
      INSERT INTO document_chunks_fts(document_chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;

    CREATE TABLE IF NOT EXISTS escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      question TEXT NOT NULL,
      status TEXT CHECK(status IN ('pending','answered')) NOT NULL DEFAULT 'pending',
      answer TEXT,
      owner_message_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      answered_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_escalations_pending
      ON escalations(status, created_at);
  `);

  // Migración: conversations.memory no existía en versiones anteriores del
  // schema. CREATE TABLE IF NOT EXISTS no agrega columnas a una tabla ya
  // creada, así que hay que chequear y agregarla a mano si falta.
  ensureColumn(db, "conversations", "memory", "memory TEXT");

  instance = db;
  return db;
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  columnDdl: string
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`);
  }
}

export type ConversationMode = "AI" | "HUMAN";

export interface Conversation {
  id: number;
  /** JID completo de WhatsApp (ej. "549...@c.us" o "...@lid"), no un número suelto. */
  phone: string;
  name: string | null;
  mode: ConversationMode;
  last_message_at: number | null;
  created_at: number;
  /** Datos aprendidos sobre este cliente en particular (preferencias, compras previas, etc). */
  memory: string | null;
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
    db.prepare("DELETE FROM escalations WHERE conversation_id = ?").run(cid);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(cid);
  });
  txn(id);
}

// ---------------------------------------------------------------------------
// Memoria por cliente
// ---------------------------------------------------------------------------

export function appendConversationMemory(
  conversationId: number,
  fact: string
): void {
  const db = getDb();
  const current = db
    .prepare("SELECT memory FROM conversations WHERE id = ?")
    .get(conversationId) as { memory: string | null } | undefined;
  if (!current) return;

  const trimmedFact = fact.trim();
  if (!trimmedFact) return;

  // Evita duplicar el mismo dato si el LLM lo repite en charlas sucesivas.
  const existingLines = (current.memory ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (existingLines.includes(trimmedFact)) return;

  const next = [...existingLines, trimmedFact].join("\n");
  db.prepare("UPDATE conversations SET memory = ? WHERE id = ?").run(
    next,
    conversationId
  );
}

// ---------------------------------------------------------------------------
// Base de conocimiento (archivos subidos + búsqueda de texto completo)
// ---------------------------------------------------------------------------

export interface DocumentRecord {
  id: number;
  filename: string;
  uploaded_at: number;
  chunk_count: number;
}

export interface KnowledgeSearchResult {
  content: string;
  filename: string;
  document_id: number;
}

export function insertDocument(filename: string, chunks: string[]): number {
  const db = getDb();
  const txn = db.transaction((fname: string, parts: string[]) => {
    const info = db
      .prepare("INSERT INTO documents (filename) VALUES (?)")
      .run(fname);
    const documentId = info.lastInsertRowid as number;

    const insertChunk = db.prepare(
      "INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, ?, ?)"
    );
    parts.forEach((content, index) => {
      insertChunk.run(documentId, index, content);
    });

    return documentId;
  });

  return txn(filename, chunks);
}

export function listDocuments(): DocumentRecord[] {
  return getDb()
    .prepare(
      `
      SELECT
        d.id,
        d.filename,
        d.uploaded_at,
        (SELECT COUNT(*) FROM document_chunks dc WHERE dc.document_id = d.id) AS chunk_count
      FROM documents d
      ORDER BY d.uploaded_at DESC
      `
    )
    .all() as DocumentRecord[];
}

export function deleteDocument(id: number): void {
  const db = getDb();
  const txn = db.transaction((documentId: number) => {
    db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(
      documentId
    );
    db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
  });
  txn(id);
}

// Convierte la pregunta del cliente en una query FTS5 segura: cada palabra
// entre comillas (evita que caracteres especiales de FTS5 rompan la
// consulta) unidas con OR, para maximizar recall.
function buildFtsQuery(text: string): string | null {
  const words = text
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((w) => w.length > 1);
  if (!words || words.length === 0) return null;
  return words.map((w) => `"${w}"`).join(" OR ");
}

export function searchKnowledgeBase(
  query: string,
  limit = 5
): KnowledgeSearchResult[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  return getDb()
    .prepare(
      `
      SELECT
        dc.content AS content,
        d.filename AS filename,
        d.id AS document_id
      FROM document_chunks_fts
      JOIN document_chunks dc ON dc.id = document_chunks_fts.rowid
      JOIN documents d ON d.id = dc.document_id
      WHERE document_chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
      `
    )
    .all(ftsQuery, limit) as KnowledgeSearchResult[];
}

// ---------------------------------------------------------------------------
// Escalamiento: preguntas que el bot no supo responder
// ---------------------------------------------------------------------------

export type EscalationStatus = "pending" | "answered";

export interface Escalation {
  id: number;
  conversation_id: number;
  question: string;
  status: EscalationStatus;
  answer: string | null;
  owner_message_id: string | null;
  created_at: number;
  answered_at: number | null;
}

export function createEscalation(
  conversationId: number,
  question: string,
  ownerMessageId: string | null
): Escalation {
  const db = getDb();
  const info = db
    .prepare(
      "INSERT INTO escalations (conversation_id, question, owner_message_id) VALUES (?, ?, ?)"
    )
    .run(conversationId, question, ownerMessageId);
  return db
    .prepare("SELECT * FROM escalations WHERE id = ?")
    .get(info.lastInsertRowid as number) as Escalation;
}

export function findEscalationByOwnerMessageId(
  ownerMessageId: string
): Escalation | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM escalations WHERE owner_message_id = ? AND status = 'pending'"
    )
    .get(ownerMessageId) as Escalation | undefined;
  return row ?? null;
}

export function getPendingEscalationById(id: number): Escalation | null {
  const row = getDb()
    .prepare("SELECT * FROM escalations WHERE id = ? AND status = 'pending'")
    .get(id) as Escalation | undefined;
  return row ?? null;
}

export function setEscalationOwnerMessageId(
  id: number,
  ownerMessageId: string
): void {
  getDb()
    .prepare("UPDATE escalations SET owner_message_id = ? WHERE id = ?")
    .run(ownerMessageId, id);
}

export function getOldestPendingEscalation(): Escalation | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM escalations WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
    )
    .get() as Escalation | undefined;
  return row ?? null;
}

export function listPendingEscalations(): Escalation[] {
  return getDb()
    .prepare(
      "SELECT * FROM escalations WHERE status = 'pending' ORDER BY created_at ASC"
    )
    .all() as Escalation[];
}

export function resolveEscalation(id: number, answer: string): void {
  getDb()
    .prepare(
      "UPDATE escalations SET status = 'answered', answer = ?, answered_at = unixepoch() WHERE id = ?"
    )
    .run(answer, id);
}
