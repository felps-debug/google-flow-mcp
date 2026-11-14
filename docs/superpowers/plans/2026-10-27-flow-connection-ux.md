# Google Flow MCP Connection UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar conexão, reconexão, seleção e diagnóstico das contas do Google Flow previsíveis e operáveis sem iniciar uma geração.

**Architecture:** Persistir pedidos de conexão no `FlowStore`; usar o `CookieBridge` como transporte de sessão associado a um pedido persistente; adicionar operações explícitas de conta e saúde no MCP; atualizar a extensão para exibir alvo, prazo e resultado. O navegador gerenciado continua isolado por conta e a extensão continua exigindo ação explícita do usuário.

**Tech Stack:** TypeScript, Node.js `node:test`, MCP stdio SDK, Playwright, extensão Chrome Manifest V3.

**Spec:** `docs/superpowers/specs/2026-10-27-flow-connection-ux.md`

## Global Constraints

- Preservar as alterações existentes e não resetar nem sobrescrever o working tree.
- Não commitar nem fazer push sem pedido explícito.
- Não automatizar CAPTCHA, login protegido ou contornar políticas do Google.
- Não transmitir cookies para fora do localhost; manter validação de origem e domínios Google.
- Não operar o Flow com browser/computer-use fora do `FlowAdapter`.
- Toda mudança de comportamento de produção começa com teste falhando e termina com a suíte completa verde.

## Review Focus

- Reiniciar o processo MCP durante uma conexão não deve transformar um pedido válido em token perdido; teste de persistência/expiração.
- Dois pedidos ou dois processos não devem consumir a mesma sessão; teste de associação e idempotência.
- Reconectar uma conta existente não deve criar uma nova conta; teste de preservação de ID/rótulo.
- Uma conta com navegador morto, sessão expirada ou Flow sem workspace deve aparecer com causa distinta; testes de diagnóstico.
- Alternar a conta padrão não deve alterar nem apagar outras contas; teste de seleção e fallback.

### Task 1: Modelo persistente de conexão

**Files:**
- Modify: `src/types.ts`
- Modify: `src/store.ts`
- Modify: `src/errors.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Produces `ConnectionRequestRecord` com `id`, `accountId?`, `label?`, `status`, `createdAt`, `expiresAt`, `updatedAt`, `lastError?`, `sessionReceivedAt?`.
- Produces `FlowStore.createConnectionRequest`, `getConnectionRequest`, `updateConnectionRequest`, `expireConnectionRequest`, `setDefaultAccount`.
- Statuses: `awaiting_extension`, `session_received`, `verifying`, `completed`, `expired`, `failed`.

- [ ] **Step 1: Write the failing tests** para criação, atualização atômica, expiração e preservação de conta existente.
- [ ] **Step 2: Run `npm test -- --test-name-pattern="connection request|default account"` and confirm failure** because the store interface does not exist.
- [ ] **Step 3: Implement the persistent connection record** em `FlowStore`, usando arquivo atômico no diretório de dados e prazo verificado na leitura.
- [ ] **Step 4: Run the focused tests and confirm pass.**
- [ ] **Step 5: Run `npm test` and confirm no regression.**

### Task 2: Bridge associado a pedido e reconexão idempotente

**Files:**
- Modify: `src/cookie-bridge.ts`
- Modify: `src/flow-adapter.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Test: `tests/cookie-bridge.test.ts`
- Test: `tests/account-guard.test.ts`

**Interfaces:**
- `CookieBridge.armForSession(request)` retorna estado público do pedido, não um token somente em memória.
- `CookieBridge.status()` inclui `requestId`, `accountId`, `label`, `expiresAt`, `lastSessionReceivedAt` quando presentes.
- `flow_begin_account_connection` retoma ou cria pedido para `accountId` e informa ação única.
- `flow_complete_account_connection` aceita o pedido persistido, é idempotente após uma sessão recebida e preserva o ID existente.

