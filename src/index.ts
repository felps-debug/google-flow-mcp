#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FLOW_ACCOUNT_GUIDANCE, FLOW_AGENT_INSTRUCTIONS, FLOW_TOOL_GUARD } from "./agent-contract.js";
import { BrowserManager } from "./browser-manager.js";
import { ConnectionManager, type ConnectionState } from "./connection.js";
import { CookieBridge } from "./cookie-bridge.js";
import { errorText, FlowError } from "./errors.js";
import { FlowAdapter } from "./flow-adapter.js";
import { assertExistingFiles, requireAbsoluteDirectory, validateAccountId } from "./paths.js";
import { FlowStore } from "./store.js";
import type { FlowJob, GenerationRequest, UiCapabilities } from "./types.js";

const store = new FlowStore();
await store.initialize();
const browsers = new BrowserManager(store);
const cookieBridge = new CookieBridge();
await cookieBridge.start();
const flow = new FlowAdapter(store, browsers, cookieBridge);
const connections = new ConnectionManager(flow, cookieBridge);
// Clicking Connect Flow with no agent waiting still connects the account: it is
// added under a fresh ID, becomes the default, and stays connected for every agent.
cookieBridge.onUnsolicitedSession(async () => {
  if (connections.pending) return false;
  connections.start({ accountId: await store.availableAccountId("conta") });
  return true;
});
const extensionDirectory = fileURLToPath(new URL("../extension/", import.meta.url));

const server = new McpServer({
  name: "flow-mcp",
  version: "0.2.3",
  description: "Automates Google Flow through user-owned, persistent Chromium sessions and saves generated media locally.",
}, {
  instructions: FLOW_AGENT_INSTRUCTIONS,
});

function ok(value: string | FlowJob | UiCapabilities | unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

const CONNECTION_STEPS: Record<string, string[]> = {
  awaiting_extension: [
    "Abra o Chromium onde suas contas do Google já estão logadas.",
    "Clique na extensão Flow Login Bridge e depois em Connect Flow.",
    "Vai abrir uma janela do Google: clique na conta que você quer usar no Flow.",
  ],
  awaiting_account_choice: ["Na janela do Google que abriu, clique na conta que você quer usar no Flow."],
  verifying: ["Aguarde alguns segundos: estou verificando se essa conta tem acesso ao Flow."],
};

function describeConnection(state: ConnectionState, justStarted: boolean): unknown {
  if (state.phase === "connected") {
    return {
      status: "connected",
      accountId: state.accountId,
      readyForGeneration: true,
      message: state.result,
      agentInstruction: "Connected. Continue with the user's request now (flow_inspect_account, then the generation tool). Do not call flow_connect again.",
    };
  }
  if (state.phase === "failed") {
    return {
      status: "failed",
      error: state.error,
      agentInstruction: "The connection failed. Tell the user this exact error in their language. Call flow_connect again only if the user wants to retry; never use browser or computer-use tools on Flow.",
    };
  }
  return {
    status: "awaiting_user",
    phase: state.phase,
    connectionId: state.id,
    message: state.message,
    userMessage: CONNECTION_STEPS[state.phase] ?? [],
    extensionDirectory,
    agentInstruction: justStarted
      ? "Tell the user the userMessage steps NOW in their language, then IMMEDIATELY call flow_connect again (no arguments needed): it waits for the user. Do not ask the user to reply and never ask them to say 'connected'."
      : "The user has not finished yet. Call flow_connect again to keep waiting. If this repeats several times, ask the user whether they need help with the userMessage steps.",
  };
}

function failed(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: errorText(error) }], isError: true };
}

const accountId = z
  .string()
  .min(1)
  .max(48)
  .describe("Local account profile ID such as 'personal' or 'studio'. Each managed ID has an isolated persistent Chromium profile.");
const connectedAccountId = accountId.optional().describe(FLOW_ACCOUNT_GUIDANCE);
const upscale = z
  .string()
  .min(2)
  .max(80)
  .describe("Exact normalized upscale ID returned by flow_inspect_account (for example 1080p, 2x, or 4k), none, or highest_available. Unsupported and unavailable choices fail explicitly.");
const referenceFiles = z
  .array(z.string())
  .default([])
  .describe("Absolute paths to optional local images or videos to attach as Flow references/ingredients/frames.");
const outputDirectory = z
  .string()
  .describe("Absolute directory where downloads and .flow.json manifests are saved, e.g. C:\\project\\public\\generated\\flow.");
const timeoutSeconds = z
  .number()
  .int()
  .min(15)
  .max(900)
  .default(600)
  .describe("Maximum seconds to wait for this generation or upscale. A timeout leaves a persistent job that can be polled.");
