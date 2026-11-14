import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeAddArgs, inspectCodexToml, patchCodexToml } from "../scripts/doctor.mjs";
import { needsBuild, needsDependencies } from "../scripts/launch.mjs";

const LAUNCHER = "C:\\Users\\me\\code\\google-flow-mcp\\scripts\\launch.mjs";

const EXISTING = [
  'model = "gpt-5"',
  "",
  "[mcp_servers.fathom]",
  'command = "uv"',
  "",
  "[mcp_servers.google_flow]",
  'command = "node"',
  "args = ['C:\\old\\dist\\index.js']",
  "startup_timeout_sec = 30.0",
  "tool_timeout_sec = 1200.0",
  "",
  "[mcp_servers.google_flow.env]",
  'FLOW_MCP_HEADLESS = "0"',
  "",
  "[mcp_servers.other]",
  'command = "other"',
  "",
].join("\n");

test("inspectCodexToml reads the google_flow section only", () => {
  const info = inspectCodexToml(EXISTING);
  assert.equal(info.present, true);
  assert.equal(info.args, "['C:\\old\\dist\\index.js']");
  assert.equal(info.startupTimeoutSec, 30);
  assert.equal(info.toolTimeoutSec, 1200);
  assert.deepEqual(inspectCodexToml('[mcp_servers.fathom]\ncommand = "uv"\n'), { present: false });
});

test("patchCodexToml repoints google_flow, raises the startup timeout and leaves everything else alone", () => {
  const patched = patchCodexToml(EXISTING, LAUNCHER);
  const info = inspectCodexToml(patched);
  assert.equal(info.args, `['${LAUNCHER}']`);
  assert.equal(info.startupTimeoutSec, 90);
  assert.equal(info.toolTimeoutSec, 1200);
  assert.match(patched, /\[mcp_servers\.fathom\]\ncommand = "uv"/);
  assert.match(patched, /\[mcp_servers\.google_flow\.env\]\nFLOW_MCP_HEADLESS = "0"/);
  assert.match(patched, /\[mcp_servers\.other\]\ncommand = "other"/);
  assert.match(patched, /^model = "gpt-5"/);
  assert.equal(patched.match(/\[mcp_servers\.google_flow\]/g)?.length, 1);
});

test("patchCodexToml never lowers a timeout the user already raised", () => {
  const text = "[mcp_servers.google_flow]\ncommand = \"node\"\nargs = ['x']\nstartup_timeout_sec = 300\ntool_timeout_sec = 3000\n";
  const info = inspectCodexToml(patchCodexToml(text, LAUNCHER));
  assert.equal(info.startupTimeoutSec, 300);
  assert.equal(info.toolTimeoutSec, 3000);
});

test("patchCodexToml is idempotent", () => {
  const once = patchCodexToml(EXISTING, LAUNCHER);
  assert.equal(patchCodexToml(once, LAUNCHER), once);
});

test("patchCodexToml adds the whole block when google_flow is missing and keeps CRLF files CRLF", () => {
  const crlf = 'model = "gpt-5"\r\n\r\n[mcp_servers.fathom]\r\ncommand = "uv"\r\n';
  const patched = patchCodexToml(crlf, LAUNCHER);
  assert.match(patched, /\[mcp_servers\.google_flow\]\r\ncommand = "node"\r\nargs = \['C:\\Users\\me\\code\\google-flow-mcp\\scripts\\launch\.mjs'\]/);
  assert.equal(patched.includes("\r\n"), true);
  assert.equal(/[^\r]\n/.test(patched), false);
  assert.equal(inspectCodexToml(patched).present, true);
});

test("launcher detects missing dependencies and a stale build", async (context) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "flow-mcp-launch-"));
  context.after(async () => rm(repo, { recursive: true, force: true }));
  assert.equal(needsDependencies(repo), true);
  await mkdir(path.join(repo, "node_modules", "@modelcontextprotocol", "sdk"), { recursive: true });
  await mkdir(path.join(repo, "node_modules", "playwright"), { recursive: true });
  await writeFile(path.join(repo, "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "{}");
  assert.equal(needsDependencies(repo), true, "Playwright is still missing");
  await writeFile(path.join(repo, "node_modules", "playwright", "package.json"), "{}");
  assert.equal(needsDependencies(repo), false);

  assert.equal(needsBuild(repo), true, "no dist yet");
  await mkdir(path.join(repo, "dist"), { recursive: true });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "a.ts"), "export {};");
  await writeFile(path.join(repo, "dist", "index.js"), "");
  const old = new Date(Date.now() - 60_000);
  await utimes(path.join(repo, "src", "a.ts"), old, old);
  assert.equal(needsBuild(repo), false, "dist is newer than src");
  const future = new Date(Date.now() + 60_000);
  await utimes(path.join(repo, "src", "a.ts"), future, future);
  assert.equal(needsBuild(repo), true, "src is newer than dist");
});

test("claude mcp add puts the server name before -e so it is not read as an env var", () => {
  const args = claudeAddArgs(LAUNCHER);
  assert.ok(args.indexOf("google-flow") < args.indexOf("-e"));
  assert.deepEqual(args.slice(args.indexOf("--")), ["--", "node", LAUNCHER]);
});
