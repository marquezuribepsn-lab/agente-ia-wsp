"use client";

import { useEffect, useState } from "react";
import type { ConnectionStatus } from "@/lib/db";

export interface StatusResponse {
  status: ConnectionStatus;
  qrPng?: string;
  phone?: string | null;
  updatedAt: number;
}

export default function QRScreen({ data }: { data: StatusResponse | null }) {
  const isDisconnected = !data || data.status === "disconnected";
  const [secondsDisconnected, setSecondsDisconnected] = useState(0);

  useEffect(() => {
    if (!isDisconnected) return;
    let seconds = 0;
    const interval = setInterval(() => {
      seconds += 1;
      setSecondsDisconnected(seconds);
    }, 1000);
    return () => clearInterval(interval);
  }, [isDisconnected]);

  const showError = !data?.qrPng && isDisconnected && secondsDisconnected > 10;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-50 px-4 text-center">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">
          Conectar número de WhatsApp
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Escaneá el código con WhatsApp → Dispositivos vinculados
        </p>
      </div>

      {data?.qrPng ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={data.qrPng}
          alt="Código QR para conectar WhatsApp"
          className="h-80 w-80 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm"
        />
      ) : (
        <div className="flex h-80 w-80 items-center justify-center rounded-2xl border border-neutral-200 bg-white shadow-sm">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-neutral-200 border-t-neutral-400" />
        </div>
      )}

      <div className="flex items-center gap-2 text-sm">
        {data?.status === "qr" && (
          <>
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
            <span className="text-amber-700">Esperando escaneo...</span>
          </>
        )}
        {data?.status === "connecting" && (
          <>
            <span className="h-2 w-2 rounded-full bg-blue-500" />
            <span className="text-blue-700">Conectando...</span>
          </>
        )}
        {(!data || data.status === "disconnected") && !showError && (
          <span className="text-neutral-500">Iniciando el bot...</span>
        )}
      </div>

      {showError && (
        <div className="max-w-sm rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          No se detecta el bot corriendo. Verificá que{" "}
          <code className="rounded bg-red-100 px-1">npm run start:bot</code>{" "}
          esté activo y reiniciá el proceso si hace falta.
        </div>
      )}
    </div>
  );
}
