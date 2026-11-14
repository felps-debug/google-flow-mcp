import assert from "node:assert/strict";
import test from "node:test";
import { ConnectionManager, type ConnectionBridge, type ConnectOptions } from "../src/connection.js";
import { FlowError } from "../src/errors.js";

class FakeBridge implements ConnectionBridge {
  armed = 0;
  progress: Array<{ phase: string; message: string }> = [];
  armForSession(): void {
    this.armed += 1;
  }
  setProgress(progress: { phase: string; message: string }): void {
    this.progress.push(progress);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("start arms the bridge once and is idempotent while a connection is pending", async () => {
  const bridge = new FakeBridge();
  const gate = deferred<string>();
  let calls = 0;
  const manager = new ConnectionManager({
    connectAccount: () => {
      calls += 1;
      return gate.promise;
    },
  }, bridge, 30);

  const first = manager.start({ accountId: "pro-02" });
  assert.equal(first.phase, "awaiting_extension");
  assert.equal(first.accountId, "pro-02");
  const second = manager.start({});
  assert.equal(second.id, first.id);
  assert.equal(calls, 1);
  assert.equal(bridge.armed, 1);
  assert.equal(manager.pending?.id, first.id);

  gate.resolve("ok");
  const done = await manager.wait(5);
  assert.equal(done.phase, "connected");
  assert.equal(manager.pending, undefined);
});

test("start refuses a different account while another connection is pending", async () => {
  const gate = deferred<string>();
  const manager = new ConnectionManager({ connectAccount: () => gate.promise }, new FakeBridge(), 30);
  manager.start({ accountId: "one" });
  assert.throws(() => manager.start({ accountId: "two" }), /already in progress/);
  gate.resolve("ok");
  await manager.wait(5);
});

test("phase callbacks from the adapter update the visible state and the bridge progress", async () => {
  const bridge = new FakeBridge();
  const gate = deferred<string>();
  let options: ConnectOptions | undefined;
  const manager = new ConnectionManager({
    connectAccount: (_id, _label, received) => {
      options = received;
      return gate.promise;
    },
  }, bridge, 30);
  manager.start({});
  assert.equal(options?.browserMode, "extension");
  assert.equal(options?.chooseGoogleAccount, true);
  options?.onPhase?.("awaiting_account_choice");
  assert.equal(manager.pending?.phase, "awaiting_account_choice");
  options?.onPhase?.("verifying");
  assert.equal(manager.pending?.phase, "verifying");
  assert.deepEqual(bridge.progress.map((item) => item.phase), ["awaiting_extension", "awaiting_account_choice", "verifying"]);
  gate.resolve("Connected Google Flow account 'x'.");
  const done = await manager.wait(5);
  assert.equal(done.phase, "connected");
  assert.equal(bridge.progress.at(-1)?.phase, "connected");
});

test("wait returns the still-pending state when the user has not finished yet", async () => {
  const gate = deferred<string>();
  const manager = new ConnectionManager({ connectAccount: () => gate.promise }, new FakeBridge(), 30);
  manager.start({});
  const state = await manager.wait(0.05);
  assert.equal(state.phase, "awaiting_extension");
  assert.equal(manager.pending?.phase, "awaiting_extension");
  gate.resolve("ok");
  await manager.wait(5);
});

test("a failed connection records the structured error and frees the manager for a retry", async () => {
  const bridge = new FakeBridge();
  const manager = new ConnectionManager({
    connectAccount: async () => {
      throw new FlowError("flow_access_unavailable", "No Flow workspace.", ["Pick another account."]);
    },
  }, bridge, 30);
  manager.start({});
  const state = await manager.wait(5);
  assert.equal(state.phase, "failed");
  assert.equal(state.error?.code, "flow_access_unavailable");
  assert.deepEqual(state.error?.suggestions, ["Pick another account."]);
  assert.equal(manager.pending, undefined);
  assert.equal(bridge.progress.at(-1)?.phase, "failed");

  const retry = manager.start({});
  assert.notEqual(retry.id, state.id);
  assert.equal(retry.phase, "awaiting_extension");
  assert.equal(bridge.armed, 2);
  await manager.wait(5);
});

test("an unexpected error is reported as internal_error", async () => {
  const manager = new ConnectionManager({
    connectAccount: async () => {
      throw new Error("boom");
    },
  }, new FakeBridge(), 30);
  manager.start({});
  const state = await manager.wait(5);
  assert.equal(state.phase, "failed");
  assert.equal(state.error?.code, "internal_error");
  assert.match(state.error?.message ?? "", /boom/);
});

test("wait without any connection returns undefined", async () => {
  const manager = new ConnectionManager({ connectAccount: async () => "ok" }, new FakeBridge(), 30);
  assert.equal(await manager.wait(1), undefined);
});
