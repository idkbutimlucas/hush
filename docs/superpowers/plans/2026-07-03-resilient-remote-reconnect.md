# Resilient Controller Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Hush controller re-establish its LAN link to the host automatically after sleep/wake and after any silent link death, without a manual restart.

**Architecture:** Two complementary mechanisms. (1) A controller-side heartbeat in `RemoteDiscordMuter` that pings the host and, on a missed pong, closes the socket so the existing 3 s reconnect loop fires. (2) A `powerMonitor.on('resume')` handler in `main.ts` that proactively re-establishes links on wake. The host already pings clients and replies pong to client pings, so no host-side change is needed.

**Tech Stack:** TypeScript, Electron (`powerMonitor`), `ws`, Vitest.

## Global Constraints

- Runtime: TypeScript compiled with `tsc` (`npm run typecheck` must stay green).
- Tests: Vitest, run with `npm test` (`vitest run`).
- Timers in `RemoteDiscordMuter` must be injectable (like the existing `schedule` param) so tests never rely on real `setInterval`.
- Do not change the wire protocol or the host (`mute-server.ts`, `net.ts` behavior). `PROTOCOL_VERSION` stays `1`.
- Follow existing code style: terse comments explaining *why*, `dbg(...)` for tracing.

---

### Task 1: Share HEARTBEAT_MS via the protocol module

**Files:**
- Modify: `src/mute-protocol.ts` (add export near the other consts, ~line 6-8)
- Modify: `src/net.ts:5` (remove local const, import shared one)

**Interfaces:**
- Produces: `export const HEARTBEAT_MS = 5000;` from `src/mute-protocol.ts`.

- [ ] **Step 1: Export the constant from the protocol module**

In `src/mute-protocol.ts`, add below `export const MDNS_SERVICE_TYPE = 'hush';`:

```ts
// Liveness cadence shared by both sides: ping this often, and treat a link that
// misses a full interval's pong as dead.
export const HEARTBEAT_MS = 5000;
```

- [ ] **Step 2: Consume it in net.ts**

In `src/net.ts`, change the import on line 2 to add `HEARTBEAT_MS`:

```ts
import { ClientSocket, ClientSocketFactory, DuplexSocket, ServerListener, HEARTBEAT_MS } from './mute-protocol';
```

Then delete the local declaration on line 5 (`const HEARTBEAT_MS = 5000; // ping every 5s; terminate a socket that misses a pong`). The rest of the file already references `HEARTBEAT_MS` and now resolves to the import.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full test suite (no behavior change expected)**

Run: `npm test`
Expected: PASS (same as before).

- [ ] **Step 5: Commit**

```bash
git add src/mute-protocol.ts src/net.ts
git commit -m "refactor(net): share HEARTBEAT_MS from the protocol module"
```

---

### Task 2: Controller-side heartbeat with reconnect on missed pong

**Files:**
- Modify: `src/mute-client.ts`
- Test: `tests/mute-client.test.ts`

**Interfaces:**
- Consumes: `HEARTBEAT_MS` from `src/mute-protocol.ts` (Task 1).
- Produces: `RemoteDiscordMuter` constructor gains an optional third param
  `heartbeat: (tick: () => void) => (() => void)` (returns a cancel fn),
  defaulting to a real `setInterval`/`clearInterval` pair.

- [ ] **Step 1: Write the failing tests**

In `tests/mute-client.test.ts`, replace the existing `connected()` helper (the function starting `function connected() {`) with this version that injects a controllable fake heartbeat:

```ts
function connected() {
  const sockets: FakeClientSocket[] = [];
  const factory = () => { const s = new FakeClientSocket(); sockets.push(s); return s; };
  const scheduled: Array<() => void> = [];
  const ticks: Array<() => void> = [];
  let hbCancels = 0;
  const heartbeat = (tick: () => void) => { ticks.push(tick); return () => { hbCancels += 1; }; };
  const muter = new RemoteDiscordMuter(factory, (fn) => { scheduled.push(fn); }, heartbeat);
  muter.connect('192.168.1.20', 8698, 'ABC123');
  const s = sockets[0];
  s.fireOpen();                                   // controller sends hello
  s.fireMessage(encode({ t: 'welcome', v: PROTOCOL_VERSION }));
  return { muter, sockets, scheduled, ticks, factory, heartbeatCancels: () => hbCancels };
}
```

Then add these tests inside the `describe('RemoteDiscordMuter', () => { ... })` block:

