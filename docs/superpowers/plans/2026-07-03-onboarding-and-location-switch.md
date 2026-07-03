# Onboarding interactif + switch d'emplacement Discord — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre l'onboarding interactif (capture du raccourci + configuration Discord inline) et permettre de basculer local ↔ distant en un geste depuis 3 surfaces (segment fenêtre, menu tray, menu du haut macOS).

**Architecture:** Une fonction pure `resolveLocationSwitch` (testée) décide de la bascule ; `main.ts` l'utilise dans `switchDiscordLocation()` (tray + menu macOS) et réutilise `applyRoleTransition()` partagé avec le handler `config:set`. Côté `renderer.js`, la capture est généralisée (`captureInto`) et le câblage du panneau rôle est extrait (`wireRoleControls(refs)`) pour être réutilisé à l'identique dans la fenêtre et dans les étapes d'onboarding.

**Tech Stack:** Electron 30, TypeScript, Vitest, HTML/CSS/JS vanilla (renderer), `discord-rpc`, `ws`, `bonjour-service`.

## Global Constraints

- Langue de l'UI : **français**, accents corrects.
- Aucun changement du schéma `HushConfig` (`src/types.ts`) ni migration `store.ts`.
- La config distante `cfg.remote` est déjà persistée quel que soit le rôle — la bascule doit être **sans re-saisie**.
- Le switch rapide ne concerne que `local` ↔ `controller` ; `host` n'est pas une destination du switch rapide (mais cliquer un radio depuis `host` applique la bascule normalement).
- Port par défaut : `8698` (`DEFAULT_PORT`).
- Menu applicatif macOS **darwin uniquement** ; hors darwin, comportement inchangé.
- Ne pas casser `npm test` ni `npm run typecheck`.
- Commits fréquents ; messages en anglais, terminés par `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create** `src/location-switch.ts` — fonction pure de décision de bascule (une responsabilité, testable sans Electron).
- **Create** `tests/location-switch.test.ts` — table de vérité de la décision.
- **Modify** `src/main.ts` — extraire `applyRoleTransition`, ajouter `switchDiscordLocation`, `refreshAppMenu`, radios de tray, canaux IPC `config-updated`/`focus-location`.
- **Modify** `src/preload.ts` — exposer `onConfigUpdated` / `onFocusLocation`.
- **Modify** `renderer/renderer.js` — généraliser la capture, extraire `wireRoleControls(refs)`, bascule immédiate, étapes d'onboarding interactives.

---

## Task 1: Module pur de décision de bascule

**Files:**
- Create: `src/location-switch.ts`
- Test: `tests/location-switch.test.ts`

**Interfaces:**
- Produces:
  - `type LocationTarget = 'local' | 'controller'`
  - `type SwitchDecision = { role: 'local' | 'controller' } | { needsConfig: true }`
  - `resolveLocationSwitch(target: LocationTarget, hasRemoteConfig: boolean): SwitchDecision`

- [ ] **Step 1: Write the failing test**

Create `tests/location-switch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveLocationSwitch } from '../src/location-switch';

