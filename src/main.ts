import { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, shell, systemPreferences, powerMonitor, MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { uIOhook } from 'uiohook-napi';
import { BRAND } from './brand';
import { Combo, DiscordMuter, HushConfig, InputEngine, Mod } from './types';
import { loadConfig, saveConfig } from './store';
import { comboLabel, normalizeMods, isFnCombo } from './combo';
import { FnInputEngine } from './fn-input';
import { fnAvailable, isFnDown } from './fn-key';
import { dbg, LOG_FILE } from './debug';
import { Orchestrator } from './orchestrator';
import { DiscordRpcMuter } from './discord-mute';
import {
  UiohookInputEngine,
  uiohookModifierOf,
  isUiohookEscape,
  uiohookKeyToKey,
} from './input-engine';
import { RemoteDiscordMuter } from './mute-client';
import { MuteServer } from './mute-server';
import { wsClientFactory, WsServerListener } from './mute-transport';
import { lanAddresses, generatePairingCode } from './net';
import { advertiseHost, browseHosts, DiscoveredHost } from './discovery';
import { appBundlePath, canDragPermissions } from './mac-drag';
import { resolveLocationSwitch } from './location-switch';

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

// The installed Hush.app bundle (for the "drag me into the Privacy list" helper)
// and whether that affordance applies here (macOS + packaged only).
const APP_BUNDLE = appBundlePath(app.getPath('exe'));
const CAN_DRAG_PERMS = canDragPermissions(process.platform, app.isPackaged, APP_BUNDLE);
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');

let tray: Tray | null = null;
let win: BrowserWindow | null = null;

// Mutes Discord over RPC (the only approach Discord honors). Shared across
// config reloads; reconnected when credentials change.
const discord = new DiscordRpcMuter();
// Controller-side muter (role === 'controller'). Talks to a remote host over the LAN.
const remote = new RemoteDiscordMuter(wsClientFactory);
// Host-side relay (role === 'host'). Lazily created in startHost().
let muteServer: MuteServer | null = null;
let stopAdvertise: (() => void) | null = null;
let orchestrator: Orchestrator | null = null;
let input: InputEngine | null = null;
let cfg: HushConfig = loadConfig();
let engineReady = false;
let active = false;
let capturing = false;
// Signature (role|remote-host) refreshAppMenu() last rebuilt for — lets it skip
// rebuilding the macOS app menu on pushStatus() calls where neither changed.
let lastAppMenuSig: string | null = null;

function trayImage(name: 'trayIdleTemplate' | 'trayActiveTemplate') {
  const img = nativeImage.createFromPath(path.join(ASSETS, `${name}.png`));
  img.setTemplateImage(true);
  return img;
}

function pushStatus() {
  win?.webContents.send('status', {
    active,
    engineReady,
    role: cfg.role,
    rpc: discord.getState(),
    rpcError: discord.getError(),
    remote: { state: remote.getState(), error: remote.getError() },
  });
  if (tray) tray.setImage(trayImage(active ? 'trayActiveTemplate' : 'trayIdleTemplate'));
  refreshTrayMenu();
  refreshAppMenu();
}

function rpcLabel(state: 'disconnected' | 'connecting' | 'connected'): string {
  return state === 'connected' ? 'connecté ✓' : state === 'connecting' ? 'connexion…' : 'non connecté';
}

// The two "where is Discord" radio items, shared by the tray menu and the macOS
// app menu so their wording and behaviour can't drift between the two surfaces.
function discordLocationMenuItems(): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Cette machine',
      type: 'radio',
      checked: cfg.role === 'local',
      click: () => switchDiscordLocation('local'),
    },
    {
      label: cfg.remote.host ? `Autre machine — ${cfg.remote.host}` : 'Autre machine…',
      type: 'radio',
      checked: cfg.role === 'controller',
      click: () => switchDiscordLocation('controller'),
    },
  ];
}

// Human label for the mute mode, including upstream's 'auto' (mirror Wispr).
function modeLabel(mode: HushConfig['mode']): string {
  return mode === 'auto' ? 'Auto' : mode === 'hold' ? 'Maintenir' : 'Bascule';
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
      { label: `Mode : ${modeLabel(cfg.mode)}`, enabled: false },
      { label: `Discord : ${rpcLabel(discord.getState())}`, enabled: false },
      { type: 'separator' },
      { label: 'Emplacement de Discord', enabled: false },
      ...discordLocationMenuItems(),
      { type: 'separator' },
      { label: 'Réglages…', click: showWindow },
      { label: 'Quitter Hush', click: () => app.quit() },
    ]),
  );
}

