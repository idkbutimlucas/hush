import { describe, it, expect } from 'vitest';
import { getConfig, DEFAULT_CONFIG, validateConfig } from '../src/config';

describe('getConfig', () => {
  it('defaults to a non-empty push-to-talk shortcut', () => {
    const cfg = getConfig();
    expect(cfg.shortcut.mods.length > 0 || cfg.shortcut.key).toBeTruthy();
  });
  it('defaults to auto mode with no unmute delay and empty RPC credentials', () => {
    expect(DEFAULT_CONFIG.mode).toBe('auto');
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

describe('role config', () => {
  it('defaults to the local role (no regression for existing users)', () => {
    expect(DEFAULT_CONFIG.role).toBe('local');
  });
  it('defaults remote/host to port 8698 with empty pairing codes', () => {
    expect(DEFAULT_CONFIG.remote).toEqual({ host: '', port: 8698, pairingCode: '' });
    expect(DEFAULT_CONFIG.hostListen).toEqual({ port: 8698, pairingCode: '' });
  });
  it('accepts a controller config with a host address and code', () => {
    expect(() => validateConfig({
      ...DEFAULT_CONFIG,
      role: 'controller',
      remote: { host: '192.168.1.20', port: 8698, pairingCode: 'ABC123' },
    })).not.toThrow();
  });
  it('rejects a controller with no host address', () => {
    expect(() => validateConfig({
      ...DEFAULT_CONFIG,
      role: 'controller',
      remote: { host: '', port: 8698, pairingCode: 'ABC123' },
    })).toThrow(/host address/);
  });
  it('rejects a host with an empty pairing code', () => {
    expect(() => validateConfig({
      ...DEFAULT_CONFIG,
      role: 'host',
      hostListen: { port: 8698, pairingCode: '' },
    })).toThrow(/pairing code/);
  });
  it('rejects an out-of-range port', () => {
    expect(() => validateConfig({
      ...DEFAULT_CONFIG,
      role: 'host',
      hostListen: { port: 70000, pairingCode: 'ABC123' },
    })).toThrow(/port/);
  });
});

describe('launch at login', () => {
  it('defaults to launching Hush at login', () => {
    expect(DEFAULT_CONFIG.launchAtLogin).toBe(true);
  });
  it('accepts launchAtLogin disabled', () => {
    expect(() => validateConfig({ ...DEFAULT_CONFIG, launchAtLogin: false })).not.toThrow();
  });
});
