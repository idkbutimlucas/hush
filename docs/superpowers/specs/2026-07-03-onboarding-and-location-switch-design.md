# Onboarding interactif + switch d'emplacement Discord

## Contexte

Hush coupe le micro Discord pendant qu'on dicte avec Wispr Flow. Deux manques de
finition dans l'expérience actuelle :

1. **L'onboarding est en partie descriptif.** Les étapes « Ton raccourci »
   (`renderer.js` `STEPS[3]`) et « Discord sur un autre PC ? » (`STEPS[4]`)
   *expliquent* quoi faire mais renvoient à la fenêtre principale au lieu de
   laisser configurer sur place. L'utilisateur doit sortir du tuto pour agir.

2. **Basculer entre Discord local et Discord distant n'est pas immédiat.** Le
   segment « Où est Discord ? » existe dans la fenêtre, mais changer de rôle
   n'est pris en compte qu'à l'enregistrement, et il n'y a aucun moyen de
   basculer sans ouvrir la fenêtre. Or on n'est pas toujours en double PC : on
   veut flipper local ↔ distant en un geste.

La config distante (`cfg.remote` : IP/port/code) est **déjà persistée** quel que
soit le rôle (via `store.ts` / `saveConfig`), donc une bascule est sans perte —
il ne manque que la surface pour la déclencher facilement.

## Objectifs

- Rendre l'onboarding **interactif** : capturer le raccourci et configurer
  l'emplacement de Discord (local / autre machine / cette machine héberge)
  directement dans le tuto, avec parité complète avec la fenêtre principale.
- Offrir un switch local ↔ distant **rapide sur 3 surfaces** : le segment de la
  fenêtre (bascule immédiate), le menu du tray, et le menu du haut macOS
  (application menu).
- Ne rien perdre en basculant : réutiliser `cfg.remote` mémorisé.

## Hors scope

- Finitions cosmétiques Windows (icône de tray monochrome, masquage de la carte
  Permissions hors macOS) — traitées plus tard (`docs/WINDOWS.md`).
- Toute modification du protocole de mute cross-machine (déjà en place).

## Architecture

### Vue d'ensemble

```
Fenêtre (renderer.js)        Tray (main.ts)         Menu macOS (main.ts)
   segment role-seg    ┐         radio            ┐        radio Discord
   segment ob-role-seg ┤──IPC──▶ switch  ──┐      ┤──────▶ switch
   (persist immédiat)  ┘                   │      ┘
                                           ▼
                              switchDiscordLocation(role)   [main.ts]
                                           │
                                  resolveLocationSwitch()   [src/location-switch.ts, pur/testé]
                                           │
                          { role } ──▶ saveConfig + applyConfig + teardown/bring-up
                          { needsConfig } ──▶ showWindow (carte « Où est Discord ? »)
                                           │
                              refreshTray + refreshAppMenu + pushStatus
```

### 1. Module pur de décision — `src/location-switch.ts` (nouveau)

Isole la seule règle métier testable de la bascule, sans dépendance Electron.

```ts
export type LocationTarget = 'local' | 'controller';

export type SwitchDecision =
  | { role: 'local' | 'controller' }
  | { needsConfig: true };

// Décide ce que doit faire une demande de bascule vers `target`.
// - 'local' est toujours applicable.
// - 'controller' n'est applicable que si une config distante utilisable existe
//   déjà (host + pairingCode) ; sinon il faut ouvrir la fenêtre pour la saisir.
export function resolveLocationSwitch(
  target: LocationTarget,
  hasRemoteConfig: boolean,
): SwitchDecision {
  if (target === 'local') return { role: 'local' };
  return hasRemoteConfig ? { role: 'controller' } : { needsConfig: true };
}
```

`hasRemoteConfig` est calculé par l'appelant :
`Boolean(cfg.remote.host && cfg.remote.pairingCode)`.

### 2. Transition de rôle partagée — `main.ts`

Le handler `config:set` contient aujourd'hui inline la séquence
teardown/bring-up (disconnect Discord, `connectRemote`, `startHost`, reconnect
selon le rôle). On l'extrait en une fonction réutilisée par les 3 surfaces :

```ts
// Applique la transition d'un `prev` config vers un `saved` config déjà
// enregistré : arme l'input (applyConfig) puis met en place les ressources
// cross-machine (host relay / remote client / RPC local) selon le nouveau rôle.
function applyRoleTransition(prev: HushConfig, saved: HushConfig): void { … }
```

