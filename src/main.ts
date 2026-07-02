import { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, shell, systemPreferences } from 'electron';
import * as path from 'path';
import { uIOhook } from 'uiohook-napi';
import { BRAND } from './brand';
import { Combo, HushConfig, Mod } from './types';
import { loadConfig, saveConfig } from './store';
import { comboLabel, normalizeMods } from './combo';
import { dbg, LOG_FILE } from './debug';
import { Orchestrator } from './orchestrator';
import { DiscordRpcMuter } from './discord-mute';
import {
  UiohookInputEngine,
  uiohookModifierOf,
  isUiohookEscape,
  uiohookKeyToKey,
} from './input-engine';

interface MacPermissions {
  getAuthStatus(type: string): string;
  askForInputMonitoringAccess?(): unknown;
  askForAccessibilityAccess?(): unknown;
}
let macPerms: MacPermissions | null = null;
try {
  // Reads the real Input Monitoring status and can open the prompt for it.
  macPerms = require('@nut-tree-fork/node-mac-permissions') as MacPermissions;
} catch {
  macPerms = null;
}

interface RawKeyEvent {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type CaptureResult =
  | { combo: Combo }
  | { combo: null; reason: 'cancelled' | 'unsupported' | 'timeout' | 'busy' };

const ASSETS = path.join(__dirname, '..', 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');

let tray: Tray | null = null;
let win: BrowserWindow | null = null;

// Mutes Discord over RPC (the only approach Discord honors). Shared across
// config reloads; reconnected when credentials change.
const discord = new DiscordRpcMuter();
let orchestrator: Orchestrator | null = null;
let input: UiohookInputEngine | null = null;
let cfg: HushConfig = loadConfig();
let engineReady = false;
let active = false;
let capturing = false;

function trayImage(name: 'trayIdleTemplate' | 'trayActiveTemplate') {
  const img = nativeImage.createFromPath(path.join(ASSETS, `${name}.png`));
  img.setTemplateImage(true);
  return img;
}

function pushStatus() {
  win?.webContents.send('status', {
    active,
    engineReady,
    rpc: discord.getState(),
    rpcError: discord.getError(),
  });
  if (tray) tray.setImage(trayImage(active ? 'trayActiveTemplate' : 'trayIdleTemplate'));
  refreshTrayMenu();
}

function rpcLabel(state: 'disconnected' | 'connecting' | 'connected'): string {
  return state === 'connected' ? 'connecté ✓' : state === 'connecting' ? 'connexion…' : 'non connecté';
}

function refreshTrayMenu() {
  if (!tray) return;
  const status = !engineReady
    ? '⚠︎ Permissions requises'
    : active
      ? '● Micro coupé — dictée en cours'
      : '○ Prêt';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `${BRAND.name} — ${status}`, enabled: false },
      { type: 'separator' },
      { label: `Raccourci : ${comboLabel(cfg.shortcut)}`, enabled: false },
      { label: `Mode : ${cfg.mode === 'hold' ? 'Maintenir' : 'Bascule'}`, enabled: false },
      { label: `Discord : ${rpcLabel(discord.getState())}`, enabled: false },
      { type: 'separator' },
      { label: 'Réglages…', click: showWindow },
      { label: 'Quitter Hush', click: () => app.quit() },
    ]),
  );
}

function applyConfig(next: HushConfig) {
  // Tear down the previous engine without leaving Discord muted.
  void orchestrator?.forceRelease();
  input?.stop();

  cfg = next;
  active = false;
  orchestrator = new Orchestrator(discord, cfg, (isActive) => {
    active = isActive;
    pushStatus();
  });
  input = new UiohookInputEngine(cfg.shortcut);
  input.onPress(() => { if (capturing) return; void orchestrator?.onPress(); });
  input.onRelease(() => { if (capturing) return; void orchestrator?.onRelease(); });

  try {
    input.start();
    engineReady = true;
  } catch {
    engineReady = false;
  }
  dbg('engine start', {
    logFile: LOG_FILE,
    mode: cfg.mode,
    shortcut: comboLabel(cfg.shortcut),
    discordRpc: discord.getState(),
    engineReady,
  });
  pushStatus();
}

let rpcRetryTimer: ReturnType<typeof setTimeout> | null = null;

// (Re)connect the Discord RPC from the current config. Best-effort: failures are
// captured in the muter's state and surfaced via status, never thrown. Reuses a
// cached OAuth token (no authorize popup) and, if Discord isn't running yet,
// retries quietly so it connects on its own once Discord opens.
async function connectDiscord(): Promise<void> {
  if (rpcRetryTimer) { clearTimeout(rpcRetryTimer); rpcRetryTimer = null; }
  const { clientId, clientSecret, accessToken } = cfg.discordRpc;
  if (!clientId || !clientSecret) {
    await discord.disconnect();
    pushStatus();
    return;
  }
  pushStatus(); // reflect 'connecting'
  const ok = await discord.connect(clientId, clientSecret, accessToken);

  // Persist a freshly-obtained token so the next launch reconnects silently.
  const tok = discord.getAccessToken();
  if (ok && tok && tok !== cfg.discordRpc.accessToken) {
    cfg = { ...cfg, discordRpc: { ...cfg.discordRpc, accessToken: tok } };
    try { saveConfig(cfg); } catch { /* noop */ }
  }

  // Discord probably wasn't up yet — retry quietly until it is.
  if (!ok) rpcRetryTimer = setTimeout(() => { void connectDiscord(); }, 15000);
  pushStatus();
}

function showWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 540,
    height: 800,
    resizable: true,
    minWidth: 460,
    minHeight: 680,
    fullscreenable: false,
    title: BRAND.name,
    titleBarStyle: 'hiddenInset',
    backgroundColor: BRAND.colors.bg,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(RENDERER);
  win.once('ready-to-show', () => {
    win?.show();
    pushStatus();
  });
  win.on('closed', () => { win = null; });
}