```ts
it('pings the host on a heartbeat tick once connected', () => {
  const { sockets, ticks } = connected();
  ticks[ticks.length - 1]();
  expect(sockets[0].lastMsg()).toEqual({ t: 'ping' });
});

it('stays connected across ticks while pong keeps arriving', () => {
  const { muter, sockets, ticks } = connected();
  const tick = ticks[ticks.length - 1];
  tick();                                          // ping #1
  sockets[0].fireMessage(encode({ t: 'pong' }));   // host is alive
  tick();                                          // ping #2, no close
  expect(sockets[0].closed).toBe(false);
  expect(muter.isConnected()).toBe(true);
  const pings = sockets[0].sent.map((r) => decode(r)).filter((m) => m.t === 'ping');
  expect(pings.length).toBe(2);
});

it('closes the socket and reconnects when a pong is missed', () => {
  const { sockets, scheduled, ticks } = connected();
  const tick = ticks[ticks.length - 1];
  tick();                                          // ping, now awaiting pong
  tick();                                          // no pong arrived -> dead link
  expect(sockets[0].closed).toBe(true);
  expect(scheduled.length).toBe(1);                // onClose scheduled a reconnect
  scheduled[0]();                                  // run it
  expect(sockets.length).toBe(2);                  // a fresh socket dialed out
});

it('cancels the heartbeat on disconnect and ignores a stale tick', () => {
  const { muter, sockets, ticks, heartbeatCancels } = connected();
  muter.disconnect();
  expect(heartbeatCancels()).toBe(1);
  const before = sockets[0].sent.length;
  ticks[ticks.length - 1]();                       // stale tick -> no-op
  expect(sockets[0].sent.length).toBe(before);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/mute-client.test.ts`
Expected: FAIL — `RemoteDiscordMuter` ignores the 3rd constructor arg, so `ticks` stays empty and `ticks[ticks.length - 1]()` throws / pings are never sent.

- [ ] **Step 3: Implement the heartbeat**

In `src/mute-client.ts`, update the import on lines 3-5 to add `HEARTBEAT_MS`:

```ts
import {
  ClientSocket, ClientSocketFactory, encode, decode, PROTOCOL_VERSION, WireMessage, HEARTBEAT_MS,
} from './mute-protocol';
```

Add a type alias just below the existing `const RECONNECT_MS = 3000;` line:

```ts
// Injectable interval timer: call `tick` every HEARTBEAT_MS, returns a cancel fn.
export type Heartbeat = (tick: () => void) => (() => void);
```

Add the third constructor param (extend the existing constructor):

```ts
  constructor(
    private readonly factory: ClientSocketFactory,
    private readonly schedule: (fn: () => void) => void =
      (fn) => { setTimeout(fn, RECONNECT_MS); },
    private readonly heartbeat: Heartbeat =
      (tick) => { const id = setInterval(tick, HEARTBEAT_MS); return () => clearInterval(id); },
  ) {}
```

Add two fields near the other private fields (below `private code = '';`):

```ts
  private stopHeartbeat: (() => void) | null = null;
  private awaitingPong = false;   // a ping is out; a second tick without a pong means dead
```

In the `onMessage` handler inside `open()`, start the heartbeat on `welcome` and handle `pong`. Replace the `if (msg.t === 'welcome') { ... }` branch and add a `pong` branch so the chain reads:

```ts
      if (msg.t === 'welcome') {
        this.state = 'connected';
        this.lastError = null;
        dbg('remote: connected');
        this.startHeartbeat(sock);
        // Re-assert whatever the orchestrator currently wants (mid-hold reconnect).
        sock.send(encode({ t: 'mute', on: this.desiredMute }));
      } else if (msg.t === 'pong') {
        this.awaitingPong = false;
      } else if (msg.t === 'reject') {
        this.lastError = msg.reason || 'rejected by host';
        dbg('remote: rejected', this.lastError);
        this.wanted = false;         // a bad code won't fix itself — stop retrying
        sock.close();
      } else if (msg.t === 'ping') {
        sock.send(encode({ t: 'pong' }));
      }
```

In the `onClose` handler inside `open()`, clear the heartbeat first (add the `this.clearHeartbeat()` line):

```ts
    sock.onClose(() => {
      if (this.sock !== sock) return;
      this.clearHeartbeat();
      this.sock = null;
      if (this.state === 'connected') dbg('remote: link dropped');
      this.state = 'disconnected';
      if (this.wanted) this.schedule(() => this.open());
    });
```

Add the two helper methods (place them right after the `open()` method, before `setMute`):

