# Respect prior Discord voice state (mute + deafen) — design

## Problem

Hush mutes Discord while the user holds their push-to-talk shortcut and unmutes
on release. If the user was **already** muted or deafened in Discord before Hush
touched it, releasing the shortcut strips that state and leaves them un-muted —
undoing a state they set deliberately.

A partial fix exists for the single-machine case: the orchestrator snapshots the
Discord self-mute before muting (`orchestrator.ts` `mutedBefore`, via
`DiscordRpcMuter.getMute`) and, on release, leaves the user muted if they were
muted before. But it has two gaps:

1. **It does not work cross-machine.** On a controller (dictation machine that
   forwards mute over the LAN to a host running Discord), the orchestrator drives
   a `RemoteDiscordMuter`, which has **no `getMute`** (`main.ts:225`). So
   `mutedBefore` is always `false` and the host is told to unmute unconditionally
   on release, stripping the user's prior state. This is the reported bug.
2. **It only covers `mute`, not `deafen`.** A user who is fully deafened
   (mute + deaf) is un-deafened on release.

## Goals

- After a hold/release (any role, any mode), the user's Discord voice state
  returns to exactly what it was before Hush muted — covering **both** `mute` and
  `deaf`.
- Works identically for single-machine (`local`) and cross-machine
  (`controller` → `host`) setups, with no new network round-trip.

## Non-goals (YAGNI)

- Hush does not start deafening the user during dictation; it only mutes the mic
  (`{ mute: true }`) and leaves `deaf` untouched during the hold. Deafen is only
  ever *snapshotted and restored*, never asserted by Hush.
- No new wire-protocol message. The controller stays a dumb frame-forwarder.

## Design (Approach A: the logic lives in the muter)

