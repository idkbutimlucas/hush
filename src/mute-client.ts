import { DiscordMuter } from './types';
import { dbg } from './debug';
import {
  ClientSocket, ClientSocketFactory, encode, decode, PROTOCOL_VERSION, WireMessage, HEARTBEAT_MS,
} from './mute-protocol';

export type RemoteState = 'disconnected' | 'connecting' | 'connected';

const RECONNECT_MS = 3000;

// Injectable interval timer: call `tick` every HEARTBEAT_MS, returns a cancel fn.
export type Heartbeat = (tick: () => void) => (() => void);

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
  private stopHeartbeat: (() => void) | null = null;
  private awaitingPong = false;   // a ping is out; a second tick without a pong means dead

  constructor(
    private readonly factory: ClientSocketFactory,
    private readonly schedule: (fn: () => void) => void =
      (fn) => { setTimeout(fn, RECONNECT_MS); },
    private readonly heartbeat: Heartbeat =
      (tick) => { const id = setInterval(tick, HEARTBEAT_MS); return () => clearInterval(id); },
  ) {}

  getState(): RemoteState { return this.state; }
  getError(): string | null { return this.lastError; }
  isConnected(): boolean { return this.state === 'connected'; }

  connect(host: string, port: number, code: string): void {
    // Close any prior socket first so a direct re-connect can't orphan a live
    // WebSocket (disconnect() clears `wanted`, which we re-set below).
    if (this.sock) this.disconnect();
    this.host = host; this.port = port; this.code = code;
    this.wanted = true;
    this.open();
  }

  private open(): void {
    // Bail if the user is gone, or a socket already exists: connect() and the
    // onClose reconnect both null this.sock first, so a non-null sock here means
    // a newer attempt already ran (e.g. a resume reconnect raced a scheduled one)
    // — opening again would orphan the live socket.
    if (!this.wanted || this.sock) return;
    this.state = 'connecting';
    this.lastError = null;
    const sock = this.factory(this.host, this.port);
    this.sock = sock;

    sock.onOpen(() => {
      if (this.sock !== sock) return;
      sock.send(encode({ t: 'hello', v: PROTOCOL_VERSION, code: this.code }));
    });
    sock.onMessage((raw) => {
      if (this.sock !== sock) return;
      let msg: WireMessage;
      try { msg = decode(raw); } catch { return; }
      if (msg.t === 'welcome') {
        this.state = 'connected';
        this.lastError = null;
        dbg('remote: connected');
        this.startHeartbeat(sock);
        // Re-assert whatever the orchestrator currently wants (mid-hold reconnect).
        sock.send(encode({ t: 'mute', on: this.desiredMute }));
      } else if (msg.t === 'pong') {
        this.awaitingPong = false;
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
      if (this.sock !== sock) return;
      this.clearHeartbeat();
      this.sock = null;
      if (this.state === 'connected') dbg('remote: link dropped');
      this.state = 'disconnected';
      if (this.wanted) this.schedule(() => this.open());
    });
  }

  // Proactive liveness: the host only learns we're gone when its own ping times
  // out; we do the same the other way so a half-open link after sleep is caught
  // here and torn down, which fires onClose and the reconnect loop.
  private startHeartbeat(sock: ClientSocket): void {
    this.clearHeartbeat();   // also resets awaitingPong
    this.stopHeartbeat = this.heartbeat(() => {
      if (this.sock !== sock) return;            // stale timer from an old socket
      if (this.awaitingPong) { sock.close(); return; } // missed a pong → dead link
      this.awaitingPong = true;
      sock.send(encode({ t: 'ping' }));
    });
  }

  private clearHeartbeat(): void {
    if (this.stopHeartbeat) { this.stopHeartbeat(); this.stopHeartbeat = null; }
    this.awaitingPong = false;
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
    this.clearHeartbeat();
    if (this.sock) { try { this.sock.close(); } catch { /* noop */ } }
    this.sock = null;
    this.state = 'disconnected';
  }
}
