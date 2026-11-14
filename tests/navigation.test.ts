import assert from "node:assert/strict";
import test from "node:test";
import { canonicalFlowProjectUrl } from "../src/navigation.js";

test("asset editor URLs return to their language-preserving project workspace", () => {
  assert.equal(
    canonicalFlowProjectUrl("https://labs.google/fx/es/tools/flow/project/project-1/edit/asset-2?view=full#clip"),
    "https://labs.google/fx/es/tools/flow/project/project-1",
  );
  assert.equal(
    canonicalFlowProjectUrl("https://labs.google/fx/tools/flow/project/project-1"),
    "https://labs.google/fx/tools/flow/project/project-1",
  );
});

test("flow.google.com project URLs are recognized and canonicalized", async () => {
  const { isFlowProjectUrl, isFlowPageUrl } = await import("../src/navigation.js");
  assert.equal(isFlowPageUrl("https://flow.google.com/"), true);
  assert.equal(isFlowProjectUrl("https://flow.google.com/project/abc-123"), true);
  assert.equal(isFlowProjectUrl("https://flow.google.com/"), false);
  assert.equal(isFlowProjectUrl("https://example.com/project/abc"), false);
  assert.equal(
    canonicalFlowProjectUrl("https://flow.google.com/project/abc-123/edit/asset-9?view=full"),
    "https://flow.google.com/project/abc-123",
  );
});

test("session cookies get a bounded lifetime so the managed profile keeps the login", async () => {
  const { persistentExpiry } = await import("../src/browser-manager.js");
  assert.equal(persistentExpiry(1_900_000_000, 1_000), 1_900_000_000);
  assert.equal(persistentExpiry(undefined, 1_000), 1_000 + 14 * 24 * 60 * 60);
  assert.equal(persistentExpiry(-1, 1_000), 1_000 + 14 * 24 * 60 * 60);
});

test("project sub-views return to the project root", () => {
  assert.equal(canonicalFlowProjectUrl("https://flow.google.com/project/abc-123/trash"), "https://flow.google.com/project/abc-123");
  assert.equal(canonicalFlowProjectUrl("https://flow.google.com/project/abc-123"), "https://flow.google.com/project/abc-123");
});
