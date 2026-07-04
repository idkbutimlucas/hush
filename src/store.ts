import Store from 'electron-store';
import { Combo, HushConfig } from './types';
import { DEFAULT_CONFIG, validateConfig } from './config';

const store = new Store<{ config: HushConfig }>({
  name: 'hush-config',
  defaults: { config: DEFAULT_CONFIG },
});

// Older builds stored a separate `trigger` + `wisprCombo` (Hush used to
// synthesize the Wispr chord). The model is now a single shortcut you press
// yourself, so migrate `trigger` (the key the user physically pressed) into it.
function migrate(raw: Record<string, unknown>): HushConfig {
  const shortcut = (raw.shortcut ?? raw.trigger ?? DEFAULT_CONFIG.shortcut) as Combo;
  // 'handsfree' was the pre-release name for the auto mode.
  const mode = raw.mode === 'handsfree' ? 'auto' : (raw.mode as HushConfig['mode']);
  return {
    shortcut,
    discordRpc: (raw.discordRpc as HushConfig['discordRpc']) ?? DEFAULT_CONFIG.discordRpc,
    mode: mode ?? DEFAULT_CONFIG.mode,
    unmuteDelayMs: (raw.unmuteDelayMs as number) ?? DEFAULT_CONFIG.unmuteDelayMs,
    // New in the cross-machine build. Old configs predate these → default to
    // 'local', preserving the original single-machine behavior exactly.
    role: (raw.role as HushConfig['role']) ?? DEFAULT_CONFIG.role,
    remote: (raw.remote as HushConfig['remote']) ?? DEFAULT_CONFIG.remote,
    hostListen: (raw.hostListen as HushConfig['hostListen']) ?? DEFAULT_CONFIG.hostListen,
    // New: launch-at-login. Old configs predate it → default to true (start
    // with the machine), matching DEFAULT_CONFIG.
    launchAtLogin: (raw.launchAtLogin as boolean) ?? DEFAULT_CONFIG.launchAtLogin,
  };
}

export function loadConfig(): HushConfig {
  const cfg = migrate(store.get('config') as unknown as Record<string, unknown>);
  try {
    validateConfig(cfg);
    return cfg;
  } catch {
    // A field is invalid — reset to defaults but NEVER drop the Discord
    // credentials/token, so an upgrade (or a bad shortcut) can't force the user
    // to reconnect Discord and redo the whole setup.
    const safe: HushConfig = { ...DEFAULT_CONFIG, discordRpc: cfg.discordRpc ?? DEFAULT_CONFIG.discordRpc };
    store.set('config', safe);
    return safe;
  }
}

export function saveConfig(cfg: HushConfig): HushConfig {
  validateConfig(cfg); // throws on an empty shortcut -> surfaced to the renderer
  store.set('config', cfg);
  return cfg;
}