const confirmCreditSpend = z
  .literal(true)
  .describe("Must be true. Confirms the user explicitly authorized this operation to consume Google Flow/AI credits.");

server.registerTool(
  "flow_help",
  {
    title: "What Can Google Flow MCP Do?",
    description: "Call this when the user asks what Google Flow MCP can do, how to use it, or for example requests. Returns a concise multilingual-ready capability guide without opening a browser or spending credits.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const accounts = await store.listAccounts();
      return ok({
        product: "Google Flow MCP",
        summary: "Create Google Flow videos and images from natural-language requests, discover the exact options on the connected account, use real Flow upscaling, and download validated media into the user's project.",
        capabilities: [
          "Generate one or more videos with live Flow video models such as Omni Flash or available Veo variants",
          "Generate or edit images with available Nano Banana variants",
          "Use prompts in any language",
          "Select live aspect ratios, output counts, and durations when Flow exposes them",
          "Attach local image/video references, ingredients, or frames",
          "Use Flow's available video upscale options such as 1080p or highest_available",
          "Persist Flow's Never-ask generation setting inside each isolated managed Chromium profile",
          "Track each job's exact generated assets so gallery reordering cannot substitute an older file",
          "Download media plus reproducibility manifests, hashes, and optional FFprobe metadata",
          "Keep multiple Google Flow accounts in isolated local sessions",
        ],
        exampleRequests: [
          "Create one 16:9 Omni Flash video of a glass jellyfish floating through a rainy neon city and save it in my project.",
          "Generate a vertical 9:16 image with Nano Banana 2 using this reference image.",
          "Inspect my Flow account and tell me which models, ratios, durations, output counts, and upscales are available.",
          "Upscale the last generated video to the highest option my Flow account currently offers.",
          "Download the finished clip into my Remotion public/generated/flow folder.",
        ],
        connectedAccountIds: accounts.accounts.filter((account) => account.connectionStatus === "connected").map((account) => account.id),
        defaultAccountId: accounts.defaultAccountId,
        ready: Boolean(accounts.defaultAccountId),
        agentInstruction: "Answer the user in their language with relevant examples. For generation, call flow_connect, flow_inspect_account, then the matching flow_generate_* tool; never operate the Flow website with generic browser tools.",
      });
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_list_accounts",
  {
    title: "List Google Flow Accounts",
    description: `Lists the local Flow accounts and which one is the verified default. Read-only. To get connected, call flow_connect instead. ${FLOW_TOOL_GUARD}`,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const accounts = await store.listAccounts();
      const connectedAccountIds = accounts.accounts.filter((account) => account.connectionStatus === "connected").map((account) => account.id);
      const readyForGeneration = Boolean(accounts.defaultAccountId && connectedAccountIds.includes(accounts.defaultAccountId));
      return ok({
        ...accounts,
        connectedAccountIds,
        readyForGeneration,
        connectionRequired: !readyForGeneration,
        agentInstruction: readyForGeneration
          ? `ACCOUNT IS ALREADY CONNECTED. Use '${accounts.defaultAccountId}'. Call flow_inspect_account next. DO NOT call flow_connect, PowerShell, or browser/computer-use tools.`
          : "No verified default account exists. Call flow_connect and follow its instructions.",
      });
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_connect",
  {
    title: "Connect a Google Flow Account",
    description: "FIRST STEP for Google Flow work, and the ONLY account-connection tool. Returns status=connected immediately when a verified account already exists (then do not ask the user to connect anything). Otherwise it starts a connection and returns status=awaiting_user with userMessage: tell the user those steps now, then IMMEDIATELY call flow_connect again; that call waits for the user and finishes by itself once they click Connect Flow in the extension and pick the Google account. Never ask the user to reply connected. Pass accountId to add or reconnect a specific local account. " + FLOW_TOOL_GUARD,
    inputSchema: {
      accountId: accountId.optional().describe("Optional local ID to add or reconnect, such as 'pro-02'. Omit to use the verified default account, or to let a safe ID be created for a new one."),
      label: z.string().max(100).optional().describe("Optional local label. Omit to use the transferred Chromium profile name."),
      waitSeconds: z.number().int().min(0).max(600).optional().describe("Seconds to wait for the user to finish. Default: 0 when this call starts a new connection (so you can tell the user what to do first), 240 when a connection is already in progress."),
      force: z.boolean().default(false).describe("Start a new connection even though a verified account already exists, for example to add another account."),
      manualLogin: z.boolean().default(false).describe("Open a Google sign-in window in the isolated browser and let the user sign in by hand, without the extension. Use it when the user asks to log in manually or when the extension session is rejected by Google."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ accountId: id, label, waitSeconds, force, manualLogin }) => {
    try {
      const accounts = await store.listAccounts();
      const connectedDefault = accounts.defaultAccountId
        ? accounts.accounts.find((account) => account.id === accounts.defaultAccountId && account.connectionStatus === "connected")
        : undefined;
      const requestedId = id ? validateAccountId(id) : undefined;
      const requested = requestedId ? accounts.accounts.find((account) => account.id === requestedId) : undefined;
      if (!connections.pending && !force && !manualLogin) {
        const ready = requestedId ? (requested?.connectionStatus === "connected" ? requested : undefined) : connectedDefault;
        if (ready) {
          return ok({
            status: "connected",
            alreadyConnected: true,
            accountId: ready.id,
            readyForGeneration: true,
            connectedAccountIds: accounts.accounts.filter((account) => account.connectionStatus === "connected").map((account) => account.id),
            agentInstruction: "Account '" + ready.id + "' is already connected. Do NOT ask the user to connect anything; continue with flow_inspect_account and the generation tool.",
          });
        }
      }
      const startedNow = !connections.pending;
      const started = connections.start({
        ...(requestedId ? { accountId: requestedId } : {}),
        ...(label ? { label } : {}),
        ...(manualLogin ? { manualLogin: true } : {}),
      });
      const wait = waitSeconds ?? (startedNow ? 0 : 240);
      const state = (wait > 0 ? await connections.wait(wait) : undefined) ?? started;
      return ok(describeConnection(state, startedNow && wait === 0));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_inspect_account",
  {
    title: "Inspect Google Flow Account UI",
    description: `MANDATORY before generation. Verifies the real Flow workspace and returns a language-independent live capability map. A landing page returns workspaceAvailable=false and a stop instruction; never browse or scroll it. ${FLOW_TOOL_GUARD}`,
    inputSchema: { accountId: connectedAccountId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ accountId: id }) => {
    try {
      return ok(await flow.inspect(id));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_generate_video",
  {
    title: "Generate and Download a Google Flow Video",
    description: `THE REQUIRED AND EXCLUSIVE PATH for every Google Flow video request. Submits one persistent job, waits briefly, and returns. If status=processing, poll flow_job_status with the SAME job ID; never generate again. It optionally upscales and downloads locally. Never open or control Flow with browser/computer-use tools. Requires explicit credit authorization.`,
    inputSchema: {
      accountId: connectedAccountId,
      prompt: z.string().min(3).max(20_000).describe("Video prompt in any language, describing subject, action, setting, camera, lighting, style, and audio as desired."),
      flowProject: z.string().max(200).optional().describe("Existing Flow project name to open. If omitted, the current project is reused or a new project is created."),
      model: z.string().default("ui-default").describe("Normalized video model ID returned by flow_inspect_account, e.g. omni-flash, veo-3-1-lite, veo-3-1-fast, or veo-3-1-quality. Exact visible labels are also accepted. Use ui-default to keep the selected model."),
      aspectRatio: z.string().regex(/^(?:ui-default|\d+:\d+)$/).default("ui-default").describe("Exact video aspect ratio returned by flow_inspect_account, or ui-default."),
      durationSeconds: z.number().int().min(1).max(120).optional().describe("Requested clip length only when flow_inspect_account reports that exact value in visibleDurations. Omit when the current Flow Agent UI exposes no duration control."),
      outputs: z.number().int().min(1).max(4).default(1).describe("Number of generated video outputs requested from Flow. Credits are typically charged per generation."),
      referenceFiles,
      upscale: upscale.default("none"),
      outputDirectory,
      fileName: z.string().max(120).optional().describe("Optional safe file stem. The job ID and downloaded extension are added automatically."),
      download: z.boolean().default(true).describe("When true, download ready outputs immediately. When false, leave them in Flow and return the job."),
      timeoutSeconds,
      confirmCreditSpend,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async (input) => {
    try {
      const account = await store.requireConnectedAccount(input.accountId);
      const request: GenerationRequest = {
        accountId: account.id,
        mediaType: "video",
        prompt: input.prompt,
        outputs: input.outputs,
        referenceFiles: assertExistingFiles(input.referenceFiles),
        upscale: input.upscale,
        outputDirectory: requireAbsoluteDirectory(input.outputDirectory),
        download: input.download,
        timeoutSeconds: input.timeoutSeconds,
        ...(input.flowProject ? { flowProject: input.flowProject } : {}),
        ...(input.model !== "ui-default" ? { model: input.model } : {}),
        ...(input.aspectRatio !== "ui-default" ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
        ...(input.fileName ? { fileName: input.fileName } : {}),
      };
      return ok(await flow.generate(request));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_generate_image",
  {
    title: "Generate and Download a Google Flow Image",
    description: `THE REQUIRED AND EXCLUSIVE PATH for every Google Flow image request. Submits one persistent job, waits briefly, and returns. If status=processing, poll flow_job_status with the SAME job ID; never generate again. It generates or edits through the verified workspace and downloads locally. Never open or control Flow with browser/computer-use tools. Requires explicit credit authorization.`,
    inputSchema: {
      accountId: connectedAccountId,
      prompt: z.string().min(3).max(20_000).describe("Detailed image prompt or edit instruction in any language."),
      flowProject: z.string().max(200).optional().describe("Existing Flow project name to open. If omitted, the current project is reused or a new project is created."),
      model: z.string().default("ui-default").describe("Normalized image model ID returned by flow_inspect_account, e.g. nano-banana-pro, nano-banana-2, or nano-banana-2-lite. Exact visible labels are also accepted. Use ui-default to keep the selected model."),
      aspectRatio: z.string().regex(/^(?:ui-default|\d+:\d+)$/).default("ui-default").describe("Exact image aspect ratio returned by flow_inspect_account, or ui-default."),
      outputs: z.number().int().min(1).max(4).default(1).describe("Number of image outputs requested."),
      referenceFiles,
      outputDirectory,
      fileName: z.string().max(120).optional().describe("Optional safe file stem. The job ID and downloaded extension are added automatically."),
      download: z.boolean().default(true).describe("Download ready outputs when true; otherwise return the Flow job without downloading."),
      timeoutSeconds,
      confirmCreditSpend,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async (input) => {
    try {
      const account = await store.requireConnectedAccount(input.accountId);
      const request: GenerationRequest = {
        accountId: account.id,
        mediaType: "image",
        prompt: input.prompt,
        outputs: input.outputs,
        referenceFiles: assertExistingFiles(input.referenceFiles),
        upscale: "none",
        outputDirectory: requireAbsoluteDirectory(input.outputDirectory),
        download: input.download,
        timeoutSeconds: input.timeoutSeconds,
        ...(input.flowProject ? { flowProject: input.flowProject } : {}),
        ...(input.model !== "ui-default" ? { model: input.model } : {}),
        ...(input.aspectRatio !== "ui-default" ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.fileName ? { fileName: input.fileName } : {}),
      };
      return ok(await flow.generate(request));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_job_status",
  {
    title: "Check a Google Flow Job",
    description: `The exclusive status path for jobs returned by a Flow generation tool. Poll the SAME job ID until completed or failed; never resubmit generation. It safely finalizes any download already authorized by the original request. Never inspect Flow with generic browser/computer-use tools.`,
    inputSchema: {
      jobId: z.string().uuid().describe("UUID returned by flow_generate_video or flow_generate_image."),
      waitSeconds: z.number().int().min(0).max(60).default(10).describe("Seconds to poll before returning; use 0 for an immediate snapshot."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ jobId, waitSeconds }) => {
    try {
      return ok(waitSeconds === 0 ? await store.getJob(jobId) : await flow.refreshJob(jobId, waitSeconds));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_upscale_video",
  {
    title: "Upscale an Existing Google Flow Video Job",
    description: `The exclusive path for real Flow video upscaling. Uses live available options and rejects unavailable/upgrade-only choices. Never right-click or control Flow with generic browser/computer-use tools. May consume credits and requires explicit authorization.`,
    inputSchema: {
      jobId: z.string().uuid().describe("UUID of an existing video generation job."),
      factor: z.string().min(2).max(80).refine((value) => value !== "none", "Use a live upscale ID or highest_available, not none.").describe("Exact available upscale ID returned by flow_inspect_account, such as 1080p or 2x, or highest_available. Missing/unavailable options fail explicitly."),
      timeoutSeconds,
      confirmCreditSpend,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ jobId, factor, timeoutSeconds: timeout }) => {
    try {
      return ok(await flow.upscaleJob(jobId, factor, timeout));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_download_job",
  {
    title: "Download an Existing Google Flow Job",
    description: `The exclusive path to download an existing Flow job. Uses the exact asset identities recorded for that job and fails instead of guessing from gallery order. Never download through generic browser/computer-use tools. Saves to the configured absolute directory, validates files, writes manifests, and does not start a generation.`,
    inputSchema: { jobId: z.string().uuid().describe("Exact UUID returned by the video or image generation whose asset must be downloaded. Never substitute a different or guessed job ID.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ jobId }) => {
    try {
      return ok(await flow.downloadJob(jobId));
    } catch (error) {
      return failed(error);
    }
  },
);

const shutdown = async (): Promise<void> => {
  await browsers.closeAll();
  await cookieBridge.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[flow-mcp] ready; data directory: ${store.dataDir}`);
