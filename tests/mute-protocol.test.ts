import { describe, it, expect } from 'vitest';
import { encode, decode, PROTOCOL_VERSION, WireMessage } from '../src/mute-protocol';

describe('mute-protocol encode/decode', () => {
  const roundtrip = (m: WireMessage) => decode(encode(m));

  it('round-trips every message type', () => {
    const msgs: WireMessage[] = [
      { t: 'hello', v: PROTOCOL_VERSION, code: 'ABC123' },
      { t: 'welcome', v: PROTOCOL_VERSION },
      { t: 'reject', reason: 'bad code' },
      { t: 'mute', on: true },
      { t: 'mute', on: false },
      { t: 'ping' },
      { t: 'pong' },
    ];
    for (const m of msgs) expect(roundtrip(m)).toEqual(m);
  });

  it('throws on non-JSON input', () => {
    expect(() => decode('not json')).toThrow();
  });

  it('throws on a missing or unknown type tag', () => {
    expect(() => decode(JSON.stringify({ foo: 1 }))).toThrow(/type/);
    expect(() => decode(JSON.stringify({ t: 'bogus' }))).toThrow(/type/);
  });

  it('throws when a mute frame lacks a boolean flag', () => {
    expect(() => decode(JSON.stringify({ t: 'mute' }))).toThrow(/mute/);
  });
});
