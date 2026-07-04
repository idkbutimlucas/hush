import { HushConfig } from './types';

// "Setup complete" = enough is configured that the settings window has nothing
// urgent to show. local/host drive a local Discord and need its credentials;
// controller only needs a pairing code — the host address is auto-discovered.
export function setupComplete(cfg: HushConfig): boolean {
  if (cfg.role === 'controller') return Boolean(cfg.remote.pairingCode);
  return Boolean(cfg.discordRpc.clientId && cfg.discordRpc.clientSecret);
}

// Show the settings window on launch UNLESS the app was auto-started at login
// and setup is already complete — then Hush stays quietly in the tray.
export function shouldShowWindowOnLaunch(openedAtLogin: boolean, cfg: HushConfig): boolean {
  return !(openedAtLogin && setupComplete(cfg));
}
