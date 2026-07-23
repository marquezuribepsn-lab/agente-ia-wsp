"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ConversationWithPreview,
  ConversationMode,
  Message,
} from "@/lib/db";
import { formatJidForDisplay } from "@/lib/format";
import ModeToggle from "./ModeToggle";
import MessageBubble from "./MessageBubble";

interface ConversationPanelProps {
  conversation: ConversationWithPreview;
  onDeleted: () => void;
  onModeChanged: (mode: ConversationMode) => void;
}

export default function ConversationPanel({
  conversation,
  onDeleted,
  onModeChanged,
}: ConversationPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/messages/${conversation.id}`);
        const data = (await res.json()) as { messages: Message[] };
        if (!cancelled) setMessages(data.messages);
      } catch {
        // silencioso: reintenta en el próximo tick de polling
      }
    }

    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [conversation.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleModeChange(mode: ConversationMode) {
    onModeChanged(mode);
    await fetch(`/api/mode/${conversation.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  }

  async function handleSend() {
    const content = input.trim();
    if (!content || sending) return;

    setSending(true);
    try {
      await fetch(`/api/messages/${conversation.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      setInput("");
      const res = await fetch(`/api/messages/${conversation.id}`);
      const data = (await res.json()) as { messages: Message[] };
      setMessages(data.messages);
    } finally {
      setSending(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await fetch(`/api/conversations/${conversation.id}`, {
        method: "DELETE",
      });
      onDeleted();
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <div>
          <p className="font-medium text-neutral-900">
            {conversation.name || formatJidForDisplay(conversation.phone)}
          </p>
          <p className="text-xs text-neutral-500">
            {formatJidForDisplay(conversation.phone)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ModeToggle mode={conversation.mode} onChange={handleModeChange} />
          {!confirmingDelete ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
            >
              Borrar
            </button>
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-neutral-600">¿Borrar conversación?</span>
              <button
                type="button"
                disabled={deleting}
                onClick={handleDelete}
                className="rounded-lg bg-red-500 px-3 py-1.5 font-medium text-white hover:bg-red-600 disabled:opacity-50"
              >
                {deleting ? "..." : "Sí"}
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => setConfirmingDelete(false)}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 font-medium text-neutral-600 hover:bg-neutral-50"
              >
                No
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto bg-neutral-50 px-4 py-4">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-neutral-200 p-3">
        {conversation.mode === "AI" ? (
          <div className="rounded-lg bg-neutral-100 px-4 py-3 text-center text-sm text-neutral-500">
            El bot responde automáticamente. Cambiá a modo Humano para
            escribir vos.
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSend();
              }}
              placeholder="Escribí un mensaje..."
              className="flex-1 rounded-full border border-neutral-200 px-4 py-2 text-sm outline-none focus:border-amber-400"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="rounded-full bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
            >
              Enviar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
