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

function render() {
  els.capShortcut.textContent = comboLabel(cfg.shortcut);
  for (const b of els.modeSeg.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.mode === cfg.mode);
  }
  els.delay.value = String(cfg.unmuteDelayMs);
  els.delayVal.textContent = String(cfg.unmuteDelayMs);
  if (document.activeElement !== els.rpcId) els.rpcId.value = cfg.discordRpc.clientId || '';
  if (document.activeElement !== els.rpcSecret) els.rpcSecret.value = cfg.discordRpc.clientSecret || '';
  renderRole();
}

// Reflect cfg.role / cfg.remote / cfg.hostListen into the "Où est Discord ?" card.
// 'host' takes priority in the UI: it's an add-on on top of "this machine", mutually
// exclusive with being a controller of a remote machine.
function renderRole() {
  const hosting = cfg.role === 'host';
  const controllerSelected = cfg.role === 'controller';
  for (const b of els.roleSeg.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.role === (controllerSelected ? 'controller' : 'local'));
  }
  els.controllerPanel.hidden = !controllerSelected;
  els.hostToggle.checked = hosting;
  els.hostPanel.hidden = !hosting;
  if (document.activeElement !== els.remoteHost) els.remoteHost.value = cfg.remote.host || '';
  if (document.activeElement !== els.remotePort) els.remotePort.value = String(cfg.remote.port || 8698);
  if (document.activeElement !== els.remoteCode) els.remoteCode.value = cfg.remote.pairingCode || '';
  if (document.activeElement !== els.hostPort) els.hostPort.value = String(cfg.hostListen.port || 8698);
  els.hostCode.value = cfg.hostListen.pairingCode || '';
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
  els.err.textContent = '';
  const res = await window.hush.saveConfig(cfg);
  if (!res.ok) {
    els.err.textContent = translateConfigError(res.error);
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
    if (r.state === 'connected') {
      els.remoteStatus.textContent = 'Connecté ✓'; els.remoteStatus.className = 'pill pill-ok';
      if (help) help.hidden = true;
    } else if (r.state === 'connecting') {
      els.remoteStatus.textContent = 'Connexion…'; els.remoteStatus.className = 'pill pill-warn';
      if (help) help.hidden = true;
    } else {
      els.remoteStatus.textContent = r.error ? `Échec : ${r.error}` : 'Hôte injoignable';
      els.remoteStatus.className = r.error ? 'pill pill-warn' : 'pill pill-off';
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
const STEPS = [
  {
    glyph: '🤫',
    title: 'Bienvenue dans Hush',
    body: `<p>Tu dictes déjà avec Wispr Flow en tenant un raccourci. Hush <strong>coupe ton micro Discord</strong> pendant que tu le tiens — tu relâches, ton micro revient. Personne ne t'entend dicter.</p>
      <p>3 minutes de réglage : les permissions macOS, la connexion à Discord, et ton raccourci. C'est parti.</p>`,
  },
  {
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
  {
    glyph: '🖥️',
    title: 'Discord sur un autre PC ? (optionnel)',
    body: `<p>Setup <strong>double PC</strong> — tu dictes ici mais Discord tourne sur une autre machine ? Hush sait couper ce Discord <strong>à distance</strong>, sur ton réseau local.</p>
      <ol>
        <li>Installe Hush aussi sur le PC qui a Discord, et coche <strong>« Cette machine héberge Discord »</strong> → il affiche une <strong>IP</strong> + un <strong>code d'appairage</strong>.</li>
        <li>Ici, dans <strong>« Où est Discord ? »</strong> (fenêtre principale), choisis <strong>Autre machine</strong>, recopie l'IP et le code, puis <strong>Connecter</strong>.</li>
      </ol>
      <div class="callout">Les deux machines doivent être sur le <strong>même réseau</strong> (même Wi-Fi/box). En simple PC, ignore cette étape.</div>`,
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

function renderStep() {
  const s = STEPS[obIndex];
  ob.steps.innerHTML = STEPS.map((_, i) => `<i class="${i <= obIndex ? 'done' : ''}"></i>`).join('');
  ob.body.innerHTML = `<span class="glyph">${s.glyph}</span><h3>${s.title}</h3>${s.body}`;
  if (typeof s.wire === 'function') s.wire(ob.body);
  ob.back.classList.toggle('hidden', obIndex === 0);
  ob.next.textContent = obIndex === STEPS.length - 1 ? 'Terminer' : 'Suivant';
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
  if (obIndex >= STEPS.length - 1) return closeOnboarding();
  obIndex++; renderStep();
});
ob.back.addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderStep(); } });
ob.skip.addEventListener('click', closeOnboarding);
els.openTuto.addEventListener('click', (e) => { e.preventDefault(); openOnboarding(2); });
els.replayTuto.addEventListener('click', (e) => { e.preventDefault(); openOnboarding(0); });

// ---- Init ----
async function init() {
  const brand = await window.hush.getBrand();
  els.name.textContent = brand.name;
  els.tagline.textContent = brand.tagline;
  document.title = brand.name;
  cfg = await window.hush.getConfig();
  render();
  wireRoleControls(MAIN_ROLE_REFS);
  if (cfg.role === 'host') refreshHostAddrs(MAIN_ROLE_REFS);
  refreshPermissions();
  setInterval(refreshPermissions, 2000);
  await initPermDrag(); // resolve drag availability before onboarding may render step 2

  let onboarded = false;
  try { onboarded = localStorage.getItem('hush.onboarded') === '1'; } catch { /* noop */ }
  if (!onboarded) openOnboarding(0);
}

init();
