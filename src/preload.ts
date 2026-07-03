import { contextBridge, ipcRenderer } from 'electron';

const bridge = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg: unknown) => ipcRenderer.invoke('config:set', cfg),
  getBrand: () => ipcRenderer.invoke('brand:get'),
  getPermissions: () => ipcRenderer.invoke('perm:status'),
  captureCombo: () => ipcRenderer.invoke('capture:combo'),
  openAccessibility: () => ipcRenderer.send('perm:open-accessibility'),
  openInputMonitoring: () => ipcRenderer.send('perm:open-input'),
  canDragPermissions: () => ipcRenderer.invoke('perm:can-drag'),
  startPermDrag: () => ipcRenderer.send('perm:startdrag'),
  openExternal: (url: string) => ipcRenderer.send('app:open-external', url),
  quit: () => ipcRenderer.send('app:quit'),
  onStatus: (cb: (s: unknown) => void) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onConfigUpdated: (cb: (cfg: unknown) => void) =>
    ipcRenderer.on('config-updated', (_e, cfg) => cb(cfg)),
  onFocusLocation: (cb: () => void) =>
    ipcRenderer.on('focus-location', () => cb()),
  reconnectRpc: () => ipcRenderer.invoke('rpc:reconnect'),
  lanInfo: () => ipcRenderer.invoke('net:lan-info'),
  genCode: () => ipcRenderer.invoke('net:gen-code'),
  discoverHosts: () => ipcRenderer.invoke('net:discover'),
  remoteStatus: () => ipcRenderer.invoke('net:remote-status'),
};

contextBridge.exposeInMainWorld('hush', bridge);
