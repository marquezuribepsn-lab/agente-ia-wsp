import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

export type SupportedExtension = "pdf" | "docx" | "txt" | "md";

export function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function isSupportedExtension(
  ext: string
): ext is SupportedExtension {
  return ext === "pdf" || ext === "docx" || ext === "txt" || ext === "md";
}

export async function extractText(
  buffer: Buffer,
  ext: SupportedExtension
): Promise<string> {
  if (ext === "pdf") {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return result.text;
  }

  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // txt / md
  return buffer.toString("utf-8");
}

// Parte el texto en fragmentos de tamaño acotado (para que cada uno entre
// cómodo en el contexto del LLM), respetando saltos de párrafo cuando se
// puede en vez de cortar a lo bruto en medio de una oración.
export function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).filter((p) => p.trim());
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= CHUNK_SIZE) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      // pequeño solape con el final del chunk anterior para no perder
      // contexto que quedó justo en el borde del corte
      current = current.slice(-CHUNK_OVERLAP);
    }

    if (paragraph.length <= CHUNK_SIZE) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    } else {
      // párrafo individual más largo que el tamaño de chunk: se corta a lo bruto
      let rest = paragraph;
      while (rest.length > CHUNK_SIZE) {
        chunks.push(rest.slice(0, CHUNK_SIZE));
        rest = rest.slice(CHUNK_SIZE - CHUNK_OVERLAP);
      }
      current = rest;
    }
  }

  if (current.trim()) chunks.push(current);

  return chunks;
}
