import { NextResponse } from "next/server";
import { setMode, getConversationById, type ConversationMode } from "@/lib/db";

interface Ctx {
  params: Promise<{ conversationId: string }>;
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
  const mode = body?.mode;
  if (mode !== "AI" && mode !== "HUMAN") {
    return NextResponse.json(
      { error: "mode debe ser 'AI' o 'HUMAN'" },
      { status: 400 }
    );
  }

  setMode(id, mode as ConversationMode);
  return NextResponse.json({ ok: true, mode });
}
