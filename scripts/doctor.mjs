#!/usr/bin/env node
// Checks (and with --fix repairs) everything that can stop Flow MCP from working
// in Claude Code and Codex. Plain JavaScript on purpose: it must run even when
// node_modules or dist are broken, which is exactly when you need it.
//
//   npm run doctor    -> report only
//   npm run setup     -> report, then fix what it can
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { needsBuild, needsDependencies } from "./launch.mjs";
import { detectSystemBrowser, npmInvocation } from "./setup-antigravity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "scripts", "launch.mjs");
const CODEX_SECTION = "mcp_servers.google_flow";

function tomlLiteral(value) {
  if (value.includes("'")) return JSON.stringify(value);
  return `'${value}'`;
}

function splitSections(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return { eol, lines: text.split(/\r?\n/) };
}

/** Reads what the Codex config currently says about the google_flow server. */
export function inspectCodexToml(text) {
  const { lines } = splitSections(text);
  const header = lines.findIndex((line) => line.trim() === `[${CODEX_SECTION}]`);
  if (header < 0) return { present: false };
  let end = lines.findIndex((line, index) => index > header && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  const body = lines.slice(header + 1, end);
  const args = body.find((line) => /^\s*args\s*=/.test(line));
  const startup = body.find((line) => /^\s*startup_timeout_sec\s*=/.test(line));
  const tool = body.find((line) => /^\s*tool_timeout_sec\s*=/.test(line));
  const number = (line) => (line ? Number.parseFloat(line.split("=")[1] ?? "") : undefined);
  return {
    present: true,
    args: args?.slice(args.indexOf("=") + 1).trim(),
    startupTimeoutSec: number(startup),
    toolTimeoutSec: number(tool),
  };
}

/**
 * Points the google_flow server at the launcher and gives it enough time to
 * self-repair on first start. Other servers and settings are left untouched.
 */
export function patchCodexToml(text, launcherPath) {
  const { eol, lines } = splitSections(text);
  const argsLine = `args = [${tomlLiteral(launcherPath)}]`;
  const header = lines.findIndex((line) => line.trim() === `[${CODEX_SECTION}]`);
  if (header < 0) {
    const trimmed = text.replace(/\s+$/, "");
    const block = [
      `[${CODEX_SECTION}]`,
      'command = "node"',
      argsLine,
      "startup_timeout_sec = 90",
      "tool_timeout_sec = 1200",
      "",
      `[${CODEX_SECTION}.env]`,
      'FLOW_MCP_HEADLESS = "0"',
      "",
    ].join(eol);
    return `${trimmed}${trimmed ? eol + eol : ""}${block}`;
  }
  let end = lines.findIndex((line, index) => index > header && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  const body = lines.slice(header + 1, end);
  const upsert = (key, value, onlyRaise = false) => {
    const index = body.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (index < 0) {
      body.unshift(`${key} = ${value}`);
      return;
    }
    if (onlyRaise) {
      const current = Number.parseFloat(body[index].split("=")[1] ?? "");
      if (Number.isFinite(current) && current >= Number.parseFloat(value)) return;
    }
    body[index] = `${key} = ${value}`;
  };
  upsert("args", `[${tomlLiteral(launcherPath)}]`);
  upsert("startup_timeout_sec", "90", true);
  upsert("tool_timeout_sec", "1200", true);
  if (!body.some((line) => /^\s*command\s*=/.test(line))) body.unshift('command = "node"');
  return [...lines.slice(0, header + 1), ...body, ...lines.slice(end)].join(eol);
}

export function dataDirectory(environment = process.env) {
  if (environment.FLOW_MCP_DATA_DIR) return path.resolve(environment.FLOW_MCP_DATA_DIR);
  if (process.platform === "win32") {
    return path.join(environment.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "flow-mcp");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "flow-mcp");
  return path.join(environment.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "flow-mcp");
}

function readAccounts() {
  const file = path.join(dataDirectory(), "accounts.json");
  if (!existsSync(file)) return { accounts: [] };
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { accounts: [], unreadable: true };
  }
}

/**
 * `-e` accepts several values, so the server name must come BEFORE it or
 * claude reads the name as an environment variable.
 */
export function claudeAddArgs(launcherPath) {
  return ["mcp", "add", "-s", "user", "google-flow", "-e", "FLOW_MCP_HEADLESS=0", "--", "node", launcherPath];
}

function runClaude(args) {
  const direct = spawnSync("claude", args, { encoding: "utf8", shell: false });
  if (!direct.error) return direct;
  if (process.platform !== "win32") return direct;
  const quoted = args.map((value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value));
  return spawnSync("claude", quoted, { encoding: "utf8", shell: true });
}

function claudeEntry() {
  const result = runClaude(["mcp", "get", "google-flow"]);
  if (result.error || result.status !== 0) return { present: false, cliMissing: Boolean(result.error) };
  const output = `${result.stdout}${result.stderr}`;
  return {
    present: true,
    usesLauncher: output.includes(launcher),
    failed: /failed to connect/i.test(output),
  };
}

const results = [];
function check(name, ok, detail, fix) {
  results.push({ name, ok, detail, fix });
}

export async function runDoctor({ fix = false } = {}) {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  check("Node.js 20+", major >= 20, process.version);

  if (needsDependencies(root)) {
    check("Dependencies installed", false, "node_modules is missing the MCP SDK or Playwright", fix ? () => {
      const npm = npmInvocation();
      const run = spawnSync(npm.command, [...npm.prefix, "ci"], { cwd: root, stdio: "inherit" });
      if (run.status !== 0) throw new Error("npm ci failed");
    } : undefined);
  } else {
    check("Dependencies installed", true, "node_modules is present");
  }

  const stale = needsBuild(root);
  check("Build is current", !stale, stale ? "dist/ is missing or older than src/" : "dist/index.js is newer than src/", fix ? () => {
    const npm = npmInvocation();
    const run = spawnSync(npm.command, [...npm.prefix, "run", "build"], { cwd: root, stdio: "inherit" });
    if (run.status !== 0) throw new Error("npm run build failed");
  } : undefined);

  const browser = detectSystemBrowser();
  check("Chromium or Chrome found", Boolean(browser), browser ?? "Install Chrome/Chromium, or set FLOW_MCP_BROWSER_EXECUTABLE");

  const manifest = path.join(root, "extension", "manifest.json");
  if (existsSync(manifest)) {
    const version = JSON.parse(readFileSync(manifest, "utf8")).version;
    check("Extension folder", true, `${path.join(root, "extension")} (v${version}). Reload it at chrome://extensions after updates.`);
  } else {
    check("Extension folder", false, `${manifest} is missing`);
  }

  const accounts = readAccounts();
  const connected = (accounts.accounts ?? []).filter((account) => account.connectionStatus === "connected");
  const summary = (accounts.accounts ?? []).map((account) => `${account.id}=${account.connectionStatus ?? "unverified"}`).join(", ");
  check(
    "Connected Flow account",
    connected.length > 0,
    summary ? `${summary}${accounts.defaultAccountId ? ` (default: ${accounts.defaultAccountId})` : ""}` : "No account yet. Ask your agent to generate a video and follow the steps.",
  );

  const claude = claudeEntry();
  if (claude.cliMissing) {
    check("Claude Code registration", false, "The claude CLI was not found on PATH");
  } else {
    check(
      "Claude Code registration",
      claude.present && claude.usesLauncher,
      !claude.present ? "google-flow is not registered" : claude.usesLauncher ? "google-flow uses the launcher" : "google-flow does not use the launcher",
      fix ? () => {
        if (claude.present) runClaude(["mcp", "remove", "-s", "user", "google-flow"]);
        const addArgs = claudeAddArgs(launcher);
        const add = runClaude(addArgs);
        if (add.status !== 0) {
          throw new Error(`claude mcp add failed (${add.stderr || add.stdout}). Re-create it by hand: claude ${addArgs.join(" ")}`);
        }
      } : undefined,
    );
  }

  const codexConfig = path.join(os.homedir(), ".codex", "config.toml");
  if (existsSync(codexConfig)) {
    const text = readFileSync(codexConfig, "utf8");
    const info = inspectCodexToml(text);
    const expectedArgs = `[${tomlLiteral(launcher)}]`;
    const good = info.present && info.args === expectedArgs && (info.startupTimeoutSec ?? 0) >= 60 && (info.toolTimeoutSec ?? 0) >= 600;
    check(
      "Codex registration",
      good,
      !info.present ? "google_flow is not in ~/.codex/config.toml" : good ? "google_flow uses the launcher with long timeouts" : "google_flow needs the launcher and longer timeouts",
      fix ? () => {
        copyFileSync(codexConfig, `${codexConfig}.flow-mcp.bak`);
        writeFileSync(codexConfig, patchCodexToml(text, launcher));
      } : undefined,
    );
  } else {
    check("Codex registration", false, "~/.codex/config.toml not found (skip if you do not use Codex)");
  }

  let failures = 0;
  for (const item of results) {
    let ok = item.ok;
    let detail = item.detail;
    if (!ok && item.fix) {
      try {
        item.fix();
        ok = true;
        detail = `${detail} -> fixed`;
      } catch (error) {
        detail = `${detail} -> fix failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (!ok) failures += 1;
    console.log(`${ok ? "OK  " : "FAIL"}  ${item.name}: ${detail}`);
  }
  if (failures === 0) {
    console.log("\nEverything is in place. After changing MCP config, reconnect with /mcp in Claude Code or restart Codex.");
  } else if (!fix) {
    console.log("\nRun `npm run setup` to fix what can be fixed automatically.");
  }
  return failures;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runDoctor({ fix: process.argv.includes("--fix") }).then((failures) => {
    process.exitCode = failures ? 1 : 0;
  });
}
