import { randomUUID } from "node:crypto";
import { FlowError } from "./errors.js";

export type ConnectionPhase = "awaiting_extension" | "awaiting_account_choice" | "verifying" | "connected" | "failed";

export interface ConnectionState {
  id: string;
  phase: ConnectionPhase;
  accountId?: string;
  label?: string;
  startedAt: string;
  updatedAt: string;
  message: string;
  result?: string;
  error?: { code: string; message: string; suggestions: string[] };
}

export interface ConnectOptions {
  browserMode: "extension";
  chooseGoogleAccount: boolean;
  waitForBridgeSeconds: number;
  waitForAccountSelectionSeconds: number;
  onPhase?: (phase: "awaiting_account_choice" | "verifying") => void;
  manualLogin?: boolean;
}

export interface ConnectionBridge {
  armForSession(timeoutSeconds: number): unknown;
  setProgress(progress: { phase: string; message: string; accountId?: string }): void;
}

export interface ConnectionConnector {
  connectAccount(accountId: string | undefined, label: string | undefined, options: ConnectOptions): Promise<string>;
}

const MESSAGES: Record<ConnectionPhase, string> = {
  awaiting_extension: "Aguardando você clicar em Connect Flow na extensão Flow Login Bridge.",
  awaiting_account_choice: "Escolha a conta do Google na janela que abriu.",
  verifying: "Verificando se a conta tem acesso ao Flow.",
  connected: "Conta conectada.",
  failed: "A conexão falhou.",
};

function isTerminal(phase: ConnectionPhase): boolean {
  return phase === "connected" || phase === "failed";
}

/**
 * Runs one account connection at a time in the background. The agent only
 * starts it and waits; the extension click and the Google account choice are
 * the only user actions, and no "I clicked it" confirmation is required.
 */
export class ConnectionManager {
  private current: { state: ConnectionState; done: Promise<void> } | undefined;

  constructor(
    private readonly connector: ConnectionConnector,
    private readonly bridge: ConnectionBridge,
    private readonly timeoutSeconds = 300,
  ) {}

  get pending(): ConnectionState | undefined {
    return this.current && !isTerminal(this.current.state.phase) ? this.current.state : undefined;
  }

  get latest(): ConnectionState | undefined {
    return this.current?.state;
  }

  start(request: { accountId?: string; label?: string; manualLogin?: boolean }): ConnectionState {
    const pending = this.pending;
    if (pending) {
      if (request.accountId && pending.accountId && request.accountId !== pending.accountId) {
        throw new FlowError(
          "validation_error",
          `A connection for '${pending.accountId}' is already in progress.`,
          ["Finish that connection first, or ask the user to finish or cancel it before connecting another account."],
        );
      }
      return pending;
    }

    const now = new Date().toISOString();
    const state: ConnectionState = {
      id: randomUUID(),
      phase: "awaiting_extension",
      ...(request.accountId ? { accountId: request.accountId } : {}),
      ...(request.label ? { label: request.label } : {}),
      startedAt: now,
      updatedAt: now,
      message: MESSAGES.awaiting_extension,
    };
    if (!request.manualLogin) this.bridge.armForSession(this.timeoutSeconds);
    this.publish(state, request.manualLogin ? "awaiting_account_choice" : "awaiting_extension",
      request.manualLogin ? "Faça login na conta do Google na janela que abriu." : undefined);

    const done = this.connector.connectAccount(request.accountId, request.label, {
      browserMode: "extension",
      chooseGoogleAccount: true,
      waitForBridgeSeconds: this.timeoutSeconds,
      waitForAccountSelectionSeconds: this.timeoutSeconds,
      ...(request.manualLogin ? { manualLogin: true } : {}),
      onPhase: (phase) => {
        if (this.current?.state === state && !isTerminal(state.phase)) this.publish(state, phase);
      },
    }).then((result) => {
      state.result = result;
      this.publish(state, "connected");
    }, (error: unknown) => {
      if (error instanceof FlowError) {
        state.error = { code: error.code, message: error.message, suggestions: error.suggestions };
      } else {
        state.error = {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
          suggestions: [],
        };
      }
      this.publish(state, "failed", state.error.message);
    });

    this.current = { state, done };
    return state;
  }

  /** Resolves when the latest connection finishes or after `seconds`, whichever comes first. */
  async wait(seconds: number): Promise<ConnectionState | undefined> {
    const current = this.current;
    if (!current) return undefined;
    if (isTerminal(current.state.phase) || seconds <= 0) return current.state;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, seconds * 1_000);
    });
    try {
      await Promise.race([current.done, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return current.state;
  }

  private publish(state: ConnectionState, phase: ConnectionPhase, message?: string): void {
    state.phase = phase;
    state.message = message ?? MESSAGES[phase];
    state.updatedAt = new Date().toISOString();
    this.bridge.setProgress({
      phase,
      message: state.message,
      ...(state.accountId ? { accountId: state.accountId } : {}),
    });
  }
}
