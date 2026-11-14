const PORTS = Array.from({ length: 10 }, (_, index) => 37421 + index);
const statusElement = document.querySelector("#status");
const connectButton = document.querySelector("#connect");
const FRESH_MS = 3 * 60 * 1000;
// Names only, never values: used to tell the user if Chromium withheld a login cookie.
const AUTH_COOKIES = ["SID", "HSID", "SSID", "APISID", "SAPISID", "LSID", "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PSIDTS", "__Secure-3PSIDTS", "__Host-GAPS"];
const AMBIGUOUS_MESSAGE =
  "O Flow MCP aberto é de uma versão antiga. Reconecte o google-flow (/mcp no Claude Code, ou reinicie o Codex) e abra esta janela de novo.";
let bridge;
let polling;

let cookieNote = "";

function setStatus(message, state = "") {
  statusElement.textContent = cookieNote ? `${message} ${cookieNote}` : message;
  statusElement.className = `status ${state}`.trim();
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

async function readStatus(port) {
  try {
    const response = await request(`http://127.0.0.1:${port}/status`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function findBridge() {
  const results = await Promise.all(PORTS.map(async (port) => {
    const status = await readStatus(port);
    return status ? { port, status } : null;
  }));
  const running = results.filter(Boolean);
  const waiting = running
    .filter((entry) => entry.status.waitingForBrowser)
    .sort((left, right) => Date.parse(right.status.connectionRequestedAt || 0) - Date.parse(left.status.connectionRequestedAt || 0));
  if (waiting[0]) return waiting[0];
  // Several Flow MCP servers can run at once (Claude Code, Codex, Hermes...). Any server
  // that reports autoConnect finishes the connection on its own, with no agent waiting;
  // older ones would just hold the session, so they are never chosen.
  const capable = running.find((entry) => entry.status.autoConnect);
  if (capable) return capable;
  return running.length ? { ambiguous: running.length } : null;
}

async function googleCookies() {
  const groups = await Promise.all([
    chrome.cookies.getAll({ domain: "google.com" }),
    chrome.cookies.getAll({ domain: "labs.google" }),
  ]);
  const unique = new Map();
  for (const cookie of groups.flat()) {
    unique.set(`${cookie.storeId}|${cookie.domain}|${cookie.path}|${cookie.name}`, cookie);
  }
  return [...unique.values()];
}

function isFresh(progress) {
  return Boolean(progress) && Date.now() - Date.parse(progress.updatedAt) < FRESH_MS;
}

// Mirrors what the agent's flow_connect call is doing, so nobody has to report back.
function showProgress(status) {
  const progress = isFresh(status.progress) ? status.progress : undefined;
  if (progress?.phase === "connected") {
    setStatus("Conta conectada. Pode voltar para o agente, ele continua sozinho.", "ready");
    connectButton.textContent = "Conectado";
    connectButton.disabled = true;
    return "done";
  }
  if (progress?.phase === "failed") {
    setStatus(progress.message, "error");
    connectButton.textContent = "Tentar de novo";
    connectButton.disabled = false;
    return "done";
  }
  if (progress && (progress.phase === "awaiting_account_choice" || progress.phase === "verifying")) {
    setStatus(progress.message, "ready");
    connectButton.textContent = "Sessão enviada";
    connectButton.disabled = true;
    return "working";
  }
  return "idle";
}

function startPolling() {
  clearInterval(polling);
  polling = setInterval(async () => {
    const status = await readStatus(bridge.port);
    if (!status) return;
    if (showProgress(status) === "done") clearInterval(polling);
  }, 1000);
}

async function initialize() {
  bridge = await findBridge();
  if (!bridge) {
    setStatus("O Flow MCP não está rodando. Peça ao agente para gerar um vídeo e abra esta janela de novo.", "error");
    return;
  }
  if (bridge.ambiguous) {
    setStatus(AMBIGUOUS_MESSAGE, "error");
    connectButton.disabled = true;
    return;
  }
  const state = showProgress(bridge.status);
  if (state === "working") {
    startPolling();
    return;
  }
  if (state === "done") return;
  if (bridge.status.queuedSession) {
    setStatus("Sessão enviada. O agente já está continuando.", "ready");
    connectButton.textContent = "Sessão enviada";
    connectButton.disabled = true;
    return;
  }
  setStatus(
    bridge.status.waitingForBrowser
      ? "O agente está esperando. Clique em Connect Flow."
      : "Pronto. Clique em Connect Flow para conectar uma conta. Ela fica conectada para todos os agentes.",
    "ready",
  );
  connectButton.disabled = false;
}

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  connectButton.textContent = "Conectando…";
  setStatus("Lendo a sessão do Google deste navegador…");
  try {
    bridge = bridge || await findBridge();
    if (!bridge) throw new Error("O Flow MCP não está rodando.");
    if (bridge.ambiguous) throw new Error(AMBIGUOUS_MESSAGE);
    const cookies = await googleCookies();
    if (!cookies.length) throw new Error("Nenhuma sessão do Google logada foi encontrada neste perfil do Chromium.");
    const response = await request(`http://127.0.0.1:${bridge.port}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies, browser: navigator.userAgent, profile: "Chromium" }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "O Flow MCP recusou a sessão do navegador.");
    const present = new Set(cookies.map((cookie) => cookie.name));
    const missing = AUTH_COOKIES.filter((name) => !present.has(name));
    cookieNote = `[${cookies.length} cookies enviados. ` +
      (missing.length ? `Login ausente: ${missing.join(", ")}.]` : "Cookies de login completos.]");
    setStatus("Sessão enviada. Escolha a conta na janela do Google que vai abrir.", "ready");
    connectButton.textContent = "Sessão enviada";
    startPolling();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
    connectButton.disabled = false;
    connectButton.textContent = "Tentar de novo";
  }
});

void initialize();