describe('resolveLocationSwitch', () => {
  it('always allows switching to local, with or without a remote config', () => {
    expect(resolveLocationSwitch('local', false)).toEqual({ role: 'local' });
    expect(resolveLocationSwitch('local', true)).toEqual({ role: 'local' });
  });
  it('allows switching to controller when a remote config already exists', () => {
    expect(resolveLocationSwitch('controller', true)).toEqual({ role: 'controller' });
  });
  it('asks to configure when switching to controller with no remote config', () => {
    expect(resolveLocationSwitch('controller', false)).toEqual({ needsConfig: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/location-switch.test.ts`
Expected: FAIL — `Cannot find module '../src/location-switch'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/location-switch.ts`:

```ts
// Where the dictation machine sends its mute: this machine's Discord ('local')
// or a Discord running on another machine we control ('controller').
export type LocationTarget = 'local' | 'controller';

export type SwitchDecision =
  | { role: 'local' | 'controller' }
  | { needsConfig: true };

// Decide what a fast location switch should do.
//  - 'local' is always applicable (mute the Discord on this machine).
//  - 'controller' only applies when a usable remote config (host + pairing code)
//    is already stored; otherwise the window must be opened to enter it.
export function resolveLocationSwitch(
  target: LocationTarget,
  hasRemoteConfig: boolean,
): SwitchDecision {
  if (target === 'local') return { role: 'local' };
  return hasRemoteConfig ? { role: 'controller' } : { needsConfig: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/location-switch.test.ts`
Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/location-switch.ts tests/location-switch.test.ts
git commit -m "feat(switch): pure resolveLocationSwitch decision + tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Switch d'emplacement côté process (main + preload)

**Files:**
- Modify: `src/main.ts`
- Modify: `src/preload.ts`

**Interfaces:**
- Consumes: `resolveLocationSwitch` (Task 1) ; existants `loadConfig`/`saveConfig`, `applyConfig`, `connectDiscord`, `connectRemote`, `startHost`, `stopHost`, `discord`, `remote`, `pushStatus`, `refreshTrayMenu`, `showWindow`, `win`, `cfg`.
- Produces:
  - `applyRoleTransition(prev: HushConfig, saved: HushConfig): void`
  - `switchDiscordLocation(target: 'local' | 'controller'): void`
  - `refreshAppMenu(): void`
  - Preload : `window.hush.onConfigUpdated(cb)`, `window.hush.onFocusLocation(cb)`

### 2a — Extraire `applyRoleTransition` (refacto sans changement de comportement)

- [ ] **Step 1: Ajouter `import { resolveLocationSwitch } from './location-switch';`**

Dans `src/main.ts`, à côté des autres imports (après la ligne `import { appBundlePath, canDragPermissions } from './mac-drag';`) :

```ts
import { resolveLocationSwitch } from './location-switch';
```

Ajouter aussi `Menu` s'il n'est pas déjà importé — il l'est déjà (ligne 1 : `import { app, Tray, Menu, ... }`).

- [ ] **Step 2: Extraire la transition de rôle**

Juste avant le handler `ipcMain.handle('config:set', …)`, ajouter la fonction (elle reprend **verbatim** la logique aujourd'hui inline dans `config:set`) :

```ts
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
```

- [ ] **Step 3: Réduire le handler `config:set` pour l'utiliser**

Remplacer le corps du `try { … }` du handler `config:set` (lignes ~394-419) par :

```ts
      try {
        const prev = cfg; // note: cfg is reassigned inside applyConfig(saved)
        const saved = saveConfig(next);
        applyRoleTransition(prev, saved);
        return { ok: true, config: saved };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
```

- [ ] **Step 4: Typecheck + tests (no behavior change)**

Run: `npm run typecheck && npm test`
Expected: typecheck OK ; toute la suite existante verte.

### 2b — Menu applicatif macOS (`refreshAppMenu`)

- [ ] **Step 5: Ajouter `refreshAppMenu`**

Après `refreshTrayMenu()` dans `src/main.ts`, ajouter :

```ts
// macOS application menu (the top-of-screen menu bar). Darwin only: elsewhere we
// leave Electron's default. Rebuilt on every status push so the Discord radios
// track cfg.role. The Edit menu's roles are what make ⌘C/⌘V work in the text
// fields — needed to paste the Discord Client ID / Secret.
function refreshAppMenu(): void {
  if (process.platform !== 'darwin') return;
  const controllerLabel = cfg.remote.host
    ? `Autre machine — ${cfg.remote.host}`
    : 'Autre machine…';
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
          {
            label: 'Cette machine',
            type: 'radio',
            checked: cfg.role === 'local',
            click: () => switchDiscordLocation('local'),
          },
          {
            label: controllerLabel,
            type: 'radio',
            checked: cfg.role === 'controller',
            click: () => switchDiscordLocation('controller'),
          },
          { type: 'separator' },
          { label: 'Réglages…', click: showWindow },
        ],
      },
    ]),
  );
}
```

- [ ] **Step 6: Rafraîchir le menu applicatif à chaque `pushStatus`**

Dans `pushStatus()`, juste après `refreshTrayMenu();`, ajouter :

```ts
  refreshAppMenu();
```

### 2c — Radios dans le menu du tray

- [ ] **Step 7: Ajouter les radios d'emplacement au menu du tray**

Dans `refreshTrayMenu()`, dans le template passé à `Menu.buildFromTemplate([...])`, insérer avant le second `{ type: 'separator' }` (celui qui précède « Réglages… ») :

```ts
      { type: 'separator' },
      { label: 'Emplacement de Discord', enabled: false },
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
```

### 2d — `switchDiscordLocation`

- [ ] **Step 8: Ajouter `switchDiscordLocation`**

Après `applyRoleTransition`, ajouter :

```ts
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
```

### 2e — Preload : canaux entrants

- [ ] **Step 9: Exposer les deux canaux dans `src/preload.ts`**

Dans l'objet `bridge`, après la ligne `onStatus: …`, ajouter :

```ts
  onConfigUpdated: (cb: (cfg: unknown) => void) =>
    ipcRenderer.on('config-updated', (_e, cfg) => cb(cfg)),
  onFocusLocation: (cb: () => void) =>
    ipcRenderer.on('focus-location', () => cb()),
```

- [ ] **Step 10: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: OK, aucun type error (les fonctions sont hoistées, `switchDiscordLocation` référencée par les menus est valide).

- [ ] **Step 11: Manual smoke test (macOS, mono-PC)**

Run: `npm start`
Vérifier :
1. Le **menu du haut** affiche `Hush`, `Édition`, `Discord`. ⌘V colle bien dans un champ.
2. Menu `Discord` : « Cette machine » est coché. Cliquer « Autre machine… » (sans config) → la fenêtre s'ouvre.
3. Menu du **tray** : la section « Emplacement de Discord » avec les 2 radios apparaît, « Cette machine » coché.

- [ ] **Step 12: Commit**

```bash
git add src/main.ts src/preload.ts
git commit -m "feat(switch): tray + macOS menu Discord location switch

Extract applyRoleTransition shared by config:set and the new
switchDiscordLocation; add a darwin app menu (with Edit roles for paste)
and tray radios; emit config-updated / focus-location to the window.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Capture de raccourci généralisée + bouton dans l'onboarding

**Files:**
- Modify: `renderer/renderer.js`

**Interfaces:**
- Consumes: `window.hush.captureCombo()`, `comboLabel`, `persist`, `render`, `cfg`.
- Produces: `captureInto(field, btnEl)` remplaçant `startCapture` + `CAP`.

- [ ] **Step 1: Remplacer `CAP` + `startCapture` par `captureInto`**

Dans `renderer/renderer.js`, supprimer :

```js
const CAP = { shortcut: els.capShortcut };
```

et la fonction `startCapture(field)` + la boucle `for (const [field, btn] of Object.entries(CAP)) …`, puis les remplacer par :

```js
// Arm a capture button, record the pressed combo into cfg[field], persist it,
// and refresh every button that shows this shortcut (window + onboarding).
async function captureInto(field, btnEl) {
  if (armedField) return; // one at a time
  armedField = field;
  els.err.textContent = '';
  btnEl.classList.add('armed');
  btnEl.textContent = 'Appuie…';

  const res = await window.hush.captureCombo();

  if (res.combo) {
    cfg[field] = res.combo;
    await persist();
  } else if (res.reason === 'unsupported') {
    els.err.textContent = 'Touche non gérée — utilise une lettre, un chiffre ou F1–F24 (avec ⌃⌥⌘⇧ en option).';
  } else if (res.reason === 'timeout') {
    els.err.textContent = 'Rien capté. Active « Surveillance de la saisie » pour Hush, puis relance l\'app.';
  }

  btnEl.classList.remove('armed');
  armedField = null;
  render();
  // Keep the onboarding button (if the tutorial is on the shortcut step) in sync.
  const obBtn = document.getElementById('ob-cap-shortcut');
  if (obBtn) obBtn.textContent = comboLabel(cfg.shortcut);
}

els.capShortcut.addEventListener('click', () => captureInto('shortcut', els.capShortcut));
```

> Note : `captureInto` persiste désormais immédiatement (le tuto n'a pas de bouton « Enregistrer »). C'est aussi un mieux pour la fenêtre.

- [ ] **Step 2: Rendre l'étape « Ton raccourci » interactive (`STEPS[3]`)**

Remplacer l'objet `STEPS[3]` (celui avec `glyph: '⌨️'`, `title: 'Ton raccourci'`) par la
version avec **capture + sélecteur de mode expliqué** :

```js
  {
    glyph: '⌨️',
    title: 'Ton raccourci',
    body: `<p>Un seul réglage : ton <strong>push-to-talk</strong>. Mets <strong>exactement</strong> le même raccourci que dans Wispr Flow (Réglages → General → Shortcuts).</p>
      <p>Hush ne simule rien : tu presses ce raccourci toi-même, Wispr dicte comme d'habitude, et Hush coupe Discord pendant que tu dictes.</p>
      <div class="binding">
        <div class="binding-label"><strong>Push-to-talk</strong><span class="muted">identique à Wispr → Raccourcis</span></div>
        <button class="capture" id="ob-cap-shortcut">⌃⌥</button>
      </div>
      <p class="hint">Clique puis presse ta touche. Modificateurs seuls (ex. ⌃⌥) : maintiens puis relâche. Fn (🌐) supportée. Échap = annuler.</p>
      <div class="binding">
        <div class="binding-label"><strong>Mode</strong><span class="muted">comme dans Wispr</span></div>
        <div class="segment" id="ob-mode-seg">
          <button type="button" data-mode="hold" class="active">Maintenir</button>
          <button type="button" data-mode="toggle">Bascule</button>
        </div>
      </div>
      <div class="callout">🎯 <strong>Maintenir</strong> : Discord est coupé <strong>tant que tu tiens</strong> la touche. <strong>Bascule</strong> : <strong>1er appui</strong> coupe (et reste coupé), <strong>2e appui</strong> réactive. Si tu <em>tapes</em> ta touche (appui/ré-appui), choisis <strong>Bascule</strong> — sinon Discord ne se coupe qu'une fraction de seconde.</div>`,
    wire(root) {
      const btn = root.querySelector('#ob-cap-shortcut');
      btn.textContent = comboLabel(cfg.shortcut);
      btn.onclick = () => captureInto('shortcut', btn);

      const modeSeg = root.querySelector('#ob-mode-seg');
      for (const b of modeSeg.querySelectorAll('button')) {
        b.classList.toggle('active', b.dataset.mode === cfg.mode);
      }
      modeSeg.addEventListener('click', async (e) => {
        const m = e.target.dataset.mode;
        if (!m) return;
        cfg.mode = m;
        for (const b of modeSeg.querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === m);
        await persist();   // no Save button in the tutorial → persist immediately
        render();          // keep the window's Comportement segment in sync
      });
    },
  },
```

> Le segment de mode écrit dans `cfg.mode` et persiste tout de suite ; `render()`
> met à jour le segment « Comportement » de la fenêtre (les deux restent alignés).

- [ ] **Step 3: Build + manual test**

Run: `npm start`
Vérifier :
1. Fenêtre : le bouton de raccourci capture toujours et le libellé se met à jour.
2. Onboarding → étape « Ton raccourci » : le bouton capture, le libellé s'affiche, et la valeur se retrouve dans la fenêtre derrière.
3. Le segment **Mode** (Maintenir/Bascule) reflète `cfg.mode`, bascule au clic, persiste, et le segment « Comportement » de la fenêtre suit le même choix.

- [ ] **Step 4: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(onboarding): capture shortcut + choose mode inline in the tutorial

Generalize capture into captureInto(field, btnEl); wire a real capture
button and a Maintenir/Bascule mode selector (with a hold-vs-toggle
explainer) into the shortcut onboarding step; persist immediately.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Panneau rôle réutilisable + bascule immédiate (fenêtre)

**Files:**
- Modify: `renderer/renderer.js`

**Interfaces:**
- Consumes: `window.hush.discoverHosts/genCode/lanInfo`, `persist`, `cfg`.
- Produces: `wireRoleControls(refs)`, `refreshHostAddrs(refs)` ; `persist()` ne synchronise plus le rôle depuis le DOM (les listeners `input` gardent `cfg` à jour).

- [ ] **Step 1: Introduire un jeu de refs pour la fenêtre**

Après la définition de `els`, ajouter :

```js
// Element set for the main-window role controls. The onboarding step builds an
// equivalent set with ob-* ids and passes it to the same wireRoleControls().
const MAIN_ROLE_REFS = {
  roleSeg: els.roleSeg, controllerPanel: els.controllerPanel,
  discoverBtn: els.discoverBtn, hostList: els.hostList,
  remoteHost: els.remoteHost, remotePort: els.remotePort, remoteCode: els.remoteCode,
  remoteConnect: els.remoteConnect, remoteStatus: els.remoteStatus,
  hostToggle: els.hostToggle, hostPanel: els.hostPanel,
  hostAddrs: els.hostAddrs, hostPort: els.hostPort, hostCode: els.hostCode,
  regenCodeBtn: els.regenCodeBtn,
};
```

- [ ] **Step 2: Généraliser `refreshHostAddrs`**

Remplacer la fonction `refreshHostAddrs()` existante par une version paramétrée :

```js
async function refreshHostAddrs(refs) {
  const info = await window.hush.lanInfo();
  refs.hostAddrs.textContent = info.addresses.length ? info.addresses.join(', ') : 'aucune IP LAN';
}
```

- [ ] **Step 3: Extraire `wireRoleControls(refs)` et supprimer `syncRoleInputs`**

Supprimer `syncRoleInputs()` et les cinq blocs de handlers rôle existants
(`els.roleSeg.addEventListener`, `els.hostToggle.addEventListener`,
`els.regenCodeBtn.addEventListener`, `els.discoverBtn.addEventListener`,
`els.remoteConnect.addEventListener`). Les remplacer par :

```js
// Wire a full set of role controls (segment, host toggle, discover, remote/host
// fields, connect, regen) onto the shared persist()/discover/genCode handlers.
// Live `input` listeners keep cfg.remote / cfg.hostListen current, so persist()
// no longer needs to read these fields out of the DOM — which is what lets the
// onboarding step reuse this with ob-* elements without clobbering cfg.
function wireRoleControls(refs) {
  // Keep cfg in sync as the user types (works for window AND onboarding fields).
  const syncRemote = () => {
    cfg.remote = {
      host: refs.remoteHost.value.trim(),
      port: Number(refs.remotePort.value) || 8698,
      pairingCode: refs.remoteCode.value.trim(),
    };
  };
  const syncHost = () => {
    cfg.hostListen = {
      port: Number(refs.hostPort.value) || 8698,
      pairingCode: refs.hostCode.value.trim(),
    };
  };
  refs.remoteHost.addEventListener('input', syncRemote);
  refs.remotePort.addEventListener('input', syncRemote);
  refs.remoteCode.addEventListener('input', syncRemote);
  refs.hostPort.addEventListener('input', syncHost);

  // Segment: Cette machine / Autre machine. Persist immediately so the switch
  // takes effect without a Save; controller persists only when a remote config
  // is already known (otherwise just reveal the panel and wait for Connecter).
  refs.roleSeg.addEventListener('click', async (e) => {
    const r = e.target.dataset.role;
    if (!r) return;
    if (refs.hostToggle.checked) { refs.hostToggle.checked = false; refs.hostPanel.hidden = true; }
    for (const b of refs.roleSeg.querySelectorAll('button')) b.classList.toggle('active', b.dataset.role === r);
    refs.controllerPanel.hidden = r !== 'controller';
    cfg.role = r;
    if (r === 'local' || (cfg.remote.host && cfg.remote.pairingCode)) await persist();
  });

  refs.hostToggle.addEventListener('change', async () => {
    const checked = refs.hostToggle.checked;
    refs.hostPanel.hidden = !checked;
    if (!checked) {
      const active = refs.roleSeg.querySelector('button.active');
      cfg.role = active?.dataset.role === 'controller' ? 'controller' : 'local';
      await persist();
      return;
    }
    for (const b of refs.roleSeg.querySelectorAll('button')) b.classList.toggle('active', b.dataset.role === 'local');
    refs.controllerPanel.hidden = true;
    cfg.role = 'host';
    await refreshHostAddrs(refs);
    if (!cfg.hostListen.pairingCode) cfg.hostListen.pairingCode = await window.hush.genCode();
    refs.hostCode.value = cfg.hostListen.pairingCode;
    refs.hostPort.value = String(cfg.hostListen.port || 8698);
    syncHost();
    await persist();
  });

  refs.regenCodeBtn.addEventListener('click', async () => {
    cfg.hostListen.pairingCode = await window.hush.genCode();
    refs.hostCode.value = cfg.hostListen.pairingCode;
    syncHost();
    await persist();
  });

  refs.discoverBtn.addEventListener('click', async () => {
    refs.hostList.innerHTML = '<li>Recherche…</li>';
    const hosts = await window.hush.discoverHosts();
    refs.hostList.innerHTML = '';
    if (!hosts.length) {
      refs.hostList.innerHTML = "<li>Aucun hôte trouvé — saisis l'IP.</li>";
      return;
    }
    for (const h of hosts) {
      const li = document.createElement('li');
      li.textContent = `${h.name} — ${h.host}:${h.port}`;
      li.addEventListener('click', () => {
        refs.remoteHost.value = h.host;
        refs.remotePort.value = String(h.port);
        syncRemote();
      });
      refs.hostList.appendChild(li);
    }
  });

  refs.remoteConnect.addEventListener('click', async () => {
    cfg.role = 'controller';
    syncRemote();
    refs.remoteStatus.textContent = 'Connexion…';
    refs.remoteStatus.className = 'pill pill-warn';
    if (!(await persist())) {
      refs.remoteStatus.textContent = 'Non connecté';
      refs.remoteStatus.className = 'pill pill-off';
    }
  });
}
```

- [ ] **Step 4: Alléger `persist()` (le rôle n'est plus lu depuis le DOM)**

Dans `persist()`, supprimer l'appel `syncRoleInputs();` (garder `syncRpcInputs();`) :

```js
async function persist() {
  syncRpcInputs();
  els.err.textContent = '';
  const res = await window.hush.saveConfig(cfg);
  if (!res.ok) {
    els.err.textContent = translateConfigError(res.error);
    return false;
  }
  cfg = res.config;
  return true;
}
```

- [ ] **Step 5: Câbler la fenêtre + adapter les appels à `refreshHostAddrs`**

Dans `init()`, remplacer `if (cfg.role === 'host') refreshHostAddrs();` par :

```js
  wireRoleControls(MAIN_ROLE_REFS);
  if (cfg.role === 'host') refreshHostAddrs(MAIN_ROLE_REFS);
```

- [ ] **Step 6: Build + manual test (fenêtre)**

Run: `npm start`
Vérifier dans la fenêtre :
1. « Cette machine » ↔ « Autre machine » : passer à « Cette machine » applique **immédiatement** (statut mis à jour, pas besoin d'Enregistrer).
2. Renseigner IP + code, « Connecter » → statut « Connexion… » puis état live.
3. Cocher « Cette machine héberge Discord » → code généré, IP affichée, persiste.
4. Repasser « Autre machine » avec une config déjà saisie → reconnecte tout de suite.

- [ ] **Step 7: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(switch): immediate role switch + reusable wireRoleControls

Extract the role-panel wiring into wireRoleControls(refs) driven by live
input listeners, so persist() no longer reads role fields from the DOM.
The segment now persists on click (local always; controller when already
paired).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Étape d'onboarding « Où est Discord ? » interactive

**Files:**
- Modify: `renderer/renderer.js`

**Interfaces:**
- Consumes: `wireRoleControls(refs)`, `refreshHostAddrs(refs)`, `renderRole` pattern, `setStatus`, `window.hush.onConfigUpdated/onFocusLocation` (Task 2).
- Produces: `STEPS[4]` interactif ; `setStatus` met aussi à jour `#ob-remote-status`.

- [ ] **Step 1: Rendre l'étape « Où est Discord ? » interactive (`STEPS[4]`)**

Remplacer l'objet `STEPS[4]` (glyph `🖥️`, titre « Discord sur un autre PC ? (optionnel) ») par :

```js
  {
    glyph: '🖥️',
    title: 'Où est Discord ?',
    body: `<p>Sur <strong>cette machine</strong>, ou sur un <strong>autre PC</strong> (setup double PC) — Hush le coupe dans les deux cas.</p>
      <div class="binding">
        <div class="binding-label"><strong>Emplacement de Discord</strong></div>
        <div class="segment" id="ob-role-seg">
          <button type="button" data-role="local" class="active">Cette machine</button>
          <button type="button" data-role="controller">Autre machine</button>
        </div>
      </div>
      <div id="ob-controller-panel" hidden>
        <p class="hint">Ce Mac va commander le Discord de l'autre PC.</p>
        <div class="row-actions"><button class="ghost" id="ob-discover-btn" type="button">Rechercher les hôtes…</button></div>
        <ul id="ob-host-list"></ul>
        <div class="field"><label for="ob-remote-host">Adresse (IP) du PC hôte</label><input id="ob-remote-host" type="text" spellcheck="false" placeholder="192.168.1.20" /></div>
        <div class="field"><label for="ob-remote-port">Port</label><input id="ob-remote-port" type="number" value="8698" /></div>
        <div class="field"><label for="ob-remote-code">Code d'appairage</label><input id="ob-remote-code" type="text" spellcheck="false" placeholder="ABC123" /></div>
        <div class="row-actions"><button class="primary" id="ob-remote-connect" type="button">Connecter</button><span id="ob-remote-status" class="pill pill-off">Non connecté</span></div>
      </div>
      <hr />
      <div class="perm-row"><span><strong>Cette machine héberge Discord</strong> <span class="muted">— pour une autre machine</span></span><input type="checkbox" id="ob-host-toggle" /></div>
      <div id="ob-host-panel" hidden>
        <p class="muted">Adresse(s) : <strong id="ob-host-addrs">—</strong></p>
        <div class="field"><label for="ob-host-port">Port</label><input id="ob-host-port" type="number" value="8698" /></div>
        <div class="field"><label for="ob-host-code">Code d'appairage</label><input id="ob-host-code" type="text" readonly /></div>
        <div class="row-actions"><button class="ghost" id="ob-regen-code-btn" type="button">Régénérer le code</button></div>
      </div>
      <div class="callout">Les deux machines doivent être sur le <strong>même réseau</strong> (Wi-Fi/box). En simple PC, laisse « Cette machine ».</div>`,
    wire(root) {
      const refs = {
        roleSeg: root.querySelector('#ob-role-seg'),
        controllerPanel: root.querySelector('#ob-controller-panel'),
        discoverBtn: root.querySelector('#ob-discover-btn'),
        hostList: root.querySelector('#ob-host-list'),
        remoteHost: root.querySelector('#ob-remote-host'),
        remotePort: root.querySelector('#ob-remote-port'),
        remoteCode: root.querySelector('#ob-remote-code'),
        remoteConnect: root.querySelector('#ob-remote-connect'),
        remoteStatus: root.querySelector('#ob-remote-status'),
        hostToggle: root.querySelector('#ob-host-toggle'),
        hostPanel: root.querySelector('#ob-host-panel'),
        hostAddrs: root.querySelector('#ob-host-addrs'),
        hostPort: root.querySelector('#ob-host-port'),
        hostCode: root.querySelector('#ob-host-code'),
        regenCodeBtn: root.querySelector('#ob-regen-code-btn'),
      };
      // Reflect current cfg into the freshly-rendered controls.
      const controller = cfg.role === 'controller';
      const hosting = cfg.role === 'host';
      for (const b of refs.roleSeg.querySelectorAll('button')) {
        b.classList.toggle('active', b.dataset.role === (controller ? 'controller' : 'local'));
      }
      refs.controllerPanel.hidden = !controller;
      refs.hostToggle.checked = hosting;
      refs.hostPanel.hidden = !hosting;
      refs.remoteHost.value = cfg.remote.host || '';
      refs.remotePort.value = String(cfg.remote.port || 8698);
      refs.remoteCode.value = cfg.remote.pairingCode || '';
      refs.hostPort.value = String(cfg.hostListen.port || 8698);
      refs.hostCode.value = cfg.hostListen.pairingCode || '';
      if (hosting) refreshHostAddrs(refs);
      wireRoleControls(refs);
    },
  },
```

- [ ] **Step 2: Étendre `setStatus` pour la pastille distante de l'onboarding**

Dans `setStatus(s)`, à l'intérieur du bloc `if (s.role === 'controller') { … }`,
juste après avoir mis à jour `els.remoteStatus`, mettre à jour aussi le miroir
onboarding. Remplacer les trois affectations à `els.remoteStatus` par une petite
aide locale en tête du bloc :

```js
  if (s.role === 'controller') {
    const r = s.remote || {};
    const help = $('remote-help');
    const obStatus = $('ob-remote-status');
    const setRemote = (text, cls) => {
      els.remoteStatus.textContent = text; els.remoteStatus.className = cls;
      if (obStatus) { obStatus.textContent = text; obStatus.className = cls; }
    };
    if (r.state === 'connected') {
      setRemote('Connecté ✓', 'pill pill-ok');
      if (help) help.hidden = true;
    } else if (r.state === 'connecting') {
      setRemote('Connexion…', 'pill pill-warn');
      if (help) help.hidden = true;
    } else {
      setRemote(r.error ? `Échec : ${r.error}` : 'Hôte injoignable', r.error ? 'pill pill-warn' : 'pill pill-off');
      if (help) {
        help.textContent = "Vérifie : Hush ouvert sur le PC hôte · les deux machines sur le même réseau · IP et code exacts · le pare-feu du PC autorise le port " + (cfg.remote?.port || 8698) + '.';
        help.hidden = false;
      }
    }
  }
```

- [ ] **Step 3: Consommer `config-updated` / `focus-location` (resync fenêtre)**

Dans `init()`, après `window.hush.onStatus(setStatus);` (qui est appelé au niveau
module — le placer juste après la définition d'`init` avec les autres abonnements),
ajouter au corps d'`init()`, avant l'appel à `render()` initial ou juste après :

```js
  window.hush.onConfigUpdated((next) => {
    cfg = next;
    render();
    if (!ob.overlay.hidden) renderStep(); // keep an open tutorial step in sync
  });
  window.hush.onFocusLocation(() => {
    $('role-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
```

- [ ] **Step 4: Build + manual test (onboarding)**

Run: `npm start` puis, dans la fenêtre, cliquer « Revoir le tuto » et aller à l'étape « Où est Discord ? ».
Vérifier :
1. Le segment Cette machine / Autre machine fonctionne ; « Autre machine » révèle les champs.
2. « Rechercher les hôtes… » liste les hôtes (si un host tourne) ; cliquer un hôte remplit IP+port.
3. « Connecter » persiste et la pastille `ob-remote-status` suit l'état live.
4. Cocher « Cette machine héberge Discord » génère un code et affiche l'IP.
5. Basculer depuis le menu du tray met à jour la fenêtre ouverte (resync `config-updated`).
6. Cliquer « Autre machine… » dans le menu tray sans config ouvre la fenêtre et scrolle sur la carte (`focus-location`).

- [ ] **Step 5: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(onboarding): configure Discord location inline in the tutorial

Interactive 'Où est Discord ?' step (local/controller/host) reusing
wireRoleControls; mirror live remote status into the step; resync the
window on config-updated and scroll to the card on focus-location.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Vérification finale + garde-fous

**Files:** aucun (validation).

- [ ] **Step 1: Typecheck + suite complète**

Run: `npm run typecheck && npm test`
Expected: typecheck OK ; tous les tests verts (dont `location-switch.test.ts`).

- [ ] **Step 2: Revue du diff complet**

Run: `git diff main...HEAD --stat`
Vérifier que seuls `src/location-switch.ts`, `tests/location-switch.test.ts`, `src/main.ts`, `src/preload.ts`, `renderer/renderer.js` (et les 2 docs) ont changé — aucun fichier inattendu.

- [ ] **Step 3: Parcours manuel de bout en bout**

Sur macOS (`npm start`) :
1. Premier lancement simulé (`localStorage.removeItem('hush.onboarded')` via devtools) → onboarding complet, capture du raccourci + choix Discord fonctionnels.
2. Switch tray/menu/segment cohérents et sans perte de la config distante.

Si un host Windows est disponible : suivre `docs/WINDOWS.md` (Option A `npm start`) et valider le mute distant + bascule distant → local → distant sans re-saisie.

---

## Self-Review Notes

- **Spec coverage** : §1 module pur → Task 1 ; §2 transition partagée → Task 2a ; §3 tray → Task 2c ; §4 menu macOS → Task 2b ; §5 segment immédiat → Task 4 ; §6 capture + mode onboarding → Task 3 ; §7 étape Discord onboarding → Task 5. Tous couverts.
- **Placeholders** : aucun — chaque étape porte le code réel.
- **Type/nom consistency** : `resolveLocationSwitch`, `applyRoleTransition`, `switchDiscordLocation`, `refreshAppMenu`, `wireRoleControls`, `refreshHostAddrs(refs)`, `captureInto` employés de façon identique partout ; refs partagent les mêmes clés entre `MAIN_ROLE_REFS` et l'objet onboarding.
- **Piège évité** : `persist()` ne lit plus le rôle depuis le DOM (listeners `input`), sinon persister depuis l'onboarding écraserait `cfg.remote` avec les champs vides de la fenêtre.
</content>
