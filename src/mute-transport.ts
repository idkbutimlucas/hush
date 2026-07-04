import WebSocket, { WebSocketServer } from 'ws';
import { ClientSocket, ClientSocketFactory, DuplexSocket, ServerListener, HEARTBEAT_MS } from './mute-protocol';
import { dbg } from './debug';

// ---- Controller side: dial out to a host --------------------------------
export const wsClientFactory: ClientSocketFactory = (host, port): ClientSocket => {
  const ws = new WebSocket(`ws://${host}:${port}`);
  return {
    send: (data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); },
    close: () => { try { ws.close(); } catch { /* noop */ } },
    onOpen: (cb) => ws.on('open', cb),
    onMessage: (cb) => ws.on('message', (d) => cb(d.toString())),
    onClose: (cb) => { ws.on('close', cb); ws.on('error', () => { /* close follows */ }); },
  };
};

// ---- Host side: accept controllers --------------------------------------
export class WsServerListener implements ServerListener {
  private wss: WebSocketServer | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private connCb: (s: DuplexSocket) => void = () => {};

  onConnection(cb: (s: DuplexSocket) => void): void { this.connCb = cb; }

  listen(port: number): void {
    // Bind on all interfaces; the LAN firewall/router blocks WAN. Pairing code
    // still gates every connection.
    const wss = new WebSocketServer({ port });
    this.wss = wss;
    wss.on('error', (err) => dbg('ws-server: error', err.message));

    // Liveness: a client that drops off the network never sends FIN, so ping and
    // terminate the ones that miss a pong — that terminate fires 'close', which
    // is what triggers the MuteServer auto-unmute fail-safe.
    const alive = new WeakMap<WebSocket, boolean>();
    wss.on('connection', (ws) => {
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      ws.on('error', (err) => dbg('ws-server: socket error', err.message));
      this.connCb({
        send: (data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); },
        close: () => { try { ws.close(); } catch { /* noop */ } },
        onMessage: (cb) => ws.on('message', (d) => cb(d.toString())),
        onClose: (cb) => ws.on('close', cb),
      });
    });
    this.heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (alive.get(ws) === false) { ws.terminate(); continue; }
        alive.set(ws, false);
        try { ws.ping(); } catch { /* noop */ }
      }
    }, HEARTBEAT_MS);
  }

  close(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.wss) {
      for (const ws of this.wss.clients) { try { ws.terminate(); } catch { /* noop */ } }
      try { this.wss.close(); } catch { /* noop */ }
      this.wss = null;
    }
  }
}
