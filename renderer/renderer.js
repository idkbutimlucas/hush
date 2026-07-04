'use strict';

const MOD_ORDER = ['ctrl', 'alt', 'cmd', 'shift'];
const MOD_SYMBOL = { ctrl: '⌃', alt: '⌥', cmd: '⌘', shift: '⇧' };

function comboLabel(combo) {
  if (!combo) return '—';
  const mods = MOD_ORDER.filter((m) => combo.mods.includes(m)).map((m) => MOD_SYMBOL[m]).join('');
  if (!combo.key) return mods || '—';
  return mods + combo.key.toUpperCase();
}

let cfg = null;
let armedField = null;

const $ = (id) => document.getElementById(id);
const els = {
  name: $('brand-name'),
  tagline: $('brand-tagline'),
  capShortcut: $('cap-shortcut'),
  modeSeg: $('mode-seg'),
  delay: $('delay'),
  delayVal: $('delay-val'),
  launchAtLogin: $('launch-at-login'),
  err: $('err'),
  save: $('save'),
  quit: $('quit'),
  accState: $('acc-state'),
  inputState: $('input-state'),
  openAcc: $('open-acc'),
  openInput: $('open-input'),
  statusDot: $('status-dot'),
  statusLabel: $('status-label'),
  rpcId: $('rpc-id'),
  rpcSecret: $('rpc-secret'),
  rpcState: $('rpc-state'),
  rpcError: $('rpc-error'),
  rpcReconnect: $('rpc-reconnect'),
  openTuto: $('open-tuto'),
  replayTuto: $('replay-tuto'),
  roleSeg: $('role-seg'),
  controllerPanel: $('controller-panel'),
  discoverBtn: $('discover-btn'),
  hostList: $('host-list'),
  remoteHost: $('remote-host'),
  remotePort: $('remote-port'),
  remoteCode: $('remote-code'),
  remoteConnect: $('remote-connect'),
  remoteStatus: $('remote-status'),
  hostToggle: $('host-toggle'),
  hostPanel: $('host-panel'),
  hostAddrs: $('host-addrs'),
  hostPort: $('host-port'),
  hostCode: $('host-code'),
  regenCodeBtn: $('regen-code-btn'),
};

// Show a user-facing error. When the onboarding modal is open its own #ob-err
// slot (which sits above the overlay) carries the message and the main window's
// #err is left blank; otherwise #err carries it.
function showError(msg) {
  const obErr = $('ob-err');
  const onboardingOpen = !!obErr && ob && ob.overlay && !ob.overlay.hidden;
  els.err.textContent = onboardingOpen ? '' : msg;
  if (obErr) { obErr.textContent = msg; obErr.hidden = !msg; }
}
function clearError() { showError(''); }

function render() {
  els.capShortcut.textContent = comboLabel(cfg.shortcut);
  for (const b of els.modeSeg.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.mode === cfg.mode);
  }
  els.delay.value = String(cfg.unmuteDelayMs);
  els.delayVal.textContent = String(cfg.unmuteDelayMs);
  els.launchAtLogin.checked = cfg.launchAtLogin;
  if (document.activeElement !== els.rpcId) els.rpcId.value = cfg.discordRpc.clientId || '';
  if (document.activeElement !== els.rpcSecret) els.rpcSecret.value = cfg.discordRpc.clientSecret || '';
  reflectRoleControls(els);
}

// Reflect cfg.role / cfg.remote / cfg.hostListen into a set of role controls —
// the main window (els) or the onboarding step's ob-* refs. Sibling of
// wireRoleControls(refs), which wires the same set's events. 'host' takes
// priority in the UI: it's an add-on on top of "this machine", mutually
// exclusive with being a controller of a remote machine.
function reflectRoleControls(refs) {
  const hosting = cfg.role === 'host';
  const controllerSelected = cfg.role === 'controller';
  for (const b of refs.roleSeg.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.role === (controllerSelected ? 'controller' : 'local'));
  }
  refs.controllerPanel.hidden = !controllerSelected;
  refs.hostToggle.checked = hosting;
  refs.hostPanel.hidden = !hosting;
  if (document.activeElement !== refs.remoteHost) refs.remoteHost.value = cfg.remote.host || '';
  if (document.activeElement !== refs.remotePort) refs.remotePort.value = String(cfg.remote.port || 8698);
  if (document.activeElement !== refs.remoteCode) refs.remoteCode.value = cfg.remote.pairingCode || '';
  if (document.activeElement !== refs.hostPort) refs.hostPort.value = String(cfg.hostListen.port || 8698);
  refs.hostCode.value = cfg.hostListen.pairingCode || '';
}

