import { DiscordRpc, HushConfig } from './types';

export const DEFAULT_PORT = 8698;

export const DEFAULT_CONFIG: HushConfig = {
  // Your Wispr Flow push-to-talk shortcut. You press it yourself (Wispr dictates
  // natively); Hush only watches for it and mutes Discord while it's held. ⌃⌥ is
  // Wispr's documented push-to-talk default for external keyboards — set the SAME
  // combo here and in Wispr → Settings → General → Shortcuts.
  shortcut: { mods: ['ctrl', 'alt'], key: '' },
  discordRpc: { clientId: '', clientSecret: '' },
  mode: 'auto',
  unmuteDelayMs: 0,
  role: 'local',
  remote: { host: '', port: DEFAULT_PORT, pairingCode: '' },
  hostListen: { port: DEFAULT_PORT, pairingCode: '' },
  // Start with the machine by default — Hush is a set-and-forget menu-bar app,
  // so relaunching it after every reboot is friction the user shouldn't need.
  launchAtLogin: true,
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

// The renderer only ever knows the Discord clientId/secret — it doesn't carry
// the OAuth tokens Hush obtained at runtime. Saving its config verbatim would
// wipe those tokens and force a re-authorize popup on the next launch. Carry the
// existing tokens forward UNLESS the credentials changed (a new Discord app
// invalidates them). If `next` already carries tokens, they win.
export function preserveDiscordTokens(prev: DiscordRpc, next: DiscordRpc): DiscordRpc {
  const sameCreds = prev.clientId === next.clientId && prev.clientSecret === next.clientSecret;
  if (!sameCreds) return { clientId: next.clientId, clientSecret: next.clientSecret };
  return {
    ...next,
    accessToken: next.accessToken ?? prev.accessToken,
    refreshToken: next.refreshToken ?? prev.refreshToken,
    tokenExpiresAt: next.tokenExpiresAt ?? prev.tokenExpiresAt,
  };
}
