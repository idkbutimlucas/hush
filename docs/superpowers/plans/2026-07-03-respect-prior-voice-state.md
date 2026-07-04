# Respect Prior Discord Voice State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a hold/release, restore the user's exact prior Discord voice state (self-mute AND self-deafen), for both single-machine and cross-machine setups.

**Architecture:** Move the "remember prior state and restore it" responsibility out of the orchestrator and into `DiscordRpcMuter` (the muter co-located with Discord). The muter snapshots `{ mute, deaf }` on the entering mute edge and restores it on release; the orchestrator is simplified to always mute/unmute on the edges. This fixes the cross-machine path (the host's muter does the work) with no new wire message.

**Tech Stack:** TypeScript, Electron, `discord-rpc` (RPC `SET_VOICE_SETTINGS`/`GET_VOICE_SETTINGS`), Vitest.

## Global Constraints

- Runtime: TypeScript; `npm run typecheck` (`tsc --noEmit`) must stay green.
- Tests: Vitest, run with `npm test` (`vitest run`).
- Do NOT change the wire protocol, the host relay, or `PROTOCOL_VERSION` (stays 1). This change is entirely local to `DiscordRpcMuter` and the orchestrator.
- During a hold, Hush only ever asserts `{ mute: true }` — it must NOT send `deaf`. `deaf` is only ever snapshotted and restored, never asserted by Hush.
- On restore, send BOTH flags explicitly (`{ mute, deaf }`) so the exact snapshot is forced.
- Follow existing style: terse comments explaining *why*; `dbg(...)` for tracing.
- All muter methods stay non-throwing (best-effort): a failed RPC call is swallowed and degrades gracefully.

---

### Task 1: DiscordRpcMuter snapshots and restores prior voice state

**Files:**
- Modify: `src/discord-mute.ts` (fields after `private generation = 0;` ~line 87; `getMute` ~lines 271-281; `setMute` ~lines 283-298)
- Test: `tests/discord-mute.test.ts`

**Interfaces:**
- Consumes: existing `RpcClient` with `getVoiceSettings?(): Promise<{ mute?: boolean; deaf?: boolean }>` and `setVoiceSettings(settings: { mute?: boolean; deaf?: boolean })` (`src/discord-mute.ts:23-24`).
- Produces: `DiscordRpcMuter.setMute(on)` now snapshots `{ mute, deaf }` on the first `setMute(true)` and restores it on `setMute(false)`. New private helper `readVoiceState(): Promise<{ mute: boolean; deaf: boolean } | null>`. `getMute()` keeps its `Promise<boolean | null>` signature (delegates to `readVoiceState`).

- [ ] **Step 1: Write the failing tests**

In `tests/discord-mute.test.ts`, extend the `FakeRpcClient` class. Add a `voiceSettings` field and a `getVoiceSettings` method, and make `setVoiceSettings` merge into `voiceSettings`. Replace the existing `setVoiceSettings` method with this version and add the two new members right after it:

```ts
  async setVoiceSettings(settings: { mute?: boolean; deaf?: boolean }): Promise<unknown> {
    this.calls.push({ name: 'setVoiceSettings', args: [settings] });
    this.voiceSettings = { ...this.voiceSettings, ...settings };
    return undefined;
  }

  voiceSettings: { mute?: boolean; deaf?: boolean } = { mute: false, deaf: false };

  async getVoiceSettings(): Promise<{ mute?: boolean; deaf?: boolean }> {
    this.calls.push({ name: 'getVoiceSettings', args: [] });
    return this.voiceSettings;
  }
```

Then add this new `describe` block at the end of the file (it uses the existing `FakeRpcClient`, `makeFakeOauth`, and `vi`):

```ts
describe('DiscordRpcMuter restores prior voice state (snapshot/restore)', () => {
  // A connected muter whose fake Discord starts in the given voice state.
  async function connectedMuter(voice: { mute?: boolean; deaf?: boolean }) {
    let client: FakeRpcClient | null = null;
    const m = new DiscordRpcMuter({
      createClient: () => {
        client = new FakeRpcClient();
        client.voiceSettings = voice;
        return client as any;
      },
      oauth: makeFakeOauth({ isExpired: vi.fn(() => false) }) as any,
      fetchImpl: (async () => { throw new Error('fetchImpl should not be called'); }) as any,
      now: () => 1000,
    });
    await m.connect('cid', 'secret', { accessToken: 'tok', tokenExpiresAt: 999999 });
    return { m, client: client! };
  }

  const sets = (client: FakeRpcClient) =>
    client.calls.filter((c) => c.name === 'setVoiceSettings').map((c) => c.args[0]);

  it('classic: not muted before -> mute on hold, unmute on release', async () => {
    const { m, client } = await connectedMuter({ mute: false, deaf: false });
    await m.setMute(true);
    await m.setMute(false);
    expect(sets(client)).toEqual([{ mute: true }, { mute: false, deaf: false }]);
  });

  it('stays muted on release if already self-muted before', async () => {
    const { m, client } = await connectedMuter({ mute: true, deaf: false });
    await m.setMute(true);
    await m.setMute(false);
    expect(sets(client)).toEqual([{ mute: true }, { mute: true, deaf: false }]);
  });

  it('stays deafened on release if deafened before (deaf preserved, never asserted during hold)', async () => {
    const { m, client } = await connectedMuter({ mute: true, deaf: true });
    await m.setMute(true);
    await m.setMute(false);
    // hold asserts only { mute: true } (no deaf field); release restores both.
    expect(sets(client)).toEqual([{ mute: true }, { mute: true, deaf: true }]);
  });

  it('snapshots only once across a double setMute(true) (idempotent hold)', async () => {
    const { m, client } = await connectedMuter({ mute: false, deaf: false });
    await m.setMute(true);
    await m.setMute(true);
    const snapshots = client.calls.filter((c) => c.name === 'getVoiceSettings');
    expect(snapshots.length).toBe(1);
  });

  it('falls back to a plain unmute when the snapshot could not be read', async () => {
    const { m, client } = await connectedMuter({ mute: false, deaf: false });
    client.getVoiceSettings = (async () => { throw new Error('rpc query failed'); }) as any;
    await m.setMute(true);
    await m.setMute(false);
    expect(sets(client)).toEqual([{ mute: true }, { mute: false }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/discord-mute.test.ts`
Expected: FAIL — the current `setMute` sends `{ mute: on }` and never snapshots, so e.g. the "stays muted" test sees `[{ mute: true }, { mute: false }]` instead of `[{ mute: true }, { mute: true, deaf: false }]`, and the snapshot-count test sees `0` getVoiceSettings calls.

- [ ] **Step 3: Add the snapshot fields**

In `src/discord-mute.ts`, immediately after `private generation = 0;` (~line 87), add:

```ts
  // Snapshot/restore of the user's own voice state so a hold/release returns them
  // to exactly what they had before Hush muted — covering self-mute AND deafen.
  // heldByHush gates the snapshot to the entering edge (idempotent under repeats).
  private heldByHush = false;
  private priorState: { mute: boolean; deaf: boolean } | null = null;
```

- [ ] **Step 4: Add readVoiceState and make getMute delegate to it**

In `src/discord-mute.ts`, replace the entire existing `getMute` method (~lines 271-281) with:

```ts
  // The user's current { mute, deaf } self-state, or null if we can't tell
  // (not connected / query unsupported / failed). Never throws.
  private async readVoiceState(): Promise<{ mute: boolean; deaf: boolean } | null> {
    if (!this.client || this.state !== 'connected' || !this.client.getVoiceSettings) return null;
    try {
      const s = await this.client.getVoiceSettings();
      return { mute: s.mute === true, deaf: s.deaf === true };
    } catch (err) {
      dbg('rpc: readVoiceState failed', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  // The user's current self-mute state, or null if unknown. Delegates to the
  // richer readVoiceState so there is one source of truth for reading state.
  async getMute(): Promise<boolean | null> {
    const s = await this.readVoiceState();
    return s ? s.mute : null;
  }
```

- [ ] **Step 5: Rewrite setMute with snapshot/restore**

In `src/discord-mute.ts`, replace the entire existing `setMute` method (~lines 283-298) with:

```ts
  // Mute for dictation, remembering the user's prior voice state so release can
  // restore it. On the entering edge we snapshot { mute, deaf } and assert only
  // mute:true (deaf is left untouched during the hold). On release we restore the
  // exact snapshot — so someone already muted or deafened is left that way. A
  // failed snapshot degrades to a plain unmute (best-effort, never worse).
  async setMute(on: boolean): Promise<void> {
    if (!this.client || this.state !== 'connected') {
      dbg('rpc: setMute skipped (not connected)', { on });
      return;
    }
    try {
      if (on) {
        if (!this.heldByHush) {
          this.priorState = await this.readVoiceState();
          this.heldByHush = true;
        }
        await this.client.setVoiceSettings({ mute: true });
        dbg('rpc: setMute', { on: true });
      } else if (this.heldByHush) {
        const prior = this.priorState;
        this.heldByHush = false;
        this.priorState = null;
        if (prior) {
          await this.client.setVoiceSettings({ mute: prior.mute, deaf: prior.deaf });
          dbg('rpc: restore prior voice state', prior);
        } else {
          await this.client.setVoiceSettings({ mute: false });
          dbg('rpc: setMute', { on: false });
        }
      } else {
        // Never held a Hush-mute → nothing of ours to undo; don't strip state.
        dbg('rpc: setMute(false) ignored (not holding)');
      }
    } catch (err) {
      // A dropped socket (Discord quit mid-session) lands here — degrade to
      // disconnected so the next attempt reconnects instead of throwing.
      this.state = 'disconnected';
      this.lastError = err instanceof Error ? err.message : String(err);
      dbg('rpc: setMute failed', this.lastError);
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- tests/discord-mute.test.ts`
Expected: PASS (all pre-existing + 5 new tests).

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: no type errors; all tests PASS. (The orchestrator still calls `getMute` at this point — that is fine; its signature is unchanged.)

- [ ] **Step 8: Commit**

```bash
git add src/discord-mute.ts tests/discord-mute.test.ts
git commit -m "feat(discord): snapshot & restore prior voice state (mute + deafen)"
```

---

### Task 2: Simplify the orchestrator to delegate restore to the muter

**Files:**
- Modify: `src/orchestrator.ts` (`mutedBefore` field ~lines 13-16; `activate` ~lines 85-93; `deactivate` ~lines 95-106)
- Test: `tests/orchestrator.test.ts` (`FakeMuter` ~lines 6-13; `describe('Orchestrator restores the prior Discord mute state')` ~lines 42-70)

**Interfaces:**
- Consumes: `DiscordRpcMuter` now owns snapshot/restore (Task 1). The orchestrator only calls `setMute(true)`/`setMute(false)` on the mute edges and no longer reads `getMute`.
- Produces: no new interface. `Orchestrator.activate` always mutes, `deactivate` always unmutes (after `unmuteDelayMs`).

- [ ] **Step 1: Update the orchestrator tests (relocate the behavior)**

In `tests/orchestrator.test.ts`, replace the `FakeMuter` class (~lines 6-13, including the two-line comment above it) with this simplified version (it no longer needs to model mute state, since restore moved to the real muter):

```ts
// Records the exact order of Discord mute/unmute calls.
class FakeMuter implements DiscordMuter {
  constructor(readonly calls: string[]) {}
  async setMute(on: boolean) { this.calls.push(`mute:${on}`); }
}
```

Then delete the entire `describe('Orchestrator restores the prior Discord mute state', () => { ... })` block (~lines 42-70). That behavior is now owned and tested by `DiscordRpcMuter` (Task 1); at the orchestrator level the correct expectation is simply "always unmute on release", which the existing `describe('Orchestrator hold mode')` test `'press mutes Discord; release unmutes'` already covers.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/orchestrator.test.ts`
Expected: FAIL to COMPILE/RUN — `orchestrator.ts` still references `this.mutedBefore` and `this.discord.getMute`, but that is unchanged yet; the actual failure here is that the removed `describe` block's `muter.muted = true` usage is gone and `FakeMuter` no longer has `muted`/`getMute`. Confirm the suite runs the remaining tests; they should still pass EXCEPT there are no references left to the deleted symbols. (If TypeScript flags `muted`/`getMute` as unused-but-referenced anywhere, that reference is stale and must be removed — there should be none.)

Note: this step mainly verifies the test file is self-consistent after the edit. Proceed to the implementation regardless; Step 4 is the real behavioral gate.

- [ ] **Step 3: Simplify activate() and deactivate() and drop the mutedBefore field**

In `src/orchestrator.ts`, delete the `mutedBefore` field declaration and its comment (~lines 13-16):

```ts
  // Whether the user was already self-muted in Discord at the moment Hush
  // muted. If so, releasing push-to-talk must leave them muted rather than
  // unmuting them (they didn't ask to be unmuted).
  private mutedBefore = false;
```

Replace the entire `activate` method (~lines 85-93) with:

```ts
  private async activate(): Promise<void> {
    if (this.active) return;
    dbg('orchestrator: activate (mute)');
    this.setActive(true);
    await this.discord.setMute(true);
  }
```

Replace the entire `deactivate` method (~lines 95-106) with:

```ts
  private async deactivate(): Promise<void> {
    if (!this.active) return;
    this.setActive(false);
    // Restoring the user's prior voice state (incl. a pre-existing mute/deafen)
    // now lives in the muter, so we always ask to unmute and let it decide.
    dbg('orchestrator: deactivate (unmute)');
    if (this.cfg.unmuteDelayMs > 0) await this.sleep(this.cfg.unmuteDelayMs);
    await this.discord.setMute(false);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/orchestrator.test.ts`
Expected: PASS. The orchestrator now always emits `mute:true` on activate and `mute:false` on deactivate; every remaining test's expectations already match that.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: no type errors; all tests PASS. `getMute` is no longer referenced by `src/orchestrator.ts`; it remains defined on `DiscordRpcMuter` and optional on the `DiscordMuter` interface (intentionally kept — out of scope to remove).

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "refactor(orchestrator): delegate prior-state restore to the muter"
```

---

## Self-Review

- **Spec coverage:** Snapshot/restore of `{ mute, deaf }` in the muter (spec §"`src/discord-mute.ts`") → Task 1. Only `{ mute: true }` asserted during hold, both flags on restore, null-snapshot fallback (spec Global Constraints + Error handling) → Task 1 Steps 4-5 + fallback test. Orchestrator simplification, no `getMute` dependency (spec §"`src/orchestrator.ts`") → Task 2. Cross-machine correctness needs no code change beyond these (controller forwards frames; host muter does the work) — no separate task required, matches spec data-flow. `getMute` kept, not removed (spec §"Plan-time verification") → confirmed: only caller was `orchestrator.ts:89`, removed in Task 2; method retained. All covered.
- **Placeholder scan:** No TBD/TODO; every code step shows full code; all test code is concrete.
- **Type consistency:** `readVoiceState(): Promise<{ mute: boolean; deaf: boolean } | null>` defined and used consistently in Task 1; `getMute(): Promise<boolean | null>` signature unchanged; `heldByHush`/`priorState` names consistent; `FakeRpcClient.getVoiceSettings`/`voiceSettings` added in Task 1 match the `RpcClient` interface shape (`{ mute?, deaf? }`); Task 2's `FakeMuter` implements `DiscordMuter` (only `setMute` required, `getMute` optional).