async function refreshHostAddrs(refs) {
  const info = await window.hush.lanInfo();
  refs.hostAddrs.textContent = info.addresses.length ? info.addresses.join(', ') : 'aucune IP LAN';
}

// Pull the RPC credentials out of whichever inputs are on screen into cfg.
function syncRpcInputs() {
  cfg.discordRpc = {
    clientId: els.rpcId.value.trim(),
    clientSecret: els.rpcSecret.value.trim(),
  };
}

// Arm a capture button, record the pressed combo into cfg[field], persist it,
// and refresh every button that shows this shortcut (window + onboarding).
async function captureInto(field, btnEl) {
  if (armedField) return; // one at a time
  armedField = field;
  clearError();
  btnEl.classList.add('armed');
  btnEl.textContent = 'Appuie…';

  const res = await window.hush.captureCombo();

  if (res.combo) {
    cfg[field] = res.combo;
    await persist();
  } else if (res.reason === 'unsupported') {
    showError('Touche non gérée — utilise une lettre, un chiffre ou F1–F24 (avec ⌃⌥⌘⇧ en option).');
  } else if (res.reason === 'timeout') {
    showError('Rien capté. Active « Surveillance de la saisie » pour Hush, puis relance l\'app.');
  }

  btnEl.classList.remove('armed');
  armedField = null;
  render();
  // Keep the onboarding button (if the tutorial is on the shortcut step) in sync.
  const obBtn = document.getElementById('ob-cap-shortcut');
  if (obBtn) obBtn.textContent = comboLabel(cfg.shortcut);
}

els.capShortcut.addEventListener('click', () => captureInto('shortcut', els.capShortcut));

els.modeSeg.addEventListener('click', (e) => {
  const m = e.target.dataset.mode;
  if (!m) return;
  cfg.mode = m;
  render();
});

els.delay.addEventListener('input', () => {
  cfg.unmuteDelayMs = Number(els.delay.value);
  els.delayVal.textContent = els.delay.value;
});

// Launch-at-login toggles the OS login item; persist immediately so it takes
// effect without needing the Save button.
els.launchAtLogin.addEventListener('change', async () => {
  cfg.launchAtLogin = els.launchAtLogin.checked;
  await persist();
});

// ---- Où est Discord ? (cross-machine role) ----
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

async function persist() {
  syncRpcInputs();
  clearError();
  const res = await window.hush.saveConfig(cfg);
  if (!res.ok) {
    showError(translateConfigError(res.error));
    return false;
  }
  cfg = res.config;
  return true;
}

// Map validateConfig's (English) error strings to a French message for the UI.
function translateConfigError(error) {
  if (error.includes('shortcut must have')) {
    return 'Choisis un vrai raccourci (au moins une touche ou un modificateur).';
  } else if (error.includes('host address')) {
    return "Renseigne l'adresse (IP) du PC qui héberge Discord.";
  } else if (error.includes('pairing code')) {
    return 'Renseigne un code d\'appairage.';
  } else if (error.includes('port')) {
    return 'Port invalide (doit être entre 1 et 65535).';
  }
  return error;
}

els.save.addEventListener('click', async () => {
  if (await persist()) {
    els.save.textContent = '✓ Enregistré';
    setTimeout(() => (els.save.textContent = 'Enregistrer'), 1200);
  }
});

