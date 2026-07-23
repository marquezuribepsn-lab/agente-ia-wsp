import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { getConnectionState } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = getConnectionState();

  // Defensivo: por race conditions a veces el bot tiene qr_string seteado
  // pero status='connecting'. Si solo miráramos status, el frontend nunca
  // vería el QR en esa ventana intermedia.
  const shouldShowQr =
    !!state.qr_string && (state.status === "qr" || state.status === "connecting");

  if (shouldShowQr && state.qr_string) {
    const qrPng = await QRCode.toDataURL(state.qr_string, {
      width: 320,
      margin: 2,
    });
    return NextResponse.json({
      status: "qr",
      qrPng,
      updatedAt: state.updated_at,
    });
  }

  return NextResponse.json({
    status: state.status,
    phone: state.phone,
    updatedAt: state.updated_at,
  });
}
