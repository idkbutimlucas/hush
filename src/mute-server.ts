import { DiscordMuter } from './types';
import { dbg } from './debug';
import {
  DuplexSocket, ServerListener, encode, decode, PROTOCOL_VERSION,
} from './mute-protocol';

// Host-side relay: accepts controller connections over the LAN and drives the
// local Discord mute. Only the DiscordMuter interface is used, so the concrete
// RPC muter is injected (and faked in tests). A connection must present the
// right pairing code before any mute is honored.
export class MuteServer {
  private authed = new Set<DuplexSocket>();
  private holdingMute = new Set<DuplexSocket>(); // authed conns currently muting

  constructor(
    private readonly muter: DiscordMuter,
    private readonly listener: ServerListener,
    private readonly code: string,
  ) {}

  start(port: number): void {
    this.listener.onConnection((sock) => this.onConnection(sock));
    this.listener.listen(port);
    dbg('mute-server: listening', { port });
  }

  stop(): void {
    try { this.listener.close(); } catch { /* noop */ }
    this.authed.clear();
    this.holdingMute.clear();
  }

  private onConnection(sock: DuplexSocket): void {
    sock.onMessage((raw) => {
      let msg;
      try { msg = decode(raw); } catch { return; }

      if (msg.t === 'hello') {
        if (msg.v !== PROTOCOL_VERSION) {
          sock.send(encode({ t: 'reject', reason: 'incompatible version' }));
          sock.close();
          return;
        }
        if (msg.code !== this.code) {
          sock.send(encode({ t: 'reject', reason: 'bad pairing code' }));
          sock.close();
          return;
        }
        this.authed.add(sock);
        sock.send(encode({ t: 'welcome', v: PROTOCOL_VERSION }));
        dbg('mute-server: controller authorized');
        return;
      }

      if (!this.authed.has(sock)) return; // ignore anything before hello

      if (msg.t === 'mute') {
        this.applyMute(sock, msg.on);
      } else if (msg.t === 'ping') {
        sock.send(encode({ t: 'pong' }));
      }
    });

    sock.onClose(() => {
      this.authed.delete(sock);
      // Fail-safe: a muted controller vanished — drop its hold and unmute if it
      // was the last one holding the mute, so Discord is never stuck muted.
      if (this.holdingMute.has(sock)) this.applyMute(sock, false);
    });
  }

  private applyMute(sock: DuplexSocket, on: boolean): void {
    const before = this.holdingMute.size;
    if (on) this.holdingMute.add(sock);
    else this.holdingMute.delete(sock);
    const after = this.holdingMute.size;
    // Only touch Discord on a real edge: first holder mutes, last release unmutes.
    if (before === 0 && after > 0) void this.muter.setMute(true);
    else if (before > 0 && after === 0) void this.muter.setMute(false);
  }
}