// Connect / reconnect the Discord RPC. saveConfig auto-reconnects when the
// credentials changed; for an unchanged reconnect (e.g. after launching Discord)
// we force it explicitly.
async function connectRpc(idInput, secretInput) {
  const id = (idInput || els.rpcId).value.trim();
  const secret = (secretInput || els.rpcSecret).value.trim();
  const changed = id !== cfg.discordRpc.clientId || secret !== cfg.discordRpc.clientSecret;
  els.rpcId.value = id; els.rpcSecret.value = secret;
  if (!(await persist())) return;
  if (!changed) await window.hush.reconnectRpc();
}

els.rpcReconnect.addEventListener('click', () => connectRpc());

els.quit.addEventListener('click', () => window.hush.quit());
els.openAcc.addEventListener('click', () => window.hush.openAccessibility());
els.openInput.addEventListener('click', () => window.hush.openInputMonitoring());

// ---- Status + permissions ----
function setStatus(s) {
  if (!s.engineReady) {
    els.statusDot.className = 'dot warn';
    els.statusLabel.textContent = 'Permissions requises';
  } else if (s.active) {
    els.statusDot.className = 'dot active';
    els.statusLabel.textContent = 'Micro coupé';
  } else {
    els.statusDot.className = 'dot idle';
    els.statusLabel.textContent = 'Prêt';
  }
  setRpcPill(els.rpcState, s.rpc);
  const ob = $('ob-rpc-state');
  if (ob) setRpcPill(ob, s.rpc);
  // Surface the real reason a connection failed (esp. useful on Windows) instead
  // of a silent "Non connecté".
  if (els.rpcError) {
    if (s.rpc !== 'connected' && s.rpcError) {
      els.rpcError.textContent = `Discord : ${s.rpcError}`;
      els.rpcError.hidden = false;
    } else {
      els.rpcError.hidden = true;
    }
  }
  // Live remote-connection status (controller role) from the main process.
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
}

function setRpcPill(el, state) {
  if (!el) return;
  if (state === 'connected') { el.textContent = 'Connecté ✓'; el.className = 'pill pill-ok'; }
  else if (state === 'connecting') { el.textContent = 'Connexion…'; el.className = 'pill pill-warn'; }
  else { el.textContent = 'Non connecté'; el.className = 'pill pill-off'; }
}

window.hush.onStatus(setStatus);

function setPill(el, ok, label) {
  el.textContent = `${label} : ${ok ? 'OK' : 'à activer'}`;
  el.className = ok ? 'pill pill-ok' : 'pill pill-warn';
}

async function refreshPermissions() {
  if (!IS_MAC) return; // macOS-only TCC permissions; nothing to show elsewhere
  const p = await window.hush.getPermissions();
  setPill(els.accState, p.accessibility, 'Accessibilité');
  setPill(els.inputState, p.inputMonitoring, 'Surveillance de la saisie');
  const a = $('ob-acc'); if (a) setPill(a, p.accessibility, 'Accessibilité');
  const i = $('ob-input'); if (i) setPill(i, p.inputMonitoring, 'Surveillance de la saisie');
}

// macOS only, installed app only: let the user drag Hush straight into the
// Privacy list. Falls back silently to the "Ouvrir" buttons when unavailable.
let permCanDrag = false;
function wirePermDrag(el) {
  if (!el || el.dataset.wired) return;
  el.dataset.wired = '1';
  // Native file drag is started by the main process; prevent the default (which
  // would try to drag the <img> as a web image).
  el.addEventListener('dragstart', (e) => { e.preventDefault(); window.hush.startPermDrag(); });
}
async function initPermDrag() {
  try { permCanDrag = await window.hush.canDragPermissions(); } catch { permCanDrag = false; }
  const chip = $('perm-drag');
  if (chip && permCanDrag) { chip.hidden = false; wirePermDrag(chip); }
}

