"use client";

import { useState } from "react";

export type DashboardView = "conversations" | "knowledge";

interface DashboardHeaderProps {
  phone: string | null;
  view: DashboardView;
  onViewChange: (view: DashboardView) => void;
  onDisconnect: () => Promise<void> | void;
}

export default function DashboardHeader({
  phone,
  view,
  onViewChange,
  onDisconnect,
}: DashboardHeaderProps) {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await onDisconnect();
    } finally {
      setLoading(false);
      setConfirming(false);
    }
  }

  return (
    <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <span className="font-semibold text-neutral-900">Agente WhatsApp</span>
        {phone && <span className="text-sm text-neutral-500">· {phone}</span>}
      </div>

      {!confirming ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              onViewChange(view === "knowledge" ? "conversations" : "knowledge")
            }
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
              view === "knowledge"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-neutral-200 text-neutral-600 hover:bg-neutral-50"
            }`}
          >
            Base de conocimiento
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
          >
            Desconectar
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-neutral-600">
            ¿Desconectar y borrar la sesión?
          </span>
          <button
            type="button"
            disabled={loading}
            onClick={handleConfirm}
            className="rounded-lg bg-red-500 px-3 py-1.5 font-medium text-white hover:bg-red-600 disabled:opacity-50"
          >
            {loading ? "..." : "Sí, desconectar"}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => setConfirming(false)}
            className="rounded-lg border border-neutral-200 px-3 py-1.5 font-medium text-neutral-600 hover:bg-neutral-50"
          >
            Cancelar
          </button>
        </div>
      )}
    </header>
  );
}
