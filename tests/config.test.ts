import { describe, it, expect } from 'vitest';
import { getConfig, DEFAULT_CONFIG, validateConfig } from '../src/config';

describe('getConfig', () => {
  it('defaults to a non-empty push-to-talk shortcut', () => {
    const cfg = getConfig();
    expect(cfg.shortcut.mods.length > 0 || cfg.shortcut.key).toBeTruthy();
  });
  it('defaults to hold mode with no unmute delay and empty RPC credentials', () => {
    expect(DEFAULT_CONFIG.mode).toBe('hold');
    expect(DEFAULT_CONFIG.unmuteDelayMs).toBe(0);
    expect(DEFAULT_CONFIG.discordRpc).toEqual({ clientId: '', clientSecret: '' });
  });
});

describe('validateConfig', () => {
  it('accepts a modifier-only shortcut (e.g. ⌃⌥)', () => {
    expect(() => validateConfig({
      ...DEFAULT_CONFIG,
      shortcut: { mods: ['ctrl', 'alt'], key: '' },
    })).not.toThrow();
  });
  it('accepts a key + modifier shortcut (e.g. ⌘2)', () => {
    expect(() => validateConfig({
      ...DEFAULT_CONFIG,
      shortcut: { mods: ['cmd'], key: '2' },
    })).not.toThrow();
  });
  it('throws when the shortcut is empty (no key and no modifier)', () => {
    expect(() => validateConfig({
      ...DEFAULT_CONFIG,
      shortcut: { mods: [], key: '' },
    })).toThrow(/shortcut must have/);
  });
  it('accepts a discordRpc with refreshToken + tokenExpiresAt', () => {
    expect(() => validateConfig({
      ...DEFAULT_CONFIG,
      discordRpc: {
        clientId: 'cid',
        clientSecret: 'sec',
        refreshToken: 'refresh-abc',
        tokenExpiresAt: 1234567890,
      },
    })).not.toThrow();
  });
  it('leaves discordRpc defaults unchanged (no refresh-token fields by default)', () => {
    expect(DEFAULT_CONFIG.discordRpc).toEqual({ clientId: '', clientSecret: '' });
  });
});