// ---- Onboarding tutorial ----
// macOS-only UI (TCC permissions) is meaningless on Windows/Linux — gate it.
const IS_MAC = !!(window.hush && window.hush.isMac);
const STEPS = [
  {
    glyph: '🤫',
    title: 'Bienvenue dans Hush',
    body: `<p>Tu dictes déjà avec Wispr Flow en tenant un raccourci. Hush <strong>coupe ton micro Discord</strong> pendant que tu le tiens — tu relâches, ton micro revient. Personne ne t'entend dicter.</p>
      <p>Quelques minutes de réglage : ${IS_MAC ? 'les permissions macOS, ' : ''}la connexion à Discord et ton raccourci. C'est parti.</p>`,
  },
  {
    macOnly: true,
    glyph: '🔐',
    title: 'Permissions macOS',
    body: `<p>Hush a besoin de deux autorisations pour repérer quand tu tiens ton raccourci.</p>
      <div class="perm-row"><span id="ob-acc" class="pill pill-warn">Accessibilité : à activer</span><button class="ghost" id="ob-open-acc">Ouvrir</button></div>
      <div class="perm-row"><span id="ob-input" class="pill pill-warn">Surveillance de la saisie : à activer</span><button class="ghost" id="ob-open-input">Ouvrir</button></div>
      <p style="margin-top:12px">Active <strong>Hush</strong> dans chaque volet. Si rien n'apparaît, l'entrée se crée dès le premier déclenchement.</p>
      <div class="perm-drag" data-permdrag hidden draggable="true" title="Glisse-moi dans la liste">
        <img src="../assets/generated/icon-256.png" alt="" width="40" height="40" />
        <div class="perm-drag-txt"><strong>Ou glisse Hush directement dans la liste</strong><span class="muted">Fais-moi glisser dans le volet ouvert, puis coche-moi.</span></div>
      </div>`,
    wire(root) {
      root.querySelector('#ob-open-acc').onclick = () => window.hush.openAccessibility();
      root.querySelector('#ob-open-input').onclick = () => window.hush.openInputMonitoring();
      const d = root.querySelector('[data-permdrag]');
      if (d && permCanDrag) { d.hidden = false; wirePermDrag(d); }
      refreshPermissions();
    },
  },
  {
    key: 'discord',
    glyph: '🎙️',
    title: 'Connecter Discord',
    body: `<p>Hush coupe Discord via son socket local — il te faut une petite app Discord (gratuit, 2 min) :</p>
      <ol>
        <li>Va sur <a class="link" id="ob-portal" href="#">discord.com/developers</a> → <strong>New Application</strong>.</li>
        <li>Menu <strong>OAuth2</strong> → copie le <strong>Client ID</strong> et un <strong>Client Secret</strong> (Reset Secret).</li>
        <li>Section <strong>Redirects</strong> → ajoute <code>http://localhost</code> puis <strong>Save</strong>.</li>
      </ol>
      <div class="callout">⚠️ Le <strong>redirect</strong> <code>http://localhost</code> est obligatoire — sans lui, la connexion échoue (« Missing redirect_uri »).</div>
      <div class="field"><label for="ob-rpc-id">Client ID</label><input id="ob-rpc-id" type="text" spellcheck="false" placeholder="123456789012345678" /></div>
      <div class="field"><label for="ob-rpc-secret">Client Secret</label><input id="ob-rpc-secret" type="password" spellcheck="false" placeholder="••••••••••••" /></div>
      <div class="row-actions"><button class="ghost" id="ob-connect">Connecter</button><span id="ob-rpc-state" class="pill pill-off">Non connecté</span></div>
      <p style="margin-top:10px">Discord doit être <strong>ouvert</strong>. Une popup d'autorisation apparaîtra → <strong>Authorize</strong>.</p>`,
    wire(root) {
      const id = root.querySelector('#ob-rpc-id');
      const secret = root.querySelector('#ob-rpc-secret');
      id.value = cfg.discordRpc.clientId || '';
      secret.value = cfg.discordRpc.clientSecret || '';
      root.querySelector('#ob-portal').onclick = (e) => { e.preventDefault(); window.hush.openExternal('https://discord.com/developers/applications'); };
      root.querySelector('#ob-connect').onclick = () => connectRpc(id, secret);
    },
  },
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
          <button type="button" data-mode="auto" class="active">Auto</button>
          <button type="button" data-mode="hold">Maintenir</button>
          <button type="button" data-mode="toggle">Bascule</button>
        </div>
      </div>
      <div class="callout">🎯 <strong>Auto</strong> (recommandé) détecte tout seul : tu <strong>tiens</strong> → push-to-talk ; tu <strong>double-tapes</strong> → mains-libres (Discord reste muet), un tap pour finir — comme Wispr. <strong>Maintenir</strong> : coupé tant que tu tiens. <strong>Bascule</strong> : 1er appui coupe, 2e réactive.</div>`,
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
      // Reflect current cfg into the freshly-rendered controls, then wire them.
      reflectRoleControls(refs);
      if (cfg.role === 'host') refreshHostAddrs(refs);
      wireRoleControls(refs);
    },
  },
  {
    glyph: '✅',
    title: 'Tout est prêt',
    body: `<p>Hush vit dans la <strong>barre de menus</strong> (en haut à droite). Tiens ton raccourci : Discord se coupe et Wispr dicte. Relâche : ton micro revient.</p>
      <p>Tu peux rouvrir ce tuto à tout moment via « Revoir le tuto ».</p>`,
  },
];

let obIndex = 0;
const ob = {
  overlay: $('onboarding'),
  steps: $('ob-steps'),
  body: $('ob-body'),
  back: $('ob-back'),
  next: $('ob-next'),
  skip: $('ob-skip'),
};

// The onboarding steps that apply to this platform (drops macOS-only steps
// elsewhere, so indices below are platform-relative — target steps by key).
const steps = STEPS.filter((s) => !s.macOnly || IS_MAC);

function renderStep() {
  const s = steps[obIndex];
  ob.steps.innerHTML = steps.map((_, i) => `<i class="${i <= obIndex ? 'done' : ''}"></i>`).join('');
  ob.body.innerHTML = `<span class="glyph">${s.glyph}</span><h3>${s.title}</h3>${s.body}`;
  if (typeof s.wire === 'function') s.wire(ob.body);
  ob.back.classList.toggle('hidden', obIndex === 0);
  ob.next.textContent = obIndex === steps.length - 1 ? 'Terminer' : 'Suivant';
}

function openOnboarding(index = 0) {
  obIndex = index;
  ob.overlay.hidden = false;
  renderStep();
}
function closeOnboarding() {
  ob.overlay.hidden = true;
  try { localStorage.setItem('hush.onboarded', '1'); } catch { /* noop */ }
}

ob.next.addEventListener('click', () => {
  if (obIndex >= steps.length - 1) return closeOnboarding();
  obIndex++; renderStep();
});
ob.back.addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderStep(); } });
ob.skip.addEventListener('click', closeOnboarding);
els.openTuto.addEventListener('click', (e) => {
  e.preventDefault();
  // Jump to the "Connect Discord" step by key — its index shifts by platform.
  openOnboarding(Math.max(0, steps.findIndex((s) => s.key === 'discord')));
});
els.replayTuto.addEventListener('click', (e) => { e.preventDefault(); openOnboarding(0); });

// ---- Init ----
async function init() {
  const brand = await window.hush.getBrand();
  els.name.textContent = brand.name;
  els.tagline.textContent = brand.tagline;
  document.title = brand.name;
  cfg = await window.hush.getConfig();
  render();
  wireRoleControls(els);
  if (cfg.role === 'host') refreshHostAddrs(els);
  // macOS-only permission panel: poll it live on Mac; hide it entirely elsewhere.
  const permCard = document.getElementById('perm-card');
  if (IS_MAC) {
    refreshPermissions();
    setInterval(refreshPermissions, 2000);
  } else if (permCard) {
    permCard.hidden = true;
  }
  await initPermDrag(); // resolve drag availability before onboarding may render step 2

  window.hush.onConfigUpdated((next) => {
    cfg = next;
    render();
    if (!ob.overlay.hidden) renderStep(); // keep an open tutorial step in sync
  });
  window.hush.onFocusLocation(() => {
    $('role-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  let onboarded = false;
  try { onboarded = localStorage.getItem('hush.onboarded') === '1'; } catch { /* noop */ }
  if (!onboarded) openOnboarding(0);
}

init();
