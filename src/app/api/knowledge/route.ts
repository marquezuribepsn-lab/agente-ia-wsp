import { NextResponse } from "next/server";
import { listDocuments, insertDocument } from "@/lib/db";
import {
  getExtension,
  isSupportedExtension,
  extractText,
  chunkText,
} from "@/lib/documents";

export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB

export async function GET() {
  return NextResponse.json({ documents: listDocuments() });
}

export async function POST(req: Request) {
  const formData = await req.formData().catch(() => null);
  const file = formData?.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Falta el archivo" }, { status: 400 });
  }

  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: "El archivo pesa más de 20MB." },
      { status: 400 }
    );
  }

  const ext = getExtension(file.name);
  if (!isSupportedExtension(ext)) {
    return NextResponse.json(
      { error: "Formato no soportado. Usá PDF, Word (.docx), .txt o .md." },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let text: string;
  try {
    text = await extractText(buffer, ext);
  } catch (err) {
    console.error("Error extrayendo texto del archivo:", err);
    return NextResponse.json(
      { error: "No se pudo leer el contenido del archivo." },
      { status: 400 }
    );
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    return NextResponse.json(
      { error: "El archivo no tiene texto que se pueda extraer." },
      { status: 400 }
    );
  }

  const documentId = insertDocument(file.name, chunks);
  return NextResponse.json({
    ok: true,
    documentId,
    chunkCount: chunks.length,
  });
}
