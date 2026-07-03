export type Mod = 'ctrl' | 'alt' | 'cmd' | 'shift';
export type Combo = { mods: Mod[]; key: string };
export type Mode = 'hold' | 'toggle';

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
}
