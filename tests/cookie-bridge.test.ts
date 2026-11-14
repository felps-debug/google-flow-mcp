import assert from "node:assert/strict";
import test from "node:test";
import { CookieBridge } from "../src/cookie-bridge.js";

const ORIGIN = `chrome-extension://${"a".repeat(32)}`;

test("cookie bridge accepts validated Google cookies only from an extension origin", async (context) => {
  const bridge = new CookieBridge([0]);
  context.after(async () => bridge.close());
  const port = await bridge.start();
  const waiting = bridge.waitForSession(5);
  const response = await fetch(`http://127.0.0.1:${port}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      profile: "Default",
      cookies: [
        { name: "SID", value: "encrypted-session-value", domain: ".google.com", path: "/", secure: true, httpOnly: true },
        { name: "ignored", value: "nope", domain: ".example.com", path: "/" },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const session = await waiting;
  assert.equal(session.cookies.length, 1);
  assert.equal(session.cookies[0]?.domain, ".google.com");
  assert.equal(session.profile, "Default");
});

test("cookie bridge rejects normal web origins", async (context) => {
  const bridge = new CookieBridge([0]);
  context.after(async () => bridge.close());
  const port = await bridge.start();
  const response = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Origin: "https://example.com" } });
  assert.equal(response.status, 403);
});

test("cookie bridge accepts origin-less Chromium extension requests", async (context) => {
  const bridge = new CookieBridge([0]);
  context.after(async () => bridge.close());
  const port = await bridge.start();
  const response = await fetch(`http://127.0.0.1:${port}/status`);
  assert.equal(response.status, 200);
});

test("cookie bridge queues a session before the completion tool starts waiting", async (context) => {
  const bridge = new CookieBridge([0]);
  context.after(async () => bridge.close());
  const port = await bridge.start();
  const connection = bridge.armForSession(30);
  assert.equal(connection.waitingForBrowser, true);
  assert.throws(() => bridge.assertSessionReady(connection.connectionId), /has not sent/);
  const response = await fetch(`http://127.0.0.1:${port}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      profile: "Default",
      cookies: [{ name: "SID", value: "queued", domain: ".google.com", path: "/", secure: true }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(bridge.status().waitingForBrowser, false);
  assert.doesNotThrow(() => bridge.assertSessionReady(connection.connectionId));
  assert.equal(bridge.status().queuedSession, true);
  assert.equal(bridge.status().waitingForBrowser, false);
  const session = await bridge.waitForSession(1);
  assert.equal(session.cookies[0]?.value, "queued");
  assert.equal(bridge.status().queuedSession, false);
});

test("a session sent with no agent waiting starts a connection by itself and is not lost", async (context) => {
  const bridge = new CookieBridge([0]);
  context.after(async () => bridge.close());
  const port = await bridge.start();
  assert.equal(bridge.status().autoConnect, false);
  let started = 0;
  bridge.onUnsolicitedSession(async () => {
    started += 1;
    return true;
  });
  assert.equal(bridge.status().autoConnect, true);
  const send = () => fetch(`http://127.0.0.1:${port}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ profile: "Default", cookies: [{ name: "SID", value: "solo", domain: ".google.com", path: "/" }] }),
  });
  assert.equal((await send()).status, 200);
  assert.equal(started, 1);
  assert.equal((await bridge.waitForSession(1)).cookies[0]?.value, "solo");

  // An armed connection (an agent is waiting) must not trigger the automatic path.
  bridge.armForSession(30);
  assert.equal((await send()).status, 200);
  assert.equal(started, 1);
});

test("an unsolicited session is rejected and dropped while another connection is in progress", async (context) => {
  const bridge = new CookieBridge([0]);
  context.after(async () => bridge.close());
  const port = await bridge.start();
  bridge.onUnsolicitedSession(async () => false);
  const response = await fetch(`http://127.0.0.1:${port}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ profile: "Default", cookies: [{ name: "SID", value: "x", domain: ".google.com", path: "/" }] }),
  });
  assert.equal(response.status, 409);
  assert.equal(bridge.status().queuedSession, false);
});

test("cookie bridge exposes connection progress so the extension popup can show it", async (context) => {
  const bridge = new CookieBridge([0]);
  context.after(async () => bridge.close());
  const port = await bridge.start();
  assert.equal(bridge.status().progress, undefined);
  bridge.setProgress({ phase: "awaiting_account_choice", message: "Escolha a conta.", accountId: "pro-02" });
  const response = await fetch(`http://127.0.0.1:${port}/status`);
  const body = await response.json() as { progress: { phase: string; message: string; accountId: string; updatedAt: string } };
  assert.equal(body.progress.phase, "awaiting_account_choice");
  assert.equal(body.progress.message, "Escolha a conta.");
  assert.equal(body.progress.accountId, "pro-02");
  assert.ok(Date.parse(body.progress.updatedAt) > 0);
});