`config:set` appelle désormais `saveConfig` puis `applyRoleTransition(prev, saved)`.

Nouvelle entrée pour tray + menu macOS :

```ts
// Bascule rapide déclenchée hors fenêtre (tray / menu macOS).
function switchDiscordLocation(target: 'local' | 'controller'): void {
  const decision = resolveLocationSwitch(
    target,
    Boolean(cfg.remote.host && cfg.remote.pairingCode),
  );
  if ('needsConfig' in decision) {
    showWindow();               // l'utilisateur saisit l'IP/code dans la carte
    win?.webContents.send('focus-location'); // scroll/anime la carte (optionnel)
    return;
  }
  if (decision.role === cfg.role) return; // déjà dans cet état
  const prev = cfg;
  const saved = saveConfig({ ...cfg, role: decision.role });
  applyConfig(saved);
  applyRoleTransition(prev, saved);
  refreshTrayMenu();
  refreshAppMenu();
  win?.webContents.send('config-updated', saved); // resync la fenêtre si ouverte
}
```

Note : la bascule est limitée à `local` ↔ `controller`. Le rôle `host` (cette
machine héberge Discord pour un contrôleur distant) n'est pas une destination du
switch rapide — il se configure/désactive dans la fenêtre ou l'onboarding.
Quand `cfg.role === 'host'`, aucun des deux radios n'est coché ; cliquer l'un
d'eux applique la bascule normalement (quitte le rôle host).

### 3. Menu du tray — `refreshTrayMenu()`

Ajout de deux items radio, sous une ligne d'en-tête « Discord » :

```
Hush — ○ Prêt
──────────────
Raccourci : ⌃⌥…            (disabled, existant)
Mode : Maintenir           (disabled, existant)
Discord : connecté ✓       (disabled, existant)
──────────────
Emplacement de Discord
  ● Cette machine                         (radio, checked si role==='local')
  ○ Autre machine — 192.168.1.20          (radio, checked si role==='controller')
──────────────
Réglages…
Quitter Hush
```

- Le label « Autre machine — … » affiche `cfg.remote.host` si présent, sinon
  « à configurer ».
- `type: 'radio'` + `checked` selon `cfg.role`. `click` → `switchDiscordLocation('local' | 'controller')`.

### 4. Menu du haut macOS — `refreshAppMenu()` (nouveau)

Aujourd'hui aucun `Menu.setApplicationMenu` (app menubar, dock caché). On ajoute
un menu applicatif **darwin uniquement** ; hors darwin on laisse le comportement
actuel (`Menu.setApplicationMenu(null)` implicite).

```
Hush          À propos de Hush · Quitter Hush (⌘Q)
Édition       Annuler/Rétablir · Couper · Copier · Coller · Tout sélectionner   (roles standard)
Discord       ◉ Cette machine · ◯ Autre machine    · ──  · Réglages…
```

- Le menu **Édition** utilise les `role:` standards d'Electron — **indispensable**
  pour que ⌘C/⌘V fonctionnent dans les champs (coller le Client ID/Secret).
- Le menu **Discord** contient deux items `type: 'radio'` mappés sur
  `switchDiscordLocation`, cochés selon `cfg.role`, plus « Réglages… » → `showWindow`.
- `refreshAppMenu()` est rappelé à chaque changement de config/rôle pour que la
  coche suive l'état (comme `refreshTrayMenu`).

### 5. Segment fenêtre — bascule immédiate (`renderer.js`)

Le handler de `role-seg` persiste désormais **tout de suite** au lieu d'attendre
« Enregistrer » :

- Clic sur **Cette machine** (`local`) → `cfg.role='local'` puis `persist()`
  immédiat : la bascule prend effet sans autre geste.
- Clic sur **Autre machine** (`controller`) → révèle le panneau ; persiste
  immédiatement **seulement si** `cfg.remote.host` et `cfg.remote.pairingCode`
  sont déjà connus (retour vers un distant déjà appairé → reconnexion instantanée).
  Sinon on attend que l'utilisateur remplisse et clique « Connecter » (inchangé).

Le statut live (`setStatus`) reflète déjà l'état ; rien à ajouter côté feedback.

