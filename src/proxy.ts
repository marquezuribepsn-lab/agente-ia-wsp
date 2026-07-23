import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// El dashboard no tiene login propio. En local no importa, pero en un
// deploy expuesto a internet sin dominio (sin Traefik/proxy delante)
// cualquiera con la IP podría leer las conversaciones y mandar mensajes
// como si fuera el dueño del número. Si se configuran DASHBOARD_USER y
// DASHBOARD_PASSWORD, exigimos HTTP Basic Auth en todas las rutas. Si no
// se configuran, se mantiene el comportamiento actual (sin auth).
export function proxy(req: NextRequest): NextResponse {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASSWORD;

  if (!user || !pass) {
    return NextResponse.next();
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Basic ")) {
    const decoded = atob(authHeader.slice("Basic ".length));
    const sepIndex = decoded.indexOf(":");
    const providedUser = decoded.slice(0, sepIndex);
    const providedPass = decoded.slice(sepIndex + 1);
    if (providedUser === user && providedPass === pass) {
      return NextResponse.next();
    }
  }

  return new NextResponse("Autenticación requerida", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Agente WhatsApp"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
