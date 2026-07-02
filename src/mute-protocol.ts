// Wire format for the LAN link between a controller (dictation machine) and a
// host (Discord machine). Deliberately tiny and versioned; JSON over WebSocket
// text frames. All network transport lives behind the seam interfaces below so
// the client/server logic can be unit-tested against fakes.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 8698;
export const MDNS_SERVICE_TYPE = 'hush'; // advertised as _hush._tcp

export type WireMessage =
  | { t: 'hello'; v: number; code: string }
  | { t: 'welcome'; v: number }
  | { t: 'reject'; reason: string }
  | { t: 'mute'; on: boolean }
  | { t: 'ping' }
  | { t: 'pong' };

export function encode(msg: WireMessage): string {
  return JSON.stringify(msg);
}

export function decode(raw: string): WireMessage {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  const t = obj.t;
  switch (t) {
    case 'hello':
      return { t, v: Number(obj.v), code: String(obj.code ?? '') };
    case 'welcome':
      return { t, v: Number(obj.v) };
    case 'reject':
      return { t, reason: String(obj.reason ?? '') };
    case 'mute':
      if (typeof obj.on !== 'boolean') throw new Error('mute frame missing boolean flag');
      return { t, on: obj.on };
    case 'ping':
      return { t };
    case 'pong':
      return { t };
    default:
      throw new Error(`unknown message type: ${String(t)}`);
  }
}

// ---- Transport seam ---------------------------------------------------------
// One live connection, from either side's point of view.
export interface DuplexSocket {
  send(data: string): void;
  close(): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
}

// A controller dials out and learns when the connection opens.
export interface ClientSocket extends DuplexSocket {
  onOpen(cb: () => void): void;
}
export type ClientSocketFactory = (host: string, port: number) => ClientSocket;

// A host accepts inbound connections.
export interface ServerListener {
  onConnection(cb: (sock: DuplexSocket) => void): void;
  listen(port: number): void;
  close(): void;
}
