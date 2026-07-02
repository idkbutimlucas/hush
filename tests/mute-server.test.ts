import { describe, it, expect, vi } from 'vitest';
import { MuteServer } from '../src/mute-server';
import { DiscordMuter } from '../src/types';
import {
  DuplexSocket, ServerListener, encode, decode, PROTOCOL_VERSION,
} from '../src/mute-protocol';

class FakeConn implements DuplexSocket {
  sent: string[] = [];
  closed = false;
  private msgCb: (d: string) => void = () => {};
  private closeCb: () => void = () => {};
  send(d: string) { this.sent.push(d); }
  close() { this.closed = true; this.closeCb(); }
  onMessage(cb: (d: string) => void) { this.msgCb = cb; }
  onClose(cb: () => void) { this.closeCb = cb; }
  fireMessage(raw: string) { this.msgCb(raw); }
  fireClose() { this.closeCb(); }
  msgs() { return this.sent.map((r) => decode(r)); }
}

class FakeListener implements ServerListener {
  private connCb: (s: DuplexSocket) => void = () => {};
  listened = 0;
  closed = false;
  onConnection(cb: (s: DuplexSocket) => void) { this.connCb = cb; }
  listen(port: number) { this.listened = port; }
  close() { this.closed = true; }
  connect(): FakeConn { const c = new FakeConn(); this.connCb(c); return c; }
}

function setup(code = 'ABC123') {
  const muter: DiscordMuter & { calls: boolean[] } = {
    calls: [],
    setMute: vi.fn(async (on: boolean) => { (muter.calls as boolean[]).push(on); }),
  } as any;
  const listener = new FakeListener();
  const server = new MuteServer(muter, listener, code);
  server.start(8698);
  return { muter, listener, server };
}

describe('MuteServer', () => {
  it('listens on the given port', () => {
    const { listener } = setup();
    expect(listener.listened).toBe(8698);
  });

  it('welcomes a controller with the right code', () => {
    const { listener } = setup();
    const c = listener.connect();
    c.fireMessage(encode({ t: 'hello', v: PROTOCOL_VERSION, code: 'ABC123' }));
    expect(c.msgs()).toContainEqual({ t: 'welcome', v: PROTOCOL_VERSION });
  });

  it('rejects a bad code, closes, and never mutes', () => {
    const { listener, muter } = setup();
    const c = listener.connect();
    c.fireMessage(encode({ t: 'hello', v: PROTOCOL_VERSION, code: 'WRONG' }));
    expect(c.msgs().some((m) => m.t === 'reject')).toBe(true);
    expect(c.closed).toBe(true);
    expect(muter.setMute).not.toHaveBeenCalled();
  });

  it('rejects an incompatible protocol version', () => {
    const { listener } = setup();
    const c = listener.connect();
    c.fireMessage(encode({ t: 'hello', v: 999, code: 'ABC123' }));
    expect(c.msgs().some((m) => m.t === 'reject')).toBe(true);
    expect(c.closed).toBe(true);
  });

  it('relays a mute frame from an authed controller', () => {
    const { listener, muter } = setup();
    const c = listener.connect();
    c.fireMessage(encode({ t: 'hello', v: PROTOCOL_VERSION, code: 'ABC123' }));
    c.fireMessage(encode({ t: 'mute', on: true }));
    expect(muter.setMute).toHaveBeenCalledWith(true);
  });

  it('ignores mute frames before authentication', () => {
    const { listener, muter } = setup();
    const c = listener.connect();
    c.fireMessage(encode({ t: 'mute', on: true }));
    expect(muter.setMute).not.toHaveBeenCalled();
  });

  it('auto-unmutes when a muted controller disconnects (fail-safe)', () => {
    const { listener, muter } = setup();
    const c = listener.connect();
    c.fireMessage(encode({ t: 'hello', v: PROTOCOL_VERSION, code: 'ABC123' }));
    c.fireMessage(encode({ t: 'mute', on: true }));
    c.fireClose();
    expect((muter as any).calls).toEqual([true, false]);
  });
});
