"use client";

import type { ConversationMode } from "@/lib/db";

interface ModeToggleProps {
  mode: ConversationMode;
  onChange: (mode: ConversationMode) => void;
}

export default function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="inline-flex rounded-full border border-neutral-200 bg-white p-1 text-sm font-medium">
      <button
        type="button"
        onClick={() => onChange("AI")}
        className={`rounded-full px-3 py-1 transition-colors ${
          mode === "AI"
            ? "bg-emerald-500 text-white"
            : "text-neutral-500 hover:text-neutral-700"
        }`}
      >
        IA
      </button>
      <button
        type="button"
        onClick={() => onChange("HUMAN")}
        className={`rounded-full px-3 py-1 transition-colors ${
          mode === "HUMAN"
            ? "bg-amber-500 text-white"
            : "text-neutral-500 hover:text-neutral-700"
        }`}
      >
        Humano
      </button>
    </div>
  );
}
