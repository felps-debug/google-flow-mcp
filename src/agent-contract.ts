export const FLOW_AGENT_INSTRUCTIONS = `Google Flow operations must use this MCP server's flow_* tools exclusively.

Mandatory workflow, regardless of the user's language:
1. Call flow_connect first. If it returns status=connected, the account is ready: go to step 3 and do not ask the user to connect anything.
2. If flow_connect returns status=awaiting_user, tell the user the steps in userMessage right now, in their language, then IMMEDIATELY call flow_connect again: that call waits for the user. Do not wait for the user to reply and never ask them to say "connected". The only things the user does are click Connect Flow in the Flow Login Bridge extension of their normal Chromium and click the Google account they want in the window that opens. Repeat flow_connect until it returns connected or failed. On failed, report the error and stop.
3. Call flow_inspect_account before generation and use only options it reports as available.
4. Call flow_generate_video or flow_generate_image for generation. Preserve the returned job ID and use that exact ID with flow_job_status, flow_upscale_video, and flow_download_job for follow-up work. Never guess from gallery order or substitute a different job.

Generation tools return after a short bounded wait. If a returned job has status=processing, the generation is already submitted: call flow_job_status repeatedly with that same job ID until it completes or reports an error. NEVER call a generation tool again for the same request merely because Flow queued the result or the first call returned processing.

A direct user request to make, create, or generate media is explicit authorization for that requested generation, so set confirmCreditSpend=true. When the user asks what the MCP can do or how to use it, call flow_help and answer in the user's language with concrete example requests. Translate the user's intent from any language, but pass normalized model, aspect-ratio, duration, output-count, and upscale IDs exactly as flow_inspect_account reports them.

The MCP configures Flow's isolated Agent profile to AUTO_APPROVE (the language-independent value behind “Never ask before generating”) and verifies that setting before submission. Never try to click Flow's approval choices yourself and never tell the user to approve a generation in the hidden managed browser. If Flow unexpectedly still presents an approval, the MCP selects the persistent “approve and do not ask again” action itself.

Never open, navigate, scroll, click, or automate labs.google/fx/tools/flow using generic browser, computer-use, keyboard, mouse, Playwright, or web tools. The MCP owns all Flow browser interaction. A public/marketing Flow page is not a generation workspace. If a flow_* tool reports login_required or flow_access_unavailable, stop and report that exact error or call flow_connect again; never compensate with browser automation. If a tool reports job_asset_identity_missing or generated_asset_not_found, report it and do not guess or download another asset. Never claim a generation started unless flow_generate_video or flow_generate_image returned a Flow job ID.`;

export const FLOW_TOOL_GUARD = "Use this tool for Google Flow; never substitute generic browser/computer-use automation on the Flow website.";

export const FLOW_ACCOUNT_GUIDANCE = "Omit accountId to use the most recently verified connected account. Supply it only when the user explicitly chose a different connected account returned by flow_list_accounts.";
