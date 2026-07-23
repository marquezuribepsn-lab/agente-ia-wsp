"use client";

import { useEffect, useRef, useState } from "react";
import type { DocumentRecord } from "@/lib/db";

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export default function KnowledgeBase() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function loadDocuments() {
    try {
      const res = await fetch("/api/knowledge");
      const data = (await res.json()) as { documents: DocumentRecord[] };
      setDocuments(data.documents);
    } catch {
      // silencioso: reintenta en el próximo poll
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/knowledge");
        const data = (await res.json()) as { documents: DocumentRecord[] };
        if (!cancelled) setDocuments(data.documents);
      } catch {
        // silencioso: reintenta en el próximo poll
      }
    }

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/knowledge", {
        method: "POST",
        body: formData,
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Error subiendo el archivo.");
      } else {
        await loadDocuments();
      }
    } catch {
      setError("Error subiendo el archivo.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDelete(id: number) {
    await fetch(`/api/knowledge/${id}`, { method: "DELETE" });
    await loadDocuments();
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mx-auto w-full max-w-2xl">
        <h2 className="text-lg font-semibold text-neutral-900">
          Base de conocimiento
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Subí archivos (PDF, Word, texto) con información de tu negocio. El
          bot los consulta automáticamente para responder preguntas de
          clientes. Las respuestas que le des a preguntas escaladas también
          se guardan acá solas.
        </p>

        <div className="mt-4">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
            {uploading ? "Subiendo..." : "Subir archivo"}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md"
              className="hidden"
              disabled={uploading}
              onChange={handleFileSelected}
            />
          </label>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>

        <ul className="mt-6 divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
          {documents.length === 0 ? (
            <li className="p-4 text-center text-sm text-neutral-400">
              Todavía no subiste ningún archivo.
            </li>
          ) : (
            documents.map((doc) => (
              <li
                key={doc.id}
                className="flex items-center justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-neutral-900">
                    {doc.filename}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {doc.chunk_count} fragmento
                    {doc.chunk_count === 1 ? "" : "s"} · subido{" "}
                    {formatDate(doc.uploaded_at)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(doc.id)}
                  className="shrink-0 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  Borrar
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
