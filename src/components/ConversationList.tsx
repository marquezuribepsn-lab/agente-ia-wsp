"use client";

import type { ConversationWithPreview } from "@/lib/db";
import { formatJidForDisplay } from "@/lib/format";

interface ConversationListProps {
  conversations: ConversationWithPreview[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

function formatRelativeTime(unixSeconds: number | null): string {
  if (!unixSeconds) return "";
  const diffMin = Math.floor((Date.now() - unixSeconds * 1000) / 60000);
  if (diffMin < 1) return "ahora";
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `hace ${diffH} h`;
  return `hace ${Math.floor(diffH / 24)} d`;
}

export default function ConversationList({
  conversations,
  selectedId,
  onSelect,
}: ConversationListProps) {
  if (conversations.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-400">
        Todavía no hay conversaciones. Cuando alguien te escriba al WhatsApp
        conectado, va a aparecer acá.
      </div>
    );
  }

  return (
    <ul className="h-full divide-y divide-neutral-100 overflow-y-auto">
      {conversations.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onSelect(c.id)}
            className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-neutral-50 ${
              selectedId === c.id ? "bg-neutral-100" : ""
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium text-neutral-900">
                {c.name || formatJidForDisplay(c.phone)}
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                  c.mode === "AI"
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-amber-100 text-amber-700"
                }`}
              >
                {c.mode === "AI" ? "IA" : "Humano"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
              <span className="truncate">
                {c.last_message_preview ?? "Sin mensajes"}
              </span>
              <span className="shrink-0">
                {formatRelativeTime(c.last_message_at)}
              </span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
