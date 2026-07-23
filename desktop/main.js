const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// Mismo parser minimalista que scripts/env-loader.ts en el proyecto principal:
// lee desktop/.env (gitignored, nunca se commitea) para no tener las
// credenciales de basic auth escritas en el código fuente.
function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf-8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile();

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://62.72.63.241:3001";
const DASHBOARD_USER = process.env.DASHBOARD_USER || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Agente WhatsApp",
    autoHideMenuBar: true,
  });

  win.loadURL(DASHBOARD_URL);
}

// Autocompleta el basic auth del dashboard para no tener que tipearlo cada
// vez que se abre la app.
app.on("login", (event, _webContents, _details, authInfo, callback) => {
  if (authInfo.isProxy || !DASHBOARD_USER) return;
  event.preventDefault();
  callback(DASHBOARD_USER, DASHBOARD_PASSWORD);
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
