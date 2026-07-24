# Agente WhatsApp

Agente de WhatsApp local que se conecta a un número real vía
[whatsapp-web.js](https://wwebjs.dev) (automatiza un Chrome real corriendo
la página verdadera de WhatsApp Web — no Meta API ni Twilio) y responde
mensajes con un LLM (cualquier proveedor compatible con la API de OpenAI:
Groq, OpenRouter, Google Gemini, OpenAI directo, etc.). Incluye un dashboard
local (Next.js) para ver las conversaciones, leer el historial, intervenir
manualmente y togglear cada chat entre modo **IA** (responde el bot) y modo
**Humano** (respondés vos desde el dashboard).

Todo corre en `localhost`. La data vive en SQLite (`./data/messages.db`). La
sesión de WhatsApp Web la guarda whatsapp-web.js en `./auth/`.

> **¿Por qué whatsapp-web.js y no Baileys?** Este proyecto arrancó con
> Baileys (un cliente no oficial que reimplementa el protocolo de WhatsApp
> Web por ingeniería inversa). Baileys tiene, al momento de escribir esto,
> un problema conocido y sin resolver: la sesión se cierra sola (código 401)
> a los segundos de conectar o de mandar el primer mensaje, en cualquier
> número y cualquier infraestructura — reportado por otros usuarios en
> [GitHub](https://github.com/WhiskeySockets/Baileys/issues/2248). Como un
> login por navegador real se mantenía estable en el mismo equipo,
> migramos a whatsapp-web.js, que automatiza ese navegador real (Puppeteer)
> en vez de reimplementar el protocolo. Ver la sección "Troubleshooting"
> para más detalle.

## App de escritorio (`desktop/`)

Wrapper de Electron que abre el dashboard alojado en el servidor dentro de
una ventana nativa, con ícono propio, en vez de tener que abrir el navegador
y tipear la IP. Ver `desktop/main.js`.

```bash
cd desktop
npm install
cp .env.example .env   # completar DASHBOARD_URL, DASHBOARD_USER, DASHBOARD_PASSWORD
npm start               # probar en modo desarrollo
npm run dist             # genera el instalador en desktop/dist/*.exe
```

`desktop/.env` nunca se commitea — ahí quedan las credenciales del basic
auth para que la app las autocomplete.

## Requisitos

- Node.js **20.9+** (recomendado 22 LTS — ver `.nvmrc`)
- Una API key de un proveedor de LLM compatible con OpenAI. Recomendado
  [Groq](https://console.groq.com) (gratis, sin tarjeta, límite generoso) —
  alternativas: [OpenRouter](https://openrouter.ai) o
  [Google Gemini](https://aistudio.google.com)
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

Después, bajá el Chromium que necesita whatsapp-web.js/Puppeteer (el
`--ignore-scripts` de arriba salta la descarga automática, así que hay que
pedirla a mano una vez):

```bash
npm run setup:chromium
```

En Docker/VPS no hace falta este paso — el `Dockerfile` instala Chromium
del sistema vía `apt` en su lugar (más liviano, ver sección de Deploy).

## Configuración

Copiá `.env.example` a `.env.local` (ya viene creado con valores vacíos) y
completá:

```
LLM_API_KEY=gsk_...
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=llama-3.3-70b-versatile
```

**Recomendación:** [Groq](https://console.groq.com) — tier gratis real, sin
tarjeta, límite generoso (~30 req/min) para un bot de un solo negocio. Los
modelos `:free` de OpenRouter en cambio comparten un pool entre miles de
usuarios y se saturan rápido con tráfico real (error 502/429). Si preferís
OpenRouter con créditos cargados, usá `LLM_BASE_URL=https://openrouter.ai/api/v1`
y `LLM_MODEL=openai/gpt-4o-mini` ($0.15 por millón de tokens).

## Correr en desarrollo

Necesitás **dos procesos** corriendo en paralelo, en dos terminales:

```bash
npm run start:bot   # levanta el bot (whatsapp-web.js)
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

WhatsApp puede forzar el cierre de sesión (o banear) a un número que se
comporta como bot. Esto tiene dos frentes distintos — **el código solo
cubre el primero**:

### 1. Comportamiento de envío (cubierto por código)

Todo el envío saliente (respuestas de IA y mensajes humanos encolados) pasa
por `src/lib/whatsapp/send.ts`, que aplica:

- **Separación mínima entre envíos:** ~4-8s de espacio aleatorio entre
  cualquier par de mensajes salientes, sin importar a qué conversación vayan.
- **Simulación de "escribiendo...":** antes de mandar, el bot marca estado
  `typing` en el chat y espera un tiempo proporcional al largo del mensaje
  (1.5-8s) antes de enviarlo.
- **Techo duro de 30 mensajes/hora**: si algo (un bug, un loop del LLM)
  intentara mandar de más, se corta ahí antes de que se vea como spam real.
- **Marca los mensajes entrantes como leídos** (`chat.sendSeen()`) — una
  cuenta humana real lee antes de responder.

Si en algún momento tenés mucho volumen de mensajes humanos encolados desde
el dashboard, van a salir más lento de lo que entran a la cola — es
intencional. Los valores de timing están al principio de `send.ts` si querés
ajustarlos.

### 2. Comportamiento de vinculación (operativo, NO es código)

Esto pesa **igual o más** que el timing de los mensajes, y ningún código lo
arregla:

- **No re-vincules el dispositivo (escanear QR) más de lo estrictamente
  necesario.** Cada desconexión + QR nuevo es una señal fuerte para la
  detección de WhatsApp. Usá el botón "Desconectar" solo cuando de verdad
  haga falta, no como parte de pruebas de rutina.
- **Un solo dispositivo automatizado vinculado a la vez.** Si tenés el bot
  corriendo en dos lugares (por ejemplo local Y en el servidor) al mismo
  tiempo, desvinculá uno de los dos. Dos dispositivos "bot" simultáneos es
  una señal más clara de automatización que uno solo.
- **La IP del servidor importa.** Conexiones desde rangos de IP de
  hosting/datacenter (como una VPS) son, en general, más sospechosas para
  WhatsApp que una IP residencial. Esto no tiene solución de código — es un
  riesgo estructural de auto-hospedar un cliente no oficial.
- **Considerá usar un número dedicado para el bot**, idealmente registrado
  como WhatsApp Business, en vez de tu número personal principal. Si ese
  número tiene un problema, no te deja sin WhatsApp a vos.

Ninguna de estas medidas garantiza cero riesgo — es un cliente no oficial de
WhatsApp Web, y WhatsApp activamente trata de detectarlos. El objetivo es
reducir la probabilidad y la frecuencia, no eliminarla.

## Personalizar el prompt del bot

Editá `src/lib/system-prompt.ts`. Ahí vive el `SYSTEM_PROMPT` que se le manda
al LLM en cada conversación en modo IA — reemplazalo por el prompt de tu
negocio (tono, información del producto, políticas, etc.). El resto del
prompt (base de conocimiento, memoria del cliente, protocolo de
escalamiento) se arma solo en `buildSystemPrompt()`, no hace falta tocarlo.

## Base de conocimiento, memoria y escalamiento

**Base de conocimiento:** en el dashboard, botón "Base de conocimiento" en
el header. Subís archivos PDF, Word (`.docx`) o texto (`.txt`/`.md`) con
información de tu negocio (catálogo, precios, políticas). Cada archivo se
parte en fragmentos y se indexan con búsqueda de texto completo (FTS5,
nativo de SQLite, sin costo de API extra). Cuando un cliente pregunta algo
en modo IA, el bot busca los fragmentos más relevantes y se los pasa al LLM
como contexto.

**Memoria por cliente:** cada conversación tiene un campo `memory` que el
LLM va completando solo. En la misma llamada que genera la respuesta (sin
llamada extra al modelo), si el modelo detecta un dato nuevo digno de
recordar sobre ESE cliente puntual (preferencias, compras previas, etc.),
lo agrega con una línea `MEMORIA: <dato>` al final de su respuesta — el
código la separa antes de mandarle el mensaje al cliente y la guarda. Se
inyecta de vuelta en el prompt en conversaciones futuras con ese mismo
cliente.

**Escalamiento:** si el LLM no tiene con qué responder con confianza
(marca su respuesta con `NO_SE: <resumen de la pregunta>` en vez de
inventar), el bot:
1. Le manda al cliente un mensaje de espera ("Dejame confirmar esa
   información...").
2. Te manda un WhatsApp a vos mismo (chat "Tú") con la pregunta.
3. Cuando respondés **citando ese mensaje** (mantener presionado →
   Responder) — o escribiendo `#<id> tu respuesta` si por algún motivo no
   podés citar — el bot toma tu respuesta, le contesta al cliente original,
   te confirma que ya lo hizo, y guarda la pregunta+respuesta en la base de
   conocimiento para la próxima vez.

Solo se acepta como respuesta un mensaje que cite explícitamente la
pregunta (o el `#id`) — así una nota cualquiera que te mandes a vos mismo
nunca se termina mandando por error a un cliente.

## Cómo funciona (resumen técnico)

- **whatsapp-web.js** corre en un proceso aparte (`scripts/start-bot.ts`),
  separado del proceso de Next.js. No comparten memoria. Internamente
  levanta un Chrome headless (Puppeteer) que corre la página real de
  WhatsApp Web.
- **SQLite** (`./data/messages.db`, modo WAL) es el punto de encuentro entre
  ambos procesos: conversaciones, mensajes, estado de conexión y una tabla
  `outbox` para los mensajes que salen desde el dashboard en modo Humano.
- Cuando enviás un mensaje desde el dashboard (modo Humano), la API lo
  guarda al instante en `messages` y lo encola en `outbox`. El proceso bot
  revisa `outbox` cada 2s y lo envía por WhatsApp Web.
- El dashboard hace **polling cada 2 segundos** (no WebSocket en esta
  versión) para refrescar mensajes, lista de conversaciones y estado de
  conexión.

## Deploy en producción (VPS con Docker)

El deploy real de este proyecto corre en una VPS (probado en Hostinger,
Ubuntu 24.04) con Docker + Docker Compose directo — **sin EasyPanel ni
ningún otro panel intermedio**. El repo incluye:

- `Dockerfile` (multi-stage: instala dependencias con `--ignore-scripts`,
  builda Next.js, poda `devDependencies`, instala Chromium del sistema vía
  `apt` para whatsapp-web.js/Puppeteer en la imagen final).
- `docker-compose.yml` — un solo servicio, puerto publicado configurable,
  volúmenes bind-mount para `/app/data` y `/app/auth`, `restart:
  unless-stopped`.

Pasos para desplegar en un servidor nuevo (Ubuntu + Docker + Docker Compose
ya instalados):

```bash
git clone https://github.com/marquezuribepsn-lab/agente-ia-wsp.git /opt/agente-whatsapp
cd /opt/agente-whatsapp
cp .env.example .env   # completar LLM_API_KEY, LLM_BASE_URL, LLM_MODEL,
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

- **La sesión se cierra sola (reason `LOGOUT`) a los segundos de conectar o
  de mandar el primer mensaje:** esto pasaba con Baileys por un bug de
  compatibilidad de protocolo — la razón por la que migramos a
  whatsapp-web.js. Si volviera a pasar acá, revisá primero si es un
  problema puntual de whatsapp-web.js buscando el código de error en su
  [tracker de issues](https://github.com/pedroslopez/whatsapp-web.js/issues)
  antes de asumir que es tu cuenta.
- **"Vinculación de dispositivos bloqueada por X horas" en WhatsApp:** pasa
  si escaneás/reescaneás QR muchas veces seguidas en poco tiempo — WhatsApp
  lo toma como patrón sospechoso de vinculación. No hay forma de saltear el
  bloqueo; hay que esperar. Evitalo escaneando una sola vez por sesión de
  pruebas, no en loop.
- **Puppeteer no encuentra Chrome / falla al lanzar el navegador:** en local
  corré `npm run setup:chromium`. En Docker, confirmá que la imagen instaló
  `chromium` vía `apt` (ver `Dockerfile`) y que `PUPPETEER_EXECUTABLE_PATH`
  apunta a `/usr/bin/chromium`.
- **El QR no aparece en el dashboard:** revisá que `npm run start:bot` esté
  corriendo — sin el proceso bot, nunca se genera un QR. El endpoint
  `/api/connection/status` es defensivo (muestra el QR si existe aunque el
  status no sea exactamente `'qr'`), pero necesita que el bot esté vivo.
- **`LLM_API_KEY` llega como `undefined` al bot:** asegurate de que
  `scripts/env-loader.ts` sea el **primer import** de `scripts/start-bot.ts`
  (los `import` de ES modules se hoistean al tope del archivo, así que el
  orden de declaración importa).
- **429/502 al llamar al LLM ("rate limit", "ResourceExhausted"):** se
  saturó la cuota del proveedor/modelo. Con Groq gratis es raro pero puede
  pasar con mucho tráfico; con el `:free` de OpenRouter es prácticamente
  garantizado apenas hay uso real (es un pool compartido entre miles de
  usuarios). Solución: cambiar a un modelo con más cupo (Groq, o OpenRouter
  con créditos cargados) en `LLM_MODEL`/`LLM_BASE_URL`.
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
