# Cross-machine Discord muting (dual-PC setup)

**Date:** 2026-07-03
**Status:** Design — approved, pending implementation plan
**Author:** brainstormed with Claude

## Problem

Hush mutes Discord over its **local** RPC/IPC socket (`transport: 'ipc'` in
`src/discord-mute.ts`). That socket only exists on the machine where Discord runs.

In a **dual-PC setup**, the user dictates (Wispr Flow + Hush) on one machine (e.g.
a Mac) while Discord runs on a **separate** machine (e.g. a Windows PC). Today Hush
cannot reach that remote Discord, so holding the dictation shortcut does not mute
the call on the other PC.

Goal: while the shortcut is held on the dictation machine, mute Discord on the
**other** machine; unmute on release. Must generalize to any OS pair (Mac+Win,
2×Win, 2×Mac, …).

## Constraints & decisions

- Both machines are on the **same LAN** (confirmed). No cloud relay — stays true to
  the project's "local & private" ethos.
- A small companion running on the Discord machine is acceptable.
- **Chosen approach: A — Hush dual-role, direct WebSocket over LAN.** The same Hush
  app runs on both machines in different roles. Rejected: B (separate headless
  companion — second per-OS artifact to build/ship/maintain) and C (cloud relay —
  needs a server, breaks local/private, unnecessary on same LAN).

## Architecture

### Roles

A new config field `role: 'local' | 'host' | 'controller'` (default `'local'`):

- **`local`** *(default, current behavior)* — shortcut here mutes Discord on this
  machine. **Zero regression** for existing users.
- **`controller`** — shortcut here sends a mute/unmute command to the remote host;
  no local Discord RPC.
- **`host`** — no shortcut listener; receives commands over the LAN and mutes the
  Discord running on **this** machine via the existing RPC path.

### The seam

The existing `DiscordMuter` interface (`src/types.ts`) is the clean seam. The
`Orchestrator` only calls `muter.setMute(on)` and never learns what is behind it.

- **host** keeps `DiscordRpcMuter` **unchanged**.
- **controller** gets a new `RemoteDiscordMuter implements DiscordMuter` that sends
  the command over WebSocket instead of talking to a local RPC socket. **The
  orchestrator does not change.**

### New components

- **`src/mute-protocol.ts`** — versioned message types + (de)serialization.
  Messages: `hello { v, pairingCode }`, `welcome { v }`, `reject { reason }`,
  `mute { on: boolean }`, `ping` / `pong` (heartbeat).
- **`src/mute-server.ts`** *(host)* — WebSocket server on the LAN (default port
  `8698`, configurable; bound to local interfaces). Verifies `pairingCode` on
  connect (`welcome`/`reject`). On `mute {on}` calls the local `DiscordRpcMuter`. It
  only depends on the `DiscordMuter` interface → testable with a fake muter.
- **`src/mute-client.ts`** exporting `RemoteDiscordMuter implements DiscordMuter`
  *(controller)* — maintains a WS connection to the host with **auto-reconnect** +
  heartbeat. `setMute(on)` sends the frame; if disconnected it is a logged no-op
  (like the current RPC muter when Discord is closed) and surfaces state/error to
  the UI. On reconnect it **re-asserts the current desired state**.
- **`src/discovery.ts`** *(optional, plug & play)* — mDNS/Bonjour via
  `bonjour-service` (pure JS, no native dep). Host advertises `_hush._tcp`
  (IP+port); controller browses and lists found hosts so the user need not type an
  IP. Loaded lazily and never blocking — on failure, fall back to manual IP entry.

### Data flow (controller → host)

```
[dictation machine] shortcut held
   → input-engine detects (unchanged)
   → orchestrator.setMute(true) (unchanged)
   → RemoteDiscordMuter.setMute(true)
   → WS: { mute: on=true } ─────LAN────►  [Discord machine] mute-server
                                              → DiscordRpcMuter.setMute(true)
                                              → Discord mutes
   ... released → same path with on=false → Discord unmutes
```

### Dependencies added