// macOS application menu (the top-of-screen menu bar). Darwin only: elsewhere we
// leave Electron's default. Rebuilt on every status push so the Discord radios
// track cfg.role. The Edit menu's roles are what make ⌘C/⌘V work in the text
// fields — needed to paste the Discord Client ID / Secret.
function refreshAppMenu(): void {
  if (process.platform !== 'darwin') return;
  const sig = `${cfg.role}|${cfg.remote.host}`;
  if (sig === lastAppMenuSig) return;
  lastAppMenuSig = sig;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: BRAND.name,
        submenu: [
          { role: 'about', label: `À propos de ${BRAND.name}` },
          { type: 'separator' },
          { role: 'quit', label: `Quitter ${BRAND.name}` },
        ],
      },
      {
        label: 'Édition',
        submenu: [
          { role: 'undo', label: 'Annuler' },
          { role: 'redo', label: 'Rétablir' },
          { type: 'separator' },
          { role: 'cut', label: 'Couper' },
          { role: 'copy', label: 'Copier' },
          { role: 'paste', label: 'Coller' },
          { role: 'selectAll', label: 'Tout sélectionner' },
        ],
      },
      {
        label: 'Discord',
        submenu: [
          ...discordLocationMenuItems(),
          { type: 'separator' },
          { label: 'Réglages…', click: showWindow },
        ],
      },
    ]),
  );
}

// Reflect the launch-at-login preference into the OS login items. Idempotent —
// safe to call on every launch and on every settings save. openAsHidden keeps
// macOS from flashing a window for this menu-bar app; it's ignored on Windows.
function applyLaunchAtLogin(next: HushConfig): void {
  try {
    app.setLoginItemSettings({ openAtLogin: next.launchAtLogin, openAsHidden: true });
  } catch { /* noop — login-item control is best-effort */ }
}

function applyConfig(next: HushConfig) {
  // Tear down the previous engine without leaving Discord muted.
  void orchestrator?.forceRelease();
  input?.stop();
  input = null;

  cfg = next;
  active = false;

  // The host never runs a shortcut listener — it only relays remote commands.
  if (cfg.role === 'host') {
    orchestrator = null;
    engineReady = true; // nothing to arm; report ready so the UI isn't alarmed
    dbg('engine: host role — no local shortcut listener');
    pushStatus();
    return;
  }

  // local → mute the Discord on this machine; controller → mute the remote host.
  const muter: DiscordMuter = cfg.role === 'controller' ? remote : discord;
  orchestrator = new Orchestrator(muter, cfg, (isActive) => {
    active = isActive;
    pushStatus();
  });
  // Fn is invisible to uiohook — it's polled via CoreGraphics instead.
  input = isFnCombo(cfg.shortcut) ? new FnInputEngine() : new UiohookInputEngine(cfg.shortcut);
  input.onPress(() => { if (capturing) return; void orchestrator?.onPress(); });
  input.onRelease(() => { if (capturing) return; void orchestrator?.onRelease(); });

  try {
    input.start();
    engineReady = true;
  } catch {
    engineReady = false;
  }
  dbg('engine start', {
    logFile: LOG_FILE, mode: cfg.mode, role: cfg.role,
    shortcut: comboLabel(cfg.shortcut), engineReady,
  });
  pushStatus();
}

let rpcRetryTimer: ReturnType<typeof setTimeout> | null = null;
let connectInFlight: Promise<void> | null = null;

// Public entry point: coalesce concurrent callers onto one in-flight attempt so
// two callers can't both spend the (single-use, server-rotated) refresh token.
function connectDiscord(): Promise<void> {
  if (connectInFlight) return connectInFlight;
  connectInFlight = doConnectDiscord().finally(() => { connectInFlight = null; });
  return connectInFlight;
}