The muter is always co-located with Discord (it is the thing speaking RPC), so it
can always read and restore the real voice state. Move the "remember prior state
and restore it" responsibility out of the orchestrator and into
`DiscordRpcMuter`. This fixes both the `local` and `controller`→`host` paths at
once (on `controller`, the host's `DiscordRpcMuter` does the work), naturally
covers `deaf`, and removes code from the orchestrator.

### Target behavior

| Discord state before hold | During dictation | On release |
| --- | --- | --- |
| neither mute nor deaf | `mute: true` | restore → mic active (classic) |
| self-muted (`mute`) | `mute: true` | restore → **stays muted** |
| deafened (`mute` + `deaf`) | `mute: true` (deaf untouched) | restore → **stays deafened** |

### `src/discord-mute.ts` — `DiscordRpcMuter` becomes stateful

Add two private fields: `heldByHush: boolean` (are we currently holding a
Hush-mute) and `priorState: { mute: boolean; deaf: boolean } | null` (the
snapshot taken when the hold began).

- **`setMute(true)`**: if `heldByHush` is false, snapshot
  `priorState = await getVoiceSettings()` (both flags), set `heldByHush = true`,
  then apply `setVoiceSettings({ mute: true })` — do **not** send `deaf`, so a
  pre-existing deafen is left intact. If `heldByHush` is already true, it is
  idempotent (ensure `{ mute: true }`, do not re-snapshot).
- **`setMute(false)`**: if `heldByHush` is true, restore
  `setVoiceSettings({ mute: priorState.mute, deaf: priorState.deaf })` — send
  **both** flags explicitly so the exact snapshot is forced regardless of any
  Discord side effect — then clear `heldByHush = false`, `priorState = null`. If
  the snapshot had failed (`priorState` is null: not connected / query failed),
  fall back to the old best-effort behavior: `setVoiceSettings({ mute: false })`.
  If `heldByHush` is false (e.g. the hold was lost to a mid-session RPC drop that
  cleared it), it ALSO does a plain `setVoiceSettings({ mute: false })`: every
  caller only asks to unmute when it believes a mute is outstanding, so honoring
  it is always safe and never leaves Discord stuck muted (the codebase's cardinal
  rule) — the same best-effort path as a null snapshot.

`getVoiceSettings()`/`setVoiceSettings({ mute?, deaf? })` already exist on the
`RpcClient` interface (`discord-mute.ts:23-24`), so no client-contract change is
needed. `getVoiceSettings` may be absent/failing → treat as an unknown snapshot
(the null fallback above).

### `src/orchestrator.ts` — remove the now-redundant snapshot

The muter owns snapshot/restore, so the orchestrator's `mutedBefore` logic is
removed:

- `activate()`: `setActive(true)` then `await this.discord.setMute(true)` — drop
  the `getMute` snapshot.
- `deactivate()`: `setActive(false)`, then (if `unmuteDelayMs > 0`) sleep, then
  `await this.discord.setMute(false)` — drop the "stay muted — was muted before"
  branch. The end state is identical to today for the mute case, plus deaf
  coverage and the cross-machine fix.

The orchestrator no longer references `getMute` at all — which was the method the
controller path could not provide.

### Data flow (cross-machine, the reported setup)

```
Mac (controller)                       Windows (host)
orchestrator.setMute(true)
  → RemoteDiscordMuter → frame mute:on ──LAN──► MuteServer.applyMute (first holder)
                                                   → DiscordRpcMuter.setMute(true)
                                                        → snapshot {mute,deaf}; apply mute:true
[release]
orchestrator.setMute(false)
  → frame mute:off ──────────────────────LAN──► MuteServer (last release)
                                                   → DiscordRpcMuter.setMute(false)
                                                        → restore original {mute,deaf}
```

`MuteServer.applyMute` already dedups multiple controllers to a single first-mute
/ last-release edge; the muter's `heldByHush` guard aligns with those edges and is
idempotent under any redundant `setMute(true)`.

## Error handling

- `getVoiceSettings` unavailable or throwing → `priorState = null` → restore
  degrades to a plain `{ mute: false }` (today's behavior). Never worse than now.
- Discord dropping mid-hold (socket dies): snapshot may be lost on reconnect;
  best-effort, consistent with the rest of the muter.
- All muter calls stay non-throwing (existing `setMute` swallows RPC errors).

## Testing

**`tests/discord-mute.test.ts`** — fake `RpcClient` exposing
`getVoiceSettings`/`setVoiceSettings`:

1. baseline `{ mute:false, deaf:false }` → `setMute(true)` snapshots once and
   applies `{ mute:true }`; `setMute(false)` restores `{ mute:false, deaf:false }`.
2. baseline `{ mute:true, deaf:false }` → after hold/release, Discord ends muted
   (`{ mute:true }`), i.e. the user stays muted.
3. baseline `{ mute:true, deaf:true }` (deafened) → hold sends `{ mute:true }`
   without a `deaf` field; release restores `{ mute:true, deaf:true }`.
4. two consecutive `setMute(true)` calls snapshot only once (idempotent hold).
5. `getVoiceSettings` rejects/returns unknown → `setMute(false)` falls back to
   `{ mute:false }`.

**`tests/orchestrator.test.ts`** — remove/adapt the `mutedBefore` tests
(behavior relocated): assert the orchestrator simply calls `setMute(true)` on
activate and `setMute(false)` on deactivate, with no `getMute` dependency.

## Plan-time verification

Before treating `getMute` as dead, grep its usages across `src/` (UI/status may
read it). Keep it if used elsewhere; otherwise leave it as an unused optional
interface method — do not remove it as part of this change (out of scope).

## Files touched

- `src/discord-mute.ts` — stateful snapshot/restore in `setMute`.
- `src/orchestrator.ts` — remove `mutedBefore` snapshot/restore.
- `tests/discord-mute.test.ts` — snapshot/restore tests.
- `tests/orchestrator.test.ts` — adapt the relocated behavior.
- `src/types.ts` — possibly update the `DiscordMuter.getMute` doc comment.