Nouveau canal `config-updated` (main → renderer) : quand le rôle est basculé
depuis le tray/menu alors que la fenêtre est ouverte, la fenêtre se resynchronise
(`cfg = payload; render();`).

### 6. Onboarding — capture du raccourci + mode (`STEPS[3]`)

L'étape « Ton raccourci » gagne **deux** choses : un bouton de capture réel, et
un sélecteur de **mode** (Maintenir / Bascule) avec une explication courte —
parce que le piège n°1 en usage réel est de taper la touche (appui bref) alors
que Hush est en « Maintenir », si bien que Discord n'est coupé qu'une fraction de
seconde au lieu de toute la dictée. Le tuto doit rendre ce choix explicite :

- **Maintenir** : Discord est coupé **tant que la touche est tenue**.
- **Bascule** : **1er appui** coupe (et reste coupé), **2e appui** réactive.
- Consigne : choisir **le même mode que l'usage de Wispr Flow** (tap → Bascule ;
  maintien → Maintenir).

Le segment de mode `ob-mode-seg` reprend le style du segment « Comportement » de
la fenêtre, écrit dans `cfg.mode` et persiste immédiatement ; `render()` garde le
segment de la fenêtre synchronisé.

Bouton de capture réel :

```html
<div class="binding">
  <div class="binding-label"><strong>Push-to-talk</strong>
    <span class="muted">identique à Wispr → Réglages → Raccourcis</span></div>
  <button class="capture" id="ob-cap-shortcut">⌃⌥</button>
</div>
```

Refactor de la capture : `startCapture(field)` référence aujourd'hui un objet
`CAP` figé (`{ shortcut: els.capShortcut }`). On la généralise pour accepter
**l'élément bouton cible** :

```js
async function captureInto(field, btnEl) { … } // arme btnEl, appelle captureCombo,
                                               // set cfg[field], persist, re-render
```