// (Re)connect the Discord RPC from the current config. Best-effort: failures are
// captured in the muter's state and surfaced via status, never thrown. Reuses a
// cached OAuth token (no authorize popup) and, if Discord isn't running yet,
// retries quietly so it connects on its own once Discord opens.
async function doConnectDiscord(): Promise<void> {
  if (rpcRetryTimer) { clearTimeout(rpcRetryTimer); rpcRetryTimer = null; }
  const { clientId, clientSecret } = cfg.discordRpc;
  if (!clientId || !clientSecret) {
    await discord.disconnect();
    pushStatus();
    return;
  }
  pushStatus(); // reflect 'connecting'
  const ok = await discord.connect(clientId, clientSecret, {
    accessToken: cfg.discordRpc.accessToken,
    refreshToken: cfg.discordRpc.refreshToken,
    tokenExpiresAt: cfg.discordRpc.tokenExpiresAt,
  });

  // Persist the full token set (access + rotated refresh + expiry) so the next
  // launch — and every silent renewal — reconnects without a re-authorize popup.
  // Do this even when `ok` is false: a refresh may have rotated (and invalidated)
  // the old token before a later step failed, and dropping that rotated token would
  // force a popup on the next attempt.
  const t = discord.getTokens();
  if (t && (
    t.accessToken !== cfg.discordRpc.accessToken ||
    t.refreshToken !== cfg.discordRpc.refreshToken ||
    t.tokenExpiresAt !== cfg.discordRpc.tokenExpiresAt
  )) {
    cfg = { ...cfg, discordRpc: {
      ...cfg.discordRpc,
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      tokenExpiresAt: t.tokenExpiresAt,
    } };
    try { saveConfig(cfg); } catch { /* noop */ }
  }

  // Discord probably wasn't up yet — retry quietly until it is.
  if (!ok) rpcRetryTimer = setTimeout(() => { void connectDiscord(); }, 15000);
  pushStatus();
}

// Host role: connect local Discord RPC, start the LAN relay, advertise via mDNS.
function startHost(): void {
  stopHost();
  muteServer = new MuteServer(discord, new WsServerListener(), cfg.hostListen.pairingCode);
  muteServer.start(cfg.hostListen.port);
  stopAdvertise = advertiseHost(cfg.hostListen.port, `Hush @ ${os.hostname()}`);
  dbg('host: started', { port: cfg.hostListen.port });
}

function stopHost(): void {
  if (muteServer) { muteServer.stop(); muteServer = null; }
  if (stopAdvertise) { stopAdvertise(); stopAdvertise = null; }
}

// Controller role: (re)connect the remote muter from config.
function connectRemote(): void {
  remote.disconnect();
  if (cfg.role !== 'controller' || !cfg.remote.host) return;
  remote.connect(cfg.remote.host, cfg.remote.port, cfg.remote.pairingCode);
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
    let fnTimer: ReturnType<typeof setInterval> | null = null;

    const finish = (res: CaptureResult) => {
      if (settled) return;
      settled = true;
      capturing = false;
      if (fnTimer) clearInterval(fnTimer);
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
    // Fn emits no key event — poll for it so "press your shortcut" catches it too.
    if (fnAvailable()) {
      fnTimer = setInterval(() => {
        if (isFnDown()) finish({ combo: { mods: [], key: 'Fn' } });
      }, 16);
    }
    setTimeout(() => finish({ combo: null, reason: 'timeout' }), 8000);
  });
}

function cleanup() {
  void orchestrator?.forceRelease();
  input?.stop();
  remote.disconnect();
  stopHost();
}

// Bring the app in line with a config that has ALREADY been saved: re-arm the
// input (applyConfig) then set up the cross-machine resources for the new role.
// Shared by the settings window (config:set) and the fast tray/menu switch so
// both take exactly the same path.
function applyRoleTransition(prev: HushConfig, saved: HushConfig): void {
  applyConfig(saved);

  // Tear down BOTH cross-machine resources unconditionally before bringing up the
  // new role — mirrors how applyConfig() already released the input/orchestrator.
  stopHost();
  remote.disconnect();

  const credsChanged =
    saved.discordRpc.clientId !== prev.discordRpc.clientId ||
    saved.discordRpc.clientSecret !== prev.discordRpc.clientSecret;

  if (saved.role === 'controller') {
    // Controller mutes the remote host, not local Discord.
    void discord.disconnect();
    connectRemote();
  } else {
    // Both 'local' and 'host' drive the LOCAL Discord RPC. Reconnect only when it
    // isn't already up (e.g. returning from controller) or the creds changed —
    // so a pure host-setting resave never drops a live socket mid-mute.
    if (saved.role === 'host') startHost();
    if (!discord.isConnected() || credsChanged) void connectDiscord();
  }
}

