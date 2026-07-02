import { DiscordMuter } from './types';
import { dbg } from './debug';

// Real-flow Discord muting over the local RPC/IPC socket — the approach that
// actually works, unlike synthesizing Discord's mute hotkey (Discord ignores
// session-level CGEvents). Talks to Discord via `SET_VOICE_SETTINGS { mute }`.
//
// Best-effort by design: if Discord is closed or the RPC never connected,
// setMute is a logged no-op so nothing breaks.

interface LoginOptions {
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  redirectUri?: string;
  accessToken?: string;
}

interface RpcClient {
  login(options: LoginOptions): Promise<unknown>;
  setVoiceSettings(settings: { mute?: boolean; deaf?: boolean }): Promise<unknown>;
  getVoiceSettings(): Promise<{ mute?: boolean; deaf?: boolean }>;
  destroy(): Promise<void>;
  on(event: string, cb: (...args: unknown[]) => void): void;
  accessToken?: string;
}

interface RpcModule {
  Client: new (opts: { transport: 'ipc' }) => RpcClient;
}

export type RpcState = 'disconnected' | 'connecting' | 'connected';

const SCOPES = ['rpc', 'rpc.voice.write'];
const REDIRECT = 'http://localhost';
const CONNECT_TIMEOUT_MS = 8000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export class DiscordRpcMuter implements DiscordMuter {
  private client: RpcClient | null = null;
  private state: RpcState = 'disconnected';
  private lastError: string | null = null;
  private accessToken: string | null = null;

  // discord-rpc ships no bundled types and pulls a native transport; require it
  // lazily so the app still boots if the dependency is somehow missing.
  private load(): RpcModule {
    return require('discord-rpc') as RpcModule;
  }

  getState(): RpcState {
    return this.state;
  }

  getError(): string | null {
    return this.lastError;
  }

  // The OAuth token obtained (or reused) on the last successful connect. Persist
  // this so the next launch reconnects silently — no Discord authorize prompt.
  getAccessToken(): string | null {
    return this.accessToken;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  // Try to bring a fresh client up with the given login options. Returns the
  // connected client on success, or throws.
  private async open(options: LoginOptions): Promise<RpcClient> {
    const RPC = this.load();
    const client = new RPC.Client({ transport: 'ipc' });
    await withTimeout(client.login(options), CONNECT_TIMEOUT_MS, 'rpc login');
    return client;
  }

  // Connect (or reconnect). Never throws — failures are captured in state/error
  // so the caller can surface them without breaking anything. If `accessToken` is
  // given it's tried first (silent, no prompt); otherwise (or on failure) the full
  // OAuth authorize runs, which pops Discord's approval the first time only.
  async connect(clientId: string, clientSecret: string, accessToken?: string): Promise<boolean> {
    if (!clientId || !clientSecret) {
      this.state = 'disconnected';
      this.lastError = 'client_id / client_secret manquants';
      return false;
    }
    this.state = 'connecting';
    this.lastError = null;
    await this.disconnect();

    // 1) Silent path: reuse a cached token (no authorize popup).
    if (accessToken) {
      try {
        const client = await this.open({ clientId, accessToken });
        this.client = client;
        this.accessToken = accessToken;
        this.state = 'connected';
        dbg('rpc: connected (cached token)');
        return true;
      } catch (err) {
        dbg('rpc: cached-token login failed, falling back to authorize',
          err instanceof Error ? err.message : String(err));
      }
    }

    // 2) Full OAuth authorize (prompts the first time / when the token expired).
    try {
      const client = await this.open({ clientId, clientSecret, scopes: SCOPES, redirectUri: REDIRECT });
      this.client = client;
      this.accessToken = client.accessToken ?? null;
      this.state = 'connected';
      dbg('rpc: connected (authorized)');
      return true;
    } catch (err) {
      this.client = null;
      this.state = 'disconnected';
      this.lastError = err instanceof Error ? err.message : String(err);
      dbg('rpc: connect failed', this.lastError);
      return false;
    }
  }

  async setMute(on: boolean): Promise<void> {
    if (!this.client || this.state !== 'connected') {
      dbg('rpc: setMute skipped (not connected)', { on });
      return;
    }
    try {
      await this.client.setVoiceSettings({ mute: on });
      dbg('rpc: setMute', { on });
    } catch (err) {
      // A dropped socket (Discord quit mid-session) lands here — degrade to
      // disconnected so the next launch/attempt reconnects instead of throwing.
      this.state = 'disconnected';
      this.lastError = err instanceof Error ? err.message : String(err);
      dbg('rpc: setMute failed', this.lastError);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try { await this.client.destroy(); } catch { /* noop */ }
    }
    this.client = null;
    if (this.state === 'connected') this.state = 'disconnected';
  }
}
