import type { Message } from "@/lib/db";

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const isHuman = message.role === "human";

  const bubbleStyle = isUser
    ? "bg-white border border-neutral-200 text-neutral-900"
    : isHuman
      ? "bg-amber-500 text-white"
      : "bg-emerald-500 text-white";

  return (
    <div className={`flex ${isUser ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm shadow-sm ${bubbleStyle}`}
      >
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
        <p
          className={`mt-1 text-[10px] ${isUser ? "text-neutral-400" : "text-white/70"}`}
        >
          {formatTime(message.created_at)}
        </p>
      </div>
    </div>
  );
}