```ts
  // Proactive liveness: the host only learns we're gone when its own ping times
  // out; we do the same the other way so a half-open link after sleep is caught
  // here and torn down, which fires onClose and the reconnect loop.
  private startHeartbeat(sock: ClientSocket): void {
    this.clearHeartbeat();
    this.awaitingPong = false;
    this.stopHeartbeat = this.heartbeat(() => {
      if (this.sock !== sock) return;            // stale timer from an old socket
      if (this.awaitingPong) { sock.close(); return; } // missed a pong → dead link
      this.awaitingPong = true;
      sock.send(encode({ t: 'ping' }));
    });
  }

  private clearHeartbeat(): void {
    if (this.stopHeartbeat) { this.stopHeartbeat(); this.stopHeartbeat = null; }
    this.awaitingPong = false;
  }
```

In `disconnect()`, clear the heartbeat (add the `this.clearHeartbeat()` line):

```ts
  disconnect(): void {
    this.wanted = false;
    this.clearHeartbeat();
    if (this.sock) { try { this.sock.close(); } catch { /* noop */ } }
    this.sock = null;
    this.state = 'disconnected';
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/mute-client.test.ts`
Expected: PASS (all existing + 4 new tests).

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: no type errors; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mute-client.ts src/mute-protocol.ts tests/mute-client.test.ts
git commit -m "feat(remote): controller heartbeat reconnects on a dead link"
```

---

### Task 3: Re-establish links on system resume

**Files:**
- Modify: `src/main.ts:1` (import `powerMonitor`)
- Modify: `src/main.ts` inside `app.whenReady().then(() => { ... })` (register handler, near lines 522-523 where roles are first wired)

**Interfaces:**
- Consumes: existing module-scope `connectRemote()`, `startHost()`, mutable `cfg`, and `dbg` — all already defined in `main.ts`.

- [ ] **Step 1: Import powerMonitor**

In `src/main.ts` line 1, add `powerMonitor` to the electron import:

```ts
import { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, shell, systemPreferences, powerMonitor, MenuItemConstructorOptions } from 'electron';
```

- [ ] **Step 2: Register the resume handler**

In `src/main.ts`, inside the `app.whenReady().then(() => { ... })` block, immediately after the role-setup lines:

```ts
    if (cfg.role === 'host') { void connectDiscord(); startHost(); }
    else if (cfg.role === 'controller') { connectRemote(); }
```

add:

```ts
    // A sleep can leave the LAN link half-open with no clean close, so proactively
    // re-establish on wake instead of waiting on a heartbeat cycle. Both helpers
    // are idempotent (connectRemote disconnects first and no-ops unless controller;
    // startHost stops the old listener and re-advertises mDNS).
    powerMonitor.on('resume', () => {
      dbg('power: resume — re-establishing links');
      connectRemote();
      if (cfg.role === 'host') startHost();
    });
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles with no errors (produces `dist/main.js`).

- [ ] **Step 5: Manual verification (controller after sleep)**

This handler cannot be unit-tested without an Electron harness; verify against the real host:

1. Ensure the Windows host is running and reachable (its Hush host mode is on).
2. On the Mac, enable tracing: `touch ~/.hush-debug`, then relaunch Hush.
3. Confirm the log shows `remote: connected`:
   `grep -i 'remote:' ~/Library/Logs/Hush/hush-debug.log`
4. Sleep the Mac (Apple menu → Sleep), wait ~15 s, wake it.
5. Confirm the log shows `power: resume — re-establishing links` followed by `remote: connected` within a few seconds:
   `grep -iE 'power: resume|remote:' ~/Library/Logs/Hush/hush-debug.log`
6. Clean up: `rm -f ~/.hush-debug`.

Expected: the link is back automatically, no manual restart.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): re-establish LAN links on system resume"
```

---

## Self-Review

- **Spec coverage:** Heartbeat (spec §1) → Task 2. Wake hook (spec §2) → Task 3. Shared `HEARTBEAT_MS` (spec §1) → Task 1. Tests (spec §3) → Task 2 Step 1. Non-goal (Discord RPC on resume) correctly excluded. All covered.
- **Placeholder scan:** No TBD/TODO; every code step shows full code; test code is concrete.
- **Type consistency:** `Heartbeat = (tick) => (() => void)` defined in Task 2 and injected identically in the test helper; `startHeartbeat`/`clearHeartbeat`/`awaitingPong`/`stopHeartbeat` names used consistently; `HEARTBEAT_MS` exported in Task 1 and imported in Tasks 1 (net) and 2 (client).
