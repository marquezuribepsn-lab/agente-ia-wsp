# Agente WhatsApp

Agente de WhatsApp local que se conecta a un número real vía Baileys (WhatsApp
Web, no Meta API ni Twilio) y responde mensajes con un LLM a través de
OpenRouter. Incluye un dashboard local (Next.js) para ver las conversaciones,
leer el historial, intervenir manualmente y togglear cada chat entre modo
**IA** (responde el bot) y modo **Humano** (respondés vos desde el dashboard).

Todo corre en `localhost`. La data vive en SQLite (`./data/messages.db`). La
sesión de WhatsApp Web la guarda Baileys en `./auth/`.

## Requisitos

- Node.js **20.9+** (recomendado 22 LTS — ver `.nvmrc`)
- Una cuenta de [OpenRouter](https://openrouter.ai) con créditos cargados
- Un número de WhatsApp disponible para vincular como "dispositivo vinculado"

## Instalación

```bash
npm install --ignore-scripts
```

> **¿Por qué `--ignore-scripts`?** `better-sqlite3` trae el binario
> precompilado dentro del propio paquete (funciona en cualquier versión de
> Node gracias a N-API), pero en Windows sin Visual Studio + Windows SDK
> completos, el paso automático de `node-gyp` que npm dispara igual falla al
> intentar generar el proyecto de compilación, aunque termine sin compilar
> nada. Saltar los scripts de instalación evita ese paso innecesario. Ya
> queda configurado por defecto en `.npmrc` (`ignore-scripts=true`), así que
> alcanza con `npm install` a secas de ahora en más — el flag explícito es
> solo para dejar constancia del motivo.

Instalá con `npm install --ignore-scripts` (o simplemente `npm install`, el
`.npmrc` del proyecto ya lo fuerza). Tarda ~1 min por el tamaño de las
dependencias nativas.

## Configuración

Copiá `.env.example` a `.env.local` (ya viene creado con valores vacíos) y
completá:

```
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openai/gpt-4o-mini
```

**Recomendación:** usá `openai/gpt-4o-mini` ($0.15 por millón de tokens,
centavos por mes en uso normal). Los modelos `:free` de OpenRouter tienen un
límite muy estricto (50 requests/día sin créditos cargados) y van a fallar
con error 429 apenas tengas tráfico real.

## Correr en desarrollo

Necesitás **dos procesos** corriendo en paralelo, en dos terminales:

```bash
npm run start:bot   # levanta Baileys
npm run dev          # levanta el dashboard en localhost:3000
```

1. Abrí `http://localhost:3000`.
2. Si no hay sesión guardada, vas a ver la pantalla "Conectar número" con un
   QR grande. Escanealo desde tu teléfono: WhatsApp → Dispositivos
   vinculados → Vincular un dispositivo. (El QR también se imprime en ASCII
   en la terminal del bot, como fallback de debugging.)
3. Apenas se detecta la conexión, el dashboard pasa solo a la vista de
   conversaciones (sin recargar la página).
4. La sesión queda guardada en `./auth/`. Mientras no cierres sesión desde el
   teléfono ni uses el botón "Desconectar", los reinicios de `start:bot` no
   vuelven a pedir QR.

## Correr en modo producción local

```bash
npm run build
npm run start:all
```

`start:all` levanta el bot y el servidor Next.js juntos con `concurrently`.

## Precauciones anti-baneo

WhatsApp puede marcar como spam (y eventualmente banear) a un número que
responde de forma instantánea o manda mensajes en ráfaga — patrón típico de
bot. Todo el envío saliente (respuestas de IA y mensajes humanos encolados)
pasa por `src/lib/baileys/send.ts`, que aplica:

- **Separación mínima entre envíos:** ~2.5-5s de espacio aleatorio entre
  cualquier par de mensajes salientes, sin importar a qué conversación vayan.
- **Simulación de "escribiendo...":** antes de mandar, el bot marca presencia
  `composing` y espera un tiempo proporcional al largo del mensaje (1.2-6s)
  antes de enviarlo.
- **Marca los mensajes entrantes como leídos** (`readMessages`) — una cuenta
  humana real lee antes de responder.
- `markOnlineOnConnect: false` (ya en `client.ts`): el bot no aparece
  "en línea" todo el tiempo.

Si en algún momento tenés mucho volumen de mensajes humanos encolados desde
el dashboard, van a salir más lento de lo que entran a la cola — es
intencional. Los valores de timing están al principio de `send.ts` si querés
ajustarlos.

## Personalizar el prompt del bot

Editá `src/lib/system-prompt.ts`. Ahí vive el `SYSTEM_PROMPT` que se le manda
al LLM en cada conversación en modo IA — reemplazalo por el prompt de tu
negocio (tono, información del producto, políticas, etc.).

## Cómo funciona (resumen técnico)

- **Baileys** corre en un proceso aparte (`scripts/start-bot.ts`), separado
  del proceso de Next.js. No comparten memoria.
- **SQLite** (`./data/messages.db`, modo WAL) es el punto de encuentro entre
  ambos procesos: conversaciones, mensajes, estado de conexión y una tabla
  `outbox` para los mensajes que salen desde el dashboard en modo Humano.
- Cuando enviás un mensaje desde el dashboard (modo Humano), la API lo
  guarda al instante en `messages` y lo encola en `outbox`. El proceso bot
  revisa `outbox` cada 2s y lo envía por Baileys.
- El dashboard hace **polling cada 2 segundos** (no WebSocket en esta
  versión) para refrescar mensajes, lista de conversaciones y estado de
  conexión.

## Deploy en producción (VPS con Docker)

El deploy real de este proyecto corre en una VPS (probado en Hostinger,
Ubuntu 24.04) con Docker + Docker Compose directo — **sin EasyPanel ni
ningún otro panel intermedio**. El repo incluye:

- `Dockerfile` (multi-stage: instala dependencias con `--ignore-scripts`,
  builda Next.js, poda `devDependencies` para la imagen final).
- `docker-compose.yml` — un solo servicio, puerto publicado configurable,
  volúmenes bind-mount para `/app/data` y `/app/auth`, `restart:
  unless-stopped`.

Pasos para desplegar en un servidor nuevo (Ubuntu + Docker + Docker Compose
ya instalados):

```bash
git clone https://github.com/marquezuribepsn-lab/agente-ia-wsp.git /opt/agente-whatsapp
cd /opt/agente-whatsapp
cp .env.example .env   # completar OPENROUTER_API_KEY, OPENROUTER_MODEL,
                        # DASHBOARD_USER y DASHBOARD_PASSWORD
docker compose up -d --build
```

**Volúmenes persistentes:** `docker-compose.yml` ya mapea `./data` y
`./auth` (relativos a la carpeta del proyecto en el servidor) a
`/app/data` y `/app/auth` dentro del contenedor. Sin esto, cada rebuild
borra las conversaciones guardadas Y obliga a re-escanear el QR.

**Puerto:** por defecto el compose publica el contenedor (puerto interno
3000) en el **3001** del host, para no chocar con otros servicios. Ajustalo
en `docker-compose.yml` si hace falta, y abrí el puerto correspondiente en
el firewall (a nivel de VPS y, si tu proveedor lo tiene, también a nivel de
red/hPanel — son capas separadas).

**Dominio y SSL:** si más adelante conseguís un dominio, lo más simple es
poner un reverse proxy (Caddy o Nginx + certbot) delante del puerto
publicado para servir HTTPS. Sin dominio, el acceso queda por IP:puerto sin
cifrar — el basic auth (ver abajo) sigue protegiendo las credenciales, pero
viajan sin TLS, así que conseguí un dominio apenas puedas.

`Procfile` y `nixpacks.toml` quedan en el repo como alternativa si en algún
momento preferís desplegar en una plataforma tipo EasyPanel/Railway/Render
en vez de una VPS pelada — no se usan en el deploy actual.

## Seguridad — autenticación del dashboard

El dashboard soporta HTTP Basic Auth vía las variables `DASHBOARD_USER` y
`DASHBOARD_PASSWORD` (ver `src/proxy.ts`). Si estas variables no están
seteadas, el dashboard queda **sin ninguna protección** — cualquiera con la
URL puede leer las conversaciones de WhatsApp y enviar mensajes
haciéndose pasar por vos. **Configurá siempre estas dos variables si vas a
exponer el dashboard más allá de `localhost`.**

Como capa extra (opcional pero recomendada si hay dominio): agregar
Cloudflare Access o basic auth también a nivel de proxy (Caddy/Nginx)
delante de la app.

## Troubleshooting

- **Código 405 al conectar:** versión de Baileys desactualizada respecto al
  protocolo de WhatsApp Web. Ya está resuelto en el código
  (`fetchLatestBaileysVersion()` se llama siempre al arrancar), pero si
  persiste, actualizá `@whiskeysockets/baileys`.
- **Código 440 en loop:** WhatsApp no reconoce el fingerprint del
  dispositivo. Verificá que `src/lib/baileys/client.ts` siga usando
  `Browsers.macOS('Desktop')` y no un browser fingerprint custom. Si
  persiste, en tu teléfono andá a Configuración → Dispositivos vinculados y
  borrá sesiones viejas de pruebas anteriores. Si sigue sin funcionar,
  probá cambiar de IP del servidor o esperar ~24h.
- **Código 515:** es normal, es la señal de pairing exitoso. El bot
  reconecta solo.
- **El QR no aparece en el dashboard:** revisá que `npm run start:bot` esté
  corriendo — sin el proceso bot, nunca se genera un QR. El endpoint
  `/api/connection/status` es defensivo (muestra el QR si existe aunque el
  status no sea exactamente `'qr'`), pero necesita que el bot esté vivo.
- **`OPENROUTER_API_KEY` llega como `undefined` al bot:** asegurate de que
  `scripts/env-loader.ts` sea el **primer import** de `scripts/start-bot.ts`
  (los `import` de ES modules se hoistean al tope del archivo, así que el
  orden de declaración importa).
- **429 al llamar al LLM:** el modelo `:free` de OpenRouter saturó su cuota
  diaria. Cambiá `OPENROUTER_MODEL` a `openai/gpt-4o-mini` en `.env.local`.
- **Procesos zombies en Windows:** `Ctrl+C` no siempre mata los procesos
  hijos que levanta `tsx`/`concurrently`. Si el puerto queda ocupado o el
  bot sigue corriendo en segundo plano, buscalo con `tasklist | findstr node`
  y matalo con `taskkill /F /PID <pid>`.
- **`better-sqlite3` falla al instalar en Linux (build remoto):** el build
  necesita `python3`, `gcc` y `gnumake` disponibles. Ya están declarados en
  `nixpacks.toml`.

## Mejoras pendientes (fuera del scope de esta versión)

- Soporte de imágenes salientes (enviar fotos de productos, catálogos).
- Function calling real usando `tools` de la API de OpenRouter.
- Auto-toggle a modo Humano cuando el bot detecta una frase específica (por
  ejemplo, regex sobre "derivarte con un asesor humano" en `handler.ts`).
- WebSocket en vez de polling para actualizaciones en tiempo real.
- HTTPS automático (dominio + certbot/Caddy) documentado end-to-end una vez
  que haya un dominio propio.