- `ws` — WebSocket (pure JS).
- `bonjour-service` — mDNS discovery (pure JS, optional).

No new native dependencies → Windows/Mac builds stay simple.

## Config

Extend `HushConfig` (`src/config.ts` / `src/types.ts` / `src/store.ts`):

- `role: 'local' | 'host' | 'controller'` — default `'local'`.
- `remote: { host: string; port: number; pairingCode: string }` — controller side.
- `hostListen: { port: number; pairingCode: string }` — host side.
- **Migration:** existing configs get `role: 'local'`, reusing `store.ts`'s existing
  migration logic → existing users see no change.

## UX

One screen added to onboarding + settings.

**"Where is Discord?"**
- **On this machine** → `local`. Current RPC flow, unchanged.
- **On another machine** → `controller`. Show mDNS-discovered hosts (or manual
  `IP:port`), paste/confirm the **pairing code**, **Connect** button, with a live
  status indicator (connected / host unreachable / code rejected).

Separate toggle on the Discord machine:

**"This machine hosts Discord for another device"** → enables `host`. The screen
shows this machine's **LAN IP**, the **port**, and a generated **pairing code**
(regenerate button). The user copies these into the controller. The host also
connects to the local Discord RPC in parallel (existing flow).

Roles stay watertight: one role = one path (host runs no shortcut listener /
orchestrator) — simpler to reason about and test.

## Fail-safe & security

**Fail-safe (never leave the user muted on the other PC):**
- Link drops while muted → the host **auto-unmutes** after a short grace period
  (missed heartbeats). No stuck-muted state if the controller crashes, sleeps, or
  loses Wi-Fi.
- Reconnect → controller **re-asserts the current desired state** (real
  held/released state at that moment). No desync.
- Host unreachable on the controller → `setMute` is a logged no-op (like the current
  RPC muter when Discord is closed); UI shows "host unreachable". Dictation still
  works.
- Discord RPC drops on the host → same as today (existing reconnect logic in
  `DiscordRpcMuter`).

**Security (LAN-trust, matching the project's local & private stance):**
- Mandatory **pairing code** in `hello`; host rejects connections without the right
  code (prevents another LAN device muting by accident/malice).
- Bound to local interfaces only; no ports opened to the internet, no cloud, no
  UPnP.
- Pairing code stored locally via `electron-store`.
- Documented as LAN-trust: not an end-to-end-encrypted channel (overkill for muting
  Discord on your own network). Off-LAN would be approach C (relay) — out of scope.

## Testing

Keeps the project's philosophy: core logic tested against fakes, no real
OS/keyboard/Discord.

- **`mute-protocol`** — round-trip encode/decode of each message; reject malformed /
  version-incompatible frames.
- **`mute-server`** (fake `DiscordMuter` + fake socket):
  - `hello` with correct code → `welcome`; wrong code → `reject`, no mute;
  - `mute {on}` relayed → calls `DiscordMuter.setMute(on)`;
  - **auto-unmute on disconnect** when a muted controller vanishes (the fail-safe);
  - missed heartbeat → link treated as dead.
- **`mute-client` / `RemoteDiscordMuter`** (fake socket):
  - `setMute(on)` sends the right frame;
  - clean no-op when disconnected (no throw);
  - **reconnect → re-asserts current desired state**;
  - state/error exposed correctly for the UI.
- **Existing tests unchanged:** the `Orchestrator` still targets the `DiscordMuter`
  interface → its tests pass as-is, proving `local`-path non-regression. Same for
  `discord-mute`, `trigger-detector`, `config` (add cases for the new fields + the
  `role: 'local'` migration).

Not unit-tested (assumed): real mDNS, real network sockets, real Discord RPC —
validated manually on a Mac↔Windows setup.

## Out of scope

- Off-LAN / cross-network operation (would be approach C, a cloud/relay broker).
- End-to-end encryption of the LAN link.
- A machine acting as host **and** controller simultaneously.
- A headless (non-Electron) host build (approach B) — possible later if Electron's
  footprint on the gaming PC becomes a concern.