- [ ] **Step 1: Write failing bridge tests** para pedido persistente, sessão associada, sessão duplicada e pedido expirado.
- [ ] **Step 2: Run the focused tests and confirm failure.**
- [ ] **Step 3: Implement bridge/request association** sem remover as validações atuais de origem, payload e domínio.
- [ ] **Step 4: Add failing MCP contract tests** para reconnect de conta existente sem criar novo ID.
- [ ] **Step 5: Implement begin/complete idempotentes** e mensagens que explicam exatamente a ação restante.
- [ ] **Step 6: Run focused tests, then `npm test`.**

### Task 3: Extensão de conexão orientada por estado

**Files:**
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`
- Modify: `extension/popup.css`
- Test: `tests/mcp-smoke.test.ts` or a new `tests/extension-state.test.ts`

**Interfaces:**
- `/status` exposes a stable public payload without cookie values.
- Popup displays target account/label, remaining time and one of: not running, waiting, session sent, expired, error.
- Button text/actions are deterministic: `Connect`, `Send session`, `Retry`.

- [ ] **Step 1: Write the failing state-rendering/contract test.**
- [ ] **Step 2: Run it and confirm failure.**
- [ ] **Step 3: Implement the minimal popup state model and copy.**
- [ ] **Step 4: Verify the popup never displays cookie values and preserves the existing POST contract.**
- [ ] **Step 5: Run `npm test`.**

### Task 4: Explicit account selection

**Files:**
- Modify: `src/index.ts`
- Modify: `src/store.ts`
- Test: `tests/account-guard.test.ts`
- Test: `tests/mcp-smoke.test.ts`

**Interfaces:**
- New read/write MCP tool `flow_set_default_account` accepts an existing connected `accountId` and returns the selected account plus connected alternatives.
- `flow_list_accounts` returns `isDefault`, `lastValidatedAt`, `lastValidationError`, and a concise next action for every account.

- [ ] **Step 1: Write failing MCP tests** for selecting a connected account, rejecting unknown/unconnected IDs, and retaining other records.
- [ ] **Step 2: Run focused tests and confirm failure.**
- [ ] **Step 3: Implement store selection and MCP tool.**
- [ ] **Step 4: Run focused tests and the complete suite.**

### Task 5: Health checks and failure diagnosis

**Files:**
- Modify: `src/flow-adapter.ts`
- Modify: `src/browser-manager.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Test: `tests/account-guard.test.ts`
- Test: `tests/mcp-smoke.test.ts`

**Interfaces:**
- New read-only MCP tool `flow_check_account` accepts optional `accountId` and returns `browser`, `session`, `signedIn`, `workspaceAvailable`, `pageKind`, `url`, `lastError`, `checkedAt`, and `nextAction`.
- New read-only MCP tool `flow_check_all_accounts` checks configured accounts sequentially with bounded timeouts and returns per-account results without spending credits.
- Health failures update `connectionStatus` with the existing distinct statuses or a new explicit status only if tests require it.

- [ ] **Step 1: Write failing tests** for signed out, Flow landing page, browser unavailable, healthy workspace and multi-account summary.
- [ ] **Step 2: Run focused tests and confirm failure.**
- [ ] **Step 3: Implement health result types and bounded browser/access probes.**
- [ ] **Step 4: Update account records only after a completed probe, preserving the last diagnostic error.**
- [ ] **Step 5: Expose both tools with read-only MCP annotations and actionable next actions.**
- [ ] **Step 6: Run the complete suite and typecheck.**

## Verification

- Run `npm test` from `C:\Users\Felps\code\google-flow-mcp`.
- Run `npm run typecheck`.
- Inspect `git diff --stat` and ensure only the planned files changed; keep existing uncommitted selector changes intact.
- Do not claim a live Flow account was reconnected without an explicit end-to-end test using the user's chosen account.