Les deux boutons (`cap-shortcut` fenêtre et `ob-cap-shortcut` onboarding)
appellent `captureInto('shortcut', el)`. Au succès : `cfg.shortcut` mis à jour,
`persist()`, puis mise à jour du **libellé des deux boutons** (`render()` couvre
la fenêtre ; le `wire()` de l'étape rafraîchit le bouton onboarding).

### 7. Onboarding — emplacement de Discord (`STEPS[4]`)

L'étape devient une réplique compacte de la carte « Où est Discord ? », avec des
IDs préfixés `ob-` (même pattern que les permissions et le RPC déjà dupliqués
dans l'onboarding). Contenu, avec **parité complète** (host inclus) :

- Segment `ob-role-seg` : **Cette machine** / **Autre machine**.
- Panneau contrôleur `ob-controller-panel` (si Autre machine) :
  `ob-discover-btn` → `ob-host-list`, champs `ob-remote-host` / `ob-remote-port`
  / `ob-remote-code`, bouton `ob-remote-connect`, pastille `ob-remote-status`.
- Toggle `ob-host-toggle` « Cette machine héberge Discord » + panneau
  `ob-host-panel` : `ob-host-addrs`, `ob-host-port`, `ob-host-code`,
  `ob-regen-code-btn`.
- Le callout « même réseau / installe Hush sur les deux PC » est conservé.

**Réutilisation, pas duplication de logique** : on extrait le câblage du panneau
rôle en une fonction qui prend un *jeu d'éléments* (fenêtre ou `ob-`) :

```js
// Câble un ensemble de contrôles rôle (segment, discover, champs remote/host,
// toggle host) sur les handlers partagés persist()/discoverHosts()/genCode().
function wireRoleControls(refs) { … }
```

`refs` regroupe les éléments par ID ; on l'instancie une fois pour la fenêtre
(IDs actuels) et une fois par rendu de l'étape onboarding (IDs `ob-`). Les
handlers existants (`roleSeg` click, `hostToggle` change, `discover`,
`remoteConnect`, `regenCode`) sont déplacés dans `wireRoleControls` et
paramétrés par `refs` au lieu de fermer sur `els` globaux.

`setStatus` est étendu pour mettre à jour aussi `ob-remote-status` /
`ob-rpc-state` (déjà fait pour le RPC) quand ces éléments existent, afin que la
connexion distante affiche son état live dans le tuto.

## Modèle de données

Aucun changement de schéma. `HushConfig` (`src/types.ts`) reste identique. La
bascule ne fait que passer `cfg.role` entre `'local'` et `'controller'`, en
s'appuyant sur `cfg.remote` déjà persisté. Aucune migration `store.ts`.

## Flux de données clés

**Bascule depuis le tray/menu (fenêtre fermée)**
`click radio → switchDiscordLocation('controller') → resolveLocationSwitch →
{role} → saveConfig → applyConfig → applyRoleTransition (connectRemote) →
refreshTray/refreshAppMenu`.

**Bascule vers distant non configuré**
`click radio → switchDiscordLocation('controller') → resolveLocationSwitch →
{needsConfig} → showWindow + focus-location` (l'utilisateur saisit puis Connecter).

**Bascule depuis la fenêtre**
`click role-seg[local] → cfg.role='local' → persist() → IPC config:set →
saveConfig + applyRoleTransition → pushStatus + refreshTray/refreshAppMenu`.

**Capture raccourci dans l'onboarding**
`click ob-cap-shortcut → captureInto('shortcut', el) → captureCombo() →
cfg.shortcut=combo → persist() → maj libellé des 2 boutons`.

## Gestion d'erreurs

- **Bascule vers distant sans config** : pas d'échec silencieux — on ouvre la
  fenêtre sur la carte, l'utilisateur voit quoi remplir.
- **`validateConfig` en distant** : inchangé — `saveConfig` throw si host/code
  manquants ; mais `switchDiscordLocation` ne tente `controller` que si
  `hasRemoteConfig`, donc le throw ne survient pas depuis le switch rapide.
- **Persist échoue depuis le segment fenêtre** : réutilise le chemin d'erreur
  existant (`translateConfigError`, `els.err`).
- **Capture annulée/timeout dans l'onboarding** : mêmes messages que la fenêtre.
- **Discord/host pas prêt** : la reconnexion best-effort existante (retry 15 s,
  `setOnDrop`) couvre déjà ces cas ; le switch ne change rien.

## Tests

- **`tests/location-switch.test.ts` (nouveau, unitaire)** — table de vérité de
  `resolveLocationSwitch` :
  - `('local', false)` → `{role:'local'}`
  - `('local', true)` → `{role:'local'}`
  - `('controller', true)` → `{role:'controller'}`
  - `('controller', false)` → `{needsConfig:true}`
- **Régression** : `npm test` (config, orchestrator, mute-*, discord-oauth,
  mac-drag) doit rester vert — la refacto `applyRoleTransition` ne change pas le
  comportement observable de `config:set`.
- **`npm run typecheck`** vert.
- **Manuel (mono-PC, Mac)** :
  - Onboarding : capturer le raccourci dans l'étape, vérifier qu'il apparaît
    aussi dans la fenêtre.
  - Segment fenêtre : local ↔ (distant déjà appairé) bascule instantanée.
  - Tray + menu du haut : les radios cochent le bon état et basculent ;
    « Autre machine » sans config ouvre la fenêtre.
- **Manuel (double PC, host Windows)** : suivre le flux end-to-end
  (host Windows via `npm start`, controller Mac) et vérifier le mute distant,
  puis la bascule distant → local → distant sans re-saisie.

## Notes d'implémentation / refactors

- `main.ts` : extraire `applyRoleTransition`, ajouter `switchDiscordLocation`,
  `refreshAppMenu`, brancher les radios dans `refreshTrayMenu`, émettre
  `config-updated` / `focus-location`. Exposer `focus-location` via `preload.ts`
  (`onFocusLocation`) et `config-updated` (`onConfigUpdated`).
- `renderer.js` : généraliser la capture (`captureInto`), extraire
  `wireRoleControls(refs)`, instancier pour la fenêtre et pour l'étape
  onboarding, étendre `setStatus` aux éléments `ob-`.
- `index.html` : ajouter le bouton `ob-cap-shortcut` n'est pas nécessaire (le
  markup des étapes vit dans `renderer.js` `STEPS`), donc les nouveaux éléments
  onboarding sont ajoutés dans les templates `STEPS[3]`/`STEPS[4]`.
- `preload.ts` : ajouter les deux nouveaux canaux entrants.
- Garder le style existant (segments `.segment`, pastilles `.pill`, `.capture`).
</content>
</invoke>