// Fast local ↔ controller switch triggered outside the window (tray / macOS
// menu). Reuses the stored remote config so a controller flip needs no re-entry.
function switchDiscordLocation(target: 'local' | 'controller'): void {
  const decision = resolveLocationSwitch(
    target,
    Boolean(cfg.remote.host && cfg.remote.pairingCode),
  );
  if ('needsConfig' in decision) {
    // Nothing to flip to blindly — open the window on the location card so the
    // user can enter the host IP + pairing code.
    showWindow();
    win?.webContents.send('focus-location');
    return;
  }
  if (decision.role === cfg.role) return; // already there
  try {
    const prev = cfg;
    const saved = saveConfig({ ...cfg, role: decision.role });
    applyRoleTransition(prev, saved);
    win?.webContents.send('config-updated', saved); // resync an open window
  } catch (err) {
    dbg('switchDiscordLocation failed', err instanceof Error ? err.message : String(err));
  }
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
    applyLaunchAtLogin(cfg); // honour the stored launch-at-login choice on boot
    // Auto-reconnect when the local Discord RPC drops (Discord quits/restarts).
    // Fires only on a real drop of a live session — never on an intentional
    // disconnect, and never in the controller role (where the local RPC is never
    // connected). If Discord is still restarting, the reconnect fails and the 15s
    // retry loop takes over — so a Discord restart needs no manual reconnect.
    discord.setOnDrop(() => {
      dbg('rpc: dropped — scheduling reconnect');
      if (rpcRetryTimer) { clearTimeout(rpcRetryTimer); rpcRetryTimer = null; }
      rpcRetryTimer = setTimeout(() => { void connectDiscord(); }, 3000);
    });

    // Role-aware bring-up (cross-machine work): host connects local Discord +
    // starts the relay, controller dials the remote host, local just connects.
    if (cfg.role === 'host') { void connectDiscord(); startHost(); }
    else if (cfg.role === 'controller') { connectRemote(); }
    else { void connectDiscord(); } // best-effort auto-connect from stored credentials

    // A sleep can leave the LAN link half-open with no clean close, so proactively
    // re-establish on wake instead of waiting on a heartbeat cycle. Both helpers
    // are idempotent (connectRemote disconnects first and no-ops unless controller;
    // startHost stops the old listener and re-advertises mDNS).
    powerMonitor.on('resume', () => {
      dbg('power: resume — re-establishing links');
      connectRemote();
      if (cfg.role === 'host') startHost();
    });

    // First run: open the settings window so the user can set things up.
    showWindow();

    // ---- IPC ----
    ipcMain.handle('config:get', () => cfg);
    ipcMain.handle('brand:get', () => ({ name: BRAND.name, tagline: BRAND.taglineFr }));
    ipcMain.handle('config:set', (_e, next: HushConfig) => {
      try {
        const prev = cfg; // note: cfg is reassigned inside applyConfig(saved)
        const saved = saveConfig(next);
        applyRoleTransition(prev, saved);
        // Only touch the OS login item when the toggle actually changed.
        if (saved.launchAtLogin !== prev.launchAtLogin) applyLaunchAtLogin(saved);
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
    // Whether the renderer should show the drag-into-Privacy-list affordance.
    ipcMain.handle('perm:can-drag', () => CAN_DRAG_PERMS);
    // Start a native drag of the Hush.app bundle so the user can drop it straight
    // onto the macOS Accessibility / Input Monitoring list. startDrag requires a
    // non-empty icon; reuse the app icon, scaled down for the drag image.
    ipcMain.on('perm:startdrag', (e) => {
      if (!CAN_DRAG_PERMS || !APP_BUNDLE) return;
      try {
        const icon = nativeImage
          .createFromPath(path.join(ASSETS, 'generated', 'icon-256.png'))
          .resize({ width: 64, height: 64 });
        e.sender.startDrag({ file: APP_BUNDLE, icon });
      } catch { /* noop — drag is best-effort, the Open buttons remain */ }
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
    ipcMain.handle('net:lan-info', () => ({
      addresses: lanAddresses(),
      hostname: os.hostname(),
    }));
    ipcMain.handle('net:gen-code', () => generatePairingCode());
    ipcMain.handle('net:remote-status', () => ({
      state: remote.getState(), error: remote.getError(),
    }));
    // Browse for hosts for a bounded window, collecting unique results.
    ipcMain.handle('net:discover', () => new Promise<DiscoveredHost[]>((resolve) => {
      const found = new Map<string, DiscoveredHost>();
      const stop = browseHosts((h) => found.set(`${h.host}:${h.port}`, h));
      setTimeout(() => { stop(); resolve([...found.values()]); }, 2500);
    }));
  });

  // Watchdog: never leave Discord muted on quit/crash.
  app.on('before-quit', cleanup);
  process.on('SIGINT', () => { cleanup(); app.quit(); });
  process.on('uncaughtException', () => { cleanup(); });

  // Menu-bar app: stay alive with no windows.
  app.on('window-all-closed', () => { /* keep running in the menu bar */ });
}
