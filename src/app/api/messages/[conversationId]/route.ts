import { NextResponse } from "next/server";
import {
  getMessages,
  getConversationById,
  insertMessage,
  enqueueOutbox,
} from "@/lib/db";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

export async function GET(req: Request, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 50;

  return NextResponse.json({ messages: getMessages(id, limit) });
}

export async function POST(req: Request, { params }: Ctx) {
  const { conversationId } = await params;
  const id = Number(conversationId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  const convo = getConversationById(id);
  if (!convo) {
    return NextResponse.json(
      { error: "Conversación no encontrada" },
      { status: 404 }
    );
  }

  const body = await req.json().catch(() => null);
  const content =
    typeof body?.content === "string" ? body.content.trim() : "";
  if (!content) {
    return NextResponse.json({ error: "content es requerido" }, { status: 400 });
  }

  // El mensaje queda visible en el dashboard al instante (insert directo) y
  // se encola en outbox para que el proceso bot (otro proceso, sin memoria
  // compartida) lo envíe vía Baileys en su próximo tick.
  const message = insertMessage(id, "human", content);
  enqueueOutbox(id, convo.phone, content);

  return NextResponse.json({ ok: true, messageId: message.id });
}
