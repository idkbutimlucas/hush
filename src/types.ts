export type Mod = 'ctrl' | 'alt' | 'cmd' | 'shift';
export type Combo = { mods: Mod[]; key: string };
// auto: detects the gesture automatically, mirroring Wispr — HOLD = push-to-talk
//   (muted while held); DOUBLE-TAP starts and latches (stays muted after you let
//   go); a single TAP then stops. This is the do-everything default.
// hold: only push-to-talk (muted strictly while held).
// toggle: press flips mute on/off.
export type Mode = 'auto' | 'hold' | 'toggle';

export interface InputEngine {
  start(): void;
  stop(): void;
  onPress(cb: () => void): void;
  onRelease(cb: () => void): void;
}

// Discord muting is done over RPC (SET_VOICE_SETTINGS), not a synthesized
// hotkey — Discord ignores injected keystrokes. The orchestrator only needs
// this narrow contract; the concrete RPC client lives in discord-mute.ts.
export interface DiscordMuter {
  setMute(on: boolean): Promise<void>;
}

// Credentials for the local Discord RPC connection (from the Discord dev portal).
export interface DiscordRpc {
  clientId: string;
  clientSecret: string;
  // Cached OAuth access token. Once you've authorized once, Hush reuses this on
  // later launches so it never pops the Discord "Authorize" prompt again.
  accessToken?: string;
  // OAuth refresh token — renews the access token silently (no re-authorize
  // popup) until the user revokes Hush in Discord → Authorized Apps.
  refreshToken?: string;
  // Epoch ms when the cached access token expires.
  tokenExpiresAt?: number;
}

// Where Discord lives relative to this machine.
//  - 'local'      : Discord runs here — mute it directly over RPC (default).
//  - 'controller' : dictation happens here; mute a Discord on another machine.
//  - 'host'       : Discord runs here; accept mute commands from a controller.
export type Role = 'local' | 'host' | 'controller';

// Controller side: how to reach the host running Discord.
export interface RemoteConfig {
  host: string;      // LAN IP or hostname of the host machine
  port: number;      // host's listening port
  pairingCode: string;
}

// Host side: how this machine listens for a controller.
export interface HostListenConfig {
  port: number;
  pairingCode: string;
}

export interface HushConfig {
  // The push-to-talk shortcut you already use in Wispr Flow. Hush watches for it
  // and mutes Discord while it is held — it never synthesizes the shortcut, you
  // press it yourself (Wispr responds natively).
  shortcut: Combo;
  // Discord is muted over RPC instead of a keystroke, so it needs credentials,
  // not a combo.
  discordRpc: DiscordRpc;
  mode: Mode;
  // Optional delay before unmuting Discord on release (tail padding so the last
  // word of dictation doesn't leak back into the call).
  unmuteDelayMs: number;
  // Cross-machine muting. 'local' keeps the original single-machine behavior.
  role: Role;
  remote: RemoteConfig;
  hostListen: HostListenConfig;
  // Launch Hush automatically when you log in to the machine. Applied via
  // app.setLoginItemSettings; persisted so the choice survives restarts.
  launchAtLogin: boolean;
}
