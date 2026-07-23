"use client";

import { useEffect, useState } from "react";
import type { ConversationWithPreview, ConversationMode } from "@/lib/db";
import QRScreen, { type StatusResponse } from "./QRScreen";
import DashboardHeader, { type DashboardView } from "./DashboardHeader";
import ConversationList from "./ConversationList";
import ConversationPanel from "./ConversationPanel";
import KnowledgeBase from "./KnowledgeBase";

export default function ConnectionGate() {
  const [statusData, setStatusData] = useState<StatusResponse | null>(null);
  const [conversations, setConversations] = useState<ConversationWithPreview[]>(
    []
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [view, setView] = useState<DashboardView>("conversations");

  useEffect(() => {
    let cancelled = false;

    async function pollStatus() {
      try {
        const res = await fetch("/api/connection/status");
        const data = (await res.json()) as StatusResponse;
        if (!cancelled) setStatusData(data);
      } catch {
        // silencioso: reintenta en el próximo tick
      }
    }

    pollStatus();
    const interval = setInterval(pollStatus, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (statusData?.status !== "connected") return;

    let cancelled = false;

    async function pollConversations() {
      try {
        const res = await fetch("/api/conversations");
        const data = (await res.json()) as {
          conversations: ConversationWithPreview[];
        };
        if (!cancelled) setConversations(data.conversations);
      } catch {
        // silencioso: reintenta en el próximo tick
      }
    }

    pollConversations();
    const interval = setInterval(pollConversations, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [statusData?.status]);

  async function handleDisconnect() {
    await fetch("/api/connection/disconnect", { method: "POST" });
    setStatusData(null);
    setConversations([]);
    setSelectedId(null);
  }

  if (!statusData || statusData.status !== "connected") {
    return <QRScreen data={statusData} />;
  }

  const selectedConversation =
    conversations.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex h-screen flex-col">
      <DashboardHeader
        phone={statusData.phone ?? null}
        view={view}
        onViewChange={setView}
        onDisconnect={handleDisconnect}
      />
      {view === "knowledge" ? (
        <KnowledgeBase />
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <aside className="w-80 shrink-0 overflow-hidden border-r border-neutral-200 bg-white">
            <ConversationList
              conversations={conversations}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </aside>
          <main className="flex-1 overflow-hidden">
            {selectedConversation ? (
              <ConversationPanel
                key={selectedConversation.id}
                conversation={selectedConversation}
                onDeleted={() => {
                  setSelectedId(null);
                  setConversations((prev) =>
                    prev.filter((c) => c.id !== selectedConversation.id)
                  );
                }}
                onModeChanged={(mode: ConversationMode) => {
                  setConversations((prev) =>
                    prev.map((c) =>
                      c.id === selectedConversation.id ? { ...c, mode } : c
                    )
                  );
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-neutral-400">
                Elegí una conversación de la izquierda para ver los mensajes.
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
