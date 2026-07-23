import { NextResponse } from "next/server";
import { deleteDocument } from "@/lib/db";

interface Ctx {
  params: Promise<{ documentId: string }>;
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { documentId } = await params;
  const id = Number(documentId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  deleteDocument(id);
  return NextResponse.json({ ok: true });
}
