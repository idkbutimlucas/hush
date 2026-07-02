import { describe, it, expect, vi } from 'vitest';
import { RemoteDiscordMuter } from '../src/mute-client';
import { ClientSocket, encode, decode, PROTOCOL_VERSION } from '../src/mute-protocol';

// A controllable fake of one outbound connection.
class FakeClientSocket implements ClientSocket {
  sent: string[] = [];
  closed = false;
  private msgCb: (d: string) => void = () => {};
  private openCb: () => void = () => {};
  private closeCb: () => void = () => {};
  send(d: string) { this.sent.push(d); }
  close() { this.closed = true; this.closeCb(); }
  onMessage(cb: (d: string) => void) { this.msgCb = cb; }
  onOpen(cb: () => void) { this.openCb = cb; }
  onClose(cb: () => void) { this.closeCb = cb; }
  // test drivers:
  fireOpen() { this.openCb(); }
  fireMessage(raw: string) { this.msgCb(raw); }
  fireClose() { this.closeCb(); }
  lastMsg() { return this.sent.length ? decode(this.sent[this.sent.length - 1]) : null; }
}

function connected() {
  const sockets: FakeClientSocket[] = [];
  const factory = () => { const s = new FakeClientSocket(); sockets.push(s); return s; };
  const scheduled: Array<() => void> = [];
  const muter = new RemoteDiscordMuter(factory, (fn) => { scheduled.push(fn); });
  muter.connect('192.168.1.20', 8698, 'ABC123');
  const s = sockets[0];
  s.fireOpen();                                   // controller sends hello
  s.fireMessage(encode({ t: 'welcome', v: PROTOCOL_VERSION }));
  return { muter, sockets, scheduled, factory };
}

describe('RemoteDiscordMuter', () => {
  it('sends hello with the pairing code on open', () => {
    const { sockets } = connected();
    expect(sockets[0].sent.map((r) => decode(r))[0])
      .toEqual({ t: 'hello', v: PROTOCOL_VERSION, code: 'ABC123' });
  });

  it('becomes connected after welcome', () => {
    const { muter } = connected();
    expect(muter.isConnected()).toBe(true);
    expect(muter.getState()).toBe('connected');
  });

  it('sends a mute frame when connected', async () => {
    const { muter, sockets } = connected();
    await muter.setMute(true);
    expect(sockets[0].lastMsg()).toEqual({ t: 'mute', on: true });
    await muter.setMute(false);
    expect(sockets[0].lastMsg()).toEqual({ t: 'mute', on: false });
  });

  it('is a silent no-op when not connected (dictation must still proceed)', async () => {
    const factory = () => new FakeClientSocket();
    const muter = new RemoteDiscordMuter(factory, () => {});
    await expect(muter.setMute(true)).resolves.toBeUndefined();
    expect(muter.isConnected()).toBe(false);
  });

  it('records error and disconnects on reject', () => {
    const sockets: FakeClientSocket[] = [];
    const muter = new RemoteDiscordMuter(
      () => { const s = new FakeClientSocket(); sockets.push(s); return s; },
      () => {},
    );
    muter.connect('h', 8698, 'wrong');
    sockets[0].fireOpen();
    sockets[0].fireMessage(encode({ t: 'reject', reason: 'bad code' }));
    expect(muter.isConnected()).toBe(false);
    expect(muter.getError()).toMatch(/bad code/);
  });

  it('re-asserts the desired mute after a reconnect', async () => {
    const { muter, sockets, scheduled } = connected();
    await muter.setMute(true);                // muted, connection #0
    sockets[0].fireClose();                   // link drops → reconnect scheduled
    expect(scheduled.length).toBe(1);
    scheduled[0]();                           // run the reconnect → connection #1
    sockets[1].fireOpen();
    sockets[1].fireMessage(encode({ t: 'welcome', v: PROTOCOL_VERSION }));
    // On reconnect it re-sends the desired mute state.
    expect(sockets[1].sent.map((r) => decode(r)))
      .toContainEqual({ t: 'mute', on: true });
  });

  it('does not reconnect after an explicit disconnect', () => {
    const { muter, sockets, scheduled } = connected();
    muter.disconnect();
    expect(sockets[0].closed).toBe(true);
    expect(scheduled.length).toBe(0);
    expect(muter.isConnected()).toBe(false);
  });
});
