import { describe, it, expect } from 'vitest';
import { setupComplete, shouldShowWindowOnLaunch } from '../src/launch';
import { DEFAULT_CONFIG } from '../src/config';

const local = (over = {}) => ({ ...DEFAULT_CONFIG, role: 'local' as const, ...over });

describe('setupComplete', () => {
  it('false for a fresh local config with no Discord credentials', () => {
    expect(setupComplete(local())).toBe(false);
  });
  it('true once local Discord credentials are set', () => {
    expect(setupComplete(local({ discordRpc: { clientId: 'a', clientSecret: 'b' } }))).toBe(true);
  });
  it('controller is complete once it has a pairing code (address is auto-discovered)', () => {
    const ctrl = { ...DEFAULT_CONFIG, role: 'controller' as const,
      remote: { host: '', port: 8698, pairingCode: 'XYZ' } };
    expect(setupComplete(ctrl)).toBe(true);
  });
  it('controller with no pairing code is incomplete', () => {
    const ctrl = { ...DEFAULT_CONFIG, role: 'controller' as const,
      remote: { host: '', port: 8698, pairingCode: '' } };
    expect(setupComplete(ctrl)).toBe(false);
  });
});

describe('shouldShowWindowOnLaunch', () => {
  const ready = local({ discordRpc: { clientId: 'a', clientSecret: 'b' } });
  it('hides the window when auto-launched at login and setup is complete', () => {
    expect(shouldShowWindowOnLaunch(true, ready)).toBe(false);
  });
  it('shows the window when auto-launched but setup is incomplete', () => {
    expect(shouldShowWindowOnLaunch(true, local())).toBe(true);
  });
  it('always shows the window on a manual launch', () => {
    expect(shouldShowWindowOnLaunch(false, ready)).toBe(true);
  });
});
