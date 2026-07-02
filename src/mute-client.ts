import { DiscordMuter } from './types';
import { dbg } from './debug';
import {
  ClientSocket, ClientSocketFactory, encode, decode, PROTOCOL_VERSION,
} from './mute-protocol';

export type RemoteState = 'disconnected' | 'connecting' | 'connected';

const RECONNECT_MS = 3000;

// Controller-side muter: instead of a local Discord RPC socket, it forwards the
// orchestrator's mute/unmute to a host over the LAN. Best-effort by design — when
// the host is unreachable, setMute is a logged no-op so dictation still works.
export class RemoteDiscordMuter implements DiscordMuter {
  private sock: ClientSocket | null = null;
  private state: RemoteState = 'disconnected';
  private lastError: string | null = null;
  private desiredMute = false;   // last state the orchestrator asked for
  private wanted = false;        // user wants a connection (until disconnect())
  private host = '';
  private port = 0;
  private code = '';

  constructor(
    private readonly factory: ClientSocketFactory,
    private readonly schedule: (fn: () => void) => void =
      (fn) => { setTimeout(fn, RECONNECT_MS); },
  ) {}

  getState(): RemoteState { return this.state; }
  getError(): string | null { return this.lastError; }
  isConnected(): boolean { return this.state === 'connected'; }

  connect(host: string, port: number, code: string): void {
    this.host = host; this.port = port; this.code = code;
    this.wanted = true;
    this.open();
  }

  private open(): void {
    if (!this.wanted) return;
    this.state = 'connecting';
    this.lastError = null;
    const sock = this.factory(this.host, this.port);
    this.sock = sock;

    sock.onOpen(() => {
      sock.send(encode({ t: 'hello', v: PROTOCOL_VERSION, code: this.code }));
    });
    sock.onMessage((raw) => {
      let msg;
      try { msg = decode(raw); } catch { return; }
      if (msg.t === 'welcome') {
        this.state = 'connected';
        this.lastError = null;
        dbg('remote: connected');
        // Re-assert whatever the orchestrator currently wants (mid-hold reconnect).
        sock.send(encode({ t: 'mute', on: this.desiredMute }));
      } else if (msg.t === 'reject') {
        this.lastError = msg.reason || 'rejected by host';
        dbg('remote: rejected', this.lastError);
        this.wanted = false;         // a bad code won't fix itself — stop retrying
        sock.close();
      } else if (msg.t === 'ping') {
        sock.send(encode({ t: 'pong' }));
      }
    });
    sock.onClose(() => {
      this.sock = null;
      if (this.state === 'connected') dbg('remote: link dropped');
      this.state = 'disconnected';
      if (this.wanted) this.schedule(() => this.open());
    });
  }

  async setMute(on: boolean): Promise<void> {
    this.desiredMute = on;
    if (this.state !== 'connected' || !this.sock) {
      dbg('remote: setMute skipped (not connected)', { on });
      return;
    }
    try {
      this.sock.send(encode({ t: 'mute', on }));
      dbg('remote: setMute', { on });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      dbg('remote: setMute failed', this.lastError);
    }
  }

  disconnect(): void {
    this.wanted = false;
    if (this.sock) { try { this.sock.close(); } catch { /* noop */ } }
    this.sock = null;
    this.state = 'disconnected';
  }
}
