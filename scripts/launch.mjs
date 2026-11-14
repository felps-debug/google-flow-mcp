#!/usr/bin/env node
// Self-healing entry point for MCP clients (Claude Code, Codex, ...).
//
// Pointing a client straight at dist/index.js makes a missing node_modules or
// a stale build look like an opaque "Connection closed". This launcher repairs
// both before starting the server and explains any failure on stderr. stdout
// belongs to the MCP protocol, so nothing here may print to it.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { npmInvocation } from "./setup-antigravity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(root, "dist", "index.js");

function log(message) {
  process.stderr.write(`[flow-mcp launcher] ${message}\n`);
}

export function newestSourceTime(directory) {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceTime(full));
    else if (entry.name.endsWith(".ts")) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

export function needsDependencies(repoRoot = root) {
  return !existsSync(path.join(repoRoot, "node_modules", "@modelcontextprotocol", "sdk", "package.json"))
    || !existsSync(path.join(repoRoot, "node_modules", "playwright", "package.json"));
}

export function needsBuild(repoRoot = root) {
  const entry = path.join(repoRoot, "dist", "index.js");
  if (!existsSync(entry)) return true;
  const source = path.join(repoRoot, "src");
  return existsSync(source) && newestSourceTime(source) > statSync(entry).mtimeMs;
}

function npm(args) {
  const invocation = npmInvocation();
  const result = spawnSync(invocation.command, [...invocation.prefix, ...args], {
    cwd: root,
    stdio: ["ignore", 2, 2],
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} exited with code ${result.status}`);
}

async function main() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 20) throw new Error(`Node.js 20 or newer is required; this is ${process.version}.`);
  if (needsDependencies()) {
    log("Dependencies are missing; running npm ci (one time, about 30 seconds).");
    npm(["ci"]);
  }
  if (needsBuild()) {
    log("The build is missing or older than src/; running npm run build.");
    npm(["run", "build"]);
  }
  await import(pathToFileURL(distEntry).href);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    log(`Could not start Flow MCP: ${error instanceof Error ? error.message : String(error)}`);
    log(`Run "npm run doctor" in ${root} to see what is wrong.`);
    process.exit(1);
  });
}