function authStatus(type: string): string | null {
  try { return macPerms?.getAuthStatus ? macPerms.getAuthStatus(type) : null; } catch { return null; }
}

function permStatus(): { accessibility: boolean; inputMonitoring: boolean } {
  if (process.platform !== 'darwin') return { accessibility: true, inputMonitoring: true };
  let accessibility = false;
  try { accessibility = systemPreferences.isTrustedAccessibilityClient(false); } catch { /* noop */ }
  // Library type id is 'input-monitoring' (hyphen); tolerate the spaced variant too.
  const im = authStatus('input-monitoring') ?? authStatus('input monitoring');
  const inputMonitoring = im !== null ? im === 'authorized' : accessibility;
  return { accessibility, inputMonitoring };
}

// Capture the next shortcut via the same low-level hook used at runtime — so what
// you press is exactly what gets detected (F13 included). Supports:
//  - a key, optionally with modifiers (⌃⌥⌘⇧ + key) → finalized on the key press,
//  - a modifiers-only combo (e.g. ⌃⌥) → finalized when you release the modifiers.
function captureCombo(): Promise<CaptureResult> {
  return new Promise((resolve) => {
    if (capturing) return resolve({ combo: null, reason: 'busy' });
    capturing = true;
    let settled = false;
    const pressed = new Set<Mod>();
    let peak: Mod[] = [];

    const finish = (res: CaptureResult) => {
      if (settled) return;
      settled = true;
      capturing = false;
      uIOhook.off('keydown', onDown);
      uIOhook.off('keyup', onUp);
      resolve(res);
    };

    const onDown = (e: RawKeyEvent) => {
      const mod = uiohookModifierOf(e.keycode);
      if (mod) {
        pressed.add(mod);
        if (pressed.size > peak.length) peak = normalizeMods([...pressed]);
        return; // keep waiting (a key, or release for a modifiers-only combo)
      }
      if (isUiohookEscape(e.keycode)) return finish({ combo: null, reason: 'cancelled' });
      const key = uiohookKeyToKey(e.keycode);
      if (!key) return finish({ combo: null, reason: 'unsupported' });
      finish({ combo: { mods: normalizeMods([...pressed]), key } });
    };

    const onUp = (e: RawKeyEvent) => {
      if (!uiohookModifierOf(e.keycode)) return;
      // A modifier was released before any normal key → it's a modifiers-only combo.
      if (peak.length > 0) finish({ combo: { mods: peak, key: '' } });
    };

    uIOhook.on('keydown', onDown);
    uIOhook.on('keyup', onUp);
    setTimeout(() => finish({ combo: null, reason: 'timeout' }), 8000);
  });
}

function cleanup() {
  void orchestrator?.forceRelease();
  input?.stop();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.hide();

    // Prompt for the two permissions on first launch.
    if (process.platform === 'darwin') {
      const before = permStatus();
      try { systemPreferences.isTrustedAccessibilityClient(true); } catch { /* noop */ }
      // Input Monitoring prompt — only IOHIDRequestAccess triggers the dialog.
      if (!before.inputMonitoring) {
        try { macPerms?.askForInputMonitoringAccess?.(); } catch { /* noop */ }
      }
    }

    tray = new Tray(trayImage('trayIdleTemplate'));
    tray.setToolTip(`${BRAND.name} — ${BRAND.taglineFr}`);
    tray.on('click', showWindow);

    applyConfig(cfg);
    void connectDiscord(); // best-effort auto-connect from stored credentials

    // First run: open the settings window so the user can set things up.
    showWindow();

    // ---- IPC ----
    ipcMain.handle('config:get', () => cfg);
    ipcMain.handle('brand:get', () => ({ name: BRAND.name, tagline: BRAND.taglineFr }));
    ipcMain.handle('config:set', (_e, next: HushConfig) => {
      try {
        const prev = cfg;
        const saved = saveConfig(next);
        applyConfig(saved);
        // Reconnect the RPC only when the credentials actually changed.
        if (
          saved.discordRpc.clientId !== prev.discordRpc.clientId ||
          saved.discordRpc.clientSecret !== prev.discordRpc.clientSecret
        ) {
          void connectDiscord();
        }
        return { ok: true, config: saved };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    ipcMain.handle('perm:status', () => permStatus());
    ipcMain.handle('capture:combo', () => captureCombo());
    ipcMain.on('perm:open-accessibility', () => {
      try { macPerms?.askForAccessibilityAccess?.(); } catch { /* noop */ }
      void shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      );
    });
    ipcMain.on('perm:open-input', () => {
      try { macPerms?.askForInputMonitoringAccess?.(); } catch { /* noop */ }
      void shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
      );
    });
    ipcMain.on('app:quit', () => app.quit());
    ipcMain.on('app:open-external', (_e, url: unknown) => {
      // Only ever open https links the UI points at (e.g. the Discord dev portal).
      if (typeof url === 'string' && /^https:\/\//.test(url)) void shell.openExternal(url);
    });
    // Manual reconnect from the settings window (e.g. after launching Discord).
    ipcMain.handle('rpc:reconnect', async () => {
      await connectDiscord();
      return { state: discord.getState(), error: discord.getError() };
    });
  });

  // Watchdog: never leave Discord muted on quit/crash.
  app.on('before-quit', cleanup);
  process.on('SIGINT', () => { cleanup(); app.quit(); });
  process.on('uncaughtException', () => { cleanup(); });

  // Menu-bar app: stay alive with no windows.
  app.on('window-all-closed', () => { /* keep running in the menu bar */ });
}
