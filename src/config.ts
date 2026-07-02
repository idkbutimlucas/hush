import { HushConfig } from './types';

export const DEFAULT_PORT = 8698;

export const DEFAULT_CONFIG: HushConfig = {
  // Your Wispr Flow push-to-talk shortcut. You press it yourself (Wispr dictates
  // natively); Hush only watches for it and mutes Discord while it's held. ⌃⌥ is
  // Wispr's documented push-to-talk default for external keyboards — set the SAME
  // combo here and in Wispr → Settings → General → Shortcuts.
  shortcut: { mods: ['ctrl', 'alt'], key: '' },
  discordRpc: { clientId: '', clientSecret: '' },
  mode: 'hold',
  unmuteDelayMs: 0,
  role: 'local',
  remote: { host: '', port: DEFAULT_PORT, pairingCode: '' },
  hostListen: { port: DEFAULT_PORT, pairingCode: '' },
};

export function validateConfig(cfg: HushConfig): void {
  // The shortcut must be *something* — at least one modifier or a key. An empty
  // combo would fire constantly (or never) and can't be a real push-to-talk.
  if (cfg.shortcut.mods.length === 0 && !cfg.shortcut.key) {
    throw new Error('Hush config invalid: shortcut must have at least a key or a modifier');
  }
  const portOk = (p: number) => Number.isInteger(p) && p > 0 && p < 65536;
  if (cfg.role === 'controller') {
    if (!cfg.remote.host) {
      throw new Error('Hush config invalid: controller needs a host address');
    }
    if (!portOk(cfg.remote.port)) {
      throw new Error('Hush config invalid: remote port out of range');
    }
  }
  if (cfg.role === 'host') {
    if (!cfg.hostListen.pairingCode) {
      throw new Error('Hush config invalid: host needs a pairing code');
    }
    if (!portOk(cfg.hostListen.port)) {
      throw new Error('Hush config invalid: host port out of range');
    }
  }
}

export function getConfig(): HushConfig {
  validateConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}
