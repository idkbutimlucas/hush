# Resilient controller reconnect — design

## Problem

After the Mac (controller) sleeps and wakes, the LAN link to the Windows host
stops working and never recovers until Hush is restarted, even though the link
itself is healthy.

Root cause (confirmed by debugging, not guessed):

- The wire link is fine after wake — a manual `hello`/`welcome` handshake against
  the live host succeeds (`welcome, v:1`), the pairing code is accepted, the host
  port is open, and `PROTOCOL_VERSION` is identical on both sides (always `1`).
  So it is **not** a version, network, firewall, or pairing-code problem.
- The controller (`RemoteDiscordMuter`) has **no liveness detection of its own**:
  it only replies to the host's pings, never pings the host, and never times out
  a silent link. A sleep that kills the network without a clean FIN leaves the
  client socket half-open: `state === 'connected'` but dead, so `onClose` never
  fires and the existing 3 s reconnect loop never starts.
- There is **no wake handling** anywhere (`powerMonitor` is not used), so nothing
  proactively re-establishes links on resume.

## Goals

- The controller recovers the link automatically after sleep/wake and after any
  silent link death (Wi-Fi drop, router reboot), without a manual restart.

## Non-goals (YAGNI)

- Re-initialising the Discord RPC connection on resume. That concerns the host
  (Windows) side and is a separate issue. Noted as a possible follow-up.

## Design

Two complementary mechanisms — a generic liveness heartbeat plus an OS-level
fast path.

### 1. Controller-side heartbeat — `src/mute-client.ts`

`RemoteDiscordMuter` gains a self-heartbeat symmetric to the host's
(`src/mute-transport.ts` already pings clients and terminates dead ones):

- After `welcome` (state → `connected`), start an interval.
- Each tick: if the previous tick's `pong` did **not** arrive → dead link →
  `sock.close()`. That fires the existing `onClose`, which schedules the
  reconnect (3 s) — reconnect logic is unchanged.
- Otherwise, send `{ t: 'ping' }` and arm "awaiting pong".
- Handle inbound `pong` (currently unhandled) → mark the link alive. The host
  already replies `pong` to client pings (`src/mute-server.ts:64`), so the host
  needs no change.
- The interval timer is **injectable** for tests, mirroring the existing
  `schedule` param: a new optional constructor param
  `heartbeat(tick) => cancel`, defaulting to `setInterval`/`clearInterval`.
- Teardown: `cancel` the heartbeat on `onClose` and on `disconnect()`; every tick
  is guarded by `this.sock !== sock` so a stale socket's tick is a no-op.

Result: a dead link is detected within one heartbeat cycle (~5 s) with no
dependency on OS events.

`HEARTBEAT_MS` is exported from `src/mute-protocol.ts` (value `5000`) so both
sides share one cadence; `src/mute-transport.ts` (the ws transport, which holds
the host-side heartbeat) reuses it instead of its own local copy.

### 2. Wake hook — `src/main.ts`

A fast path that does not wait for a heartbeat cycle:

```js
powerMonitor.on('resume', () => {
  dbg('power: resume — re-establishing links');
  connectRemote();                       // no-op unless controller; disconnect()+connect()
  if (cfg.role === 'host') startHost();  // restart listener + re-advertise mDNS
});
```

`connectRemote()` and `startHost()` already exist and are idempotent
(`connectRemote` disconnects first and returns early unless role is controller;
`startHost` calls `stopHost` first). Restarting the host also re-announces mDNS,
which commonly dies across sleep.

### 3. Tests — `tests/mute-client.test.ts`

Using the existing `FakeClientSocket` + injected fake `schedule` and fake
`heartbeat`:

- After `welcome`, a tick sends a `ping`.
- `pong` received → link survives the next tick (a second `ping` is sent, socket
  not closed).
- `pong` missing before the next tick → the tick closes the socket and a
  reconnect is scheduled.
- `disconnect()` cancels the heartbeat (no further ticks/pings).

The `powerMonitor` handler stays a thin one-liner delegating to already-tested
`connectRemote`/`startHost`, so it needs no Electron test — verified manually via
the sleep/wake repro.

## Files touched

- `src/mute-protocol.ts` — export `HEARTBEAT_MS`.
- `src/mute-transport.ts` — import shared `HEARTBEAT_MS` instead of the local const.
- `src/mute-client.ts` — heartbeat + `pong` handling + injectable timer.
- `src/main.ts` — `powerMonitor.on('resume', …)` handler + import.
- `tests/mute-client.test.ts` — heartbeat tests.

## Error handling

- Every tick guarded by `this.sock !== sock` (ignore stale sockets).
- Sends already guard `readyState === OPEN` (`src/mute-transport.ts`), so a send
  on a dying socket is a safe no-op.
- `cancel` the heartbeat on every teardown path to avoid leaked intervals.
