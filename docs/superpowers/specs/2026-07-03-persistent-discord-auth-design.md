# Persistent Discord auth + auto-reconnect

**Date:** 2026-07-03
**Status:** Design + plan — approved (A+B), branch `feat/persistent-discord-auth` off `main`

## Problem

Two distinct pains on the local Discord RPC path:

- **A — No reconnect on Discord restart.** `discord-rpc`'s client emits a
  `'disconnected'` event when Discord quits (`node_modules/discord-rpc/src/client.js:110`),
  but `main.ts` never listens for it. The retry timer (`main.ts` `rpcRetryTimer`) only
  fires on the *initial* connect failure, never on a later drop. So closing and
  reopening Discord leaves Hush disconnected until the user manually clicks
  **Connecter** (or the next mute attempt lazily notices). This is the main
  "reconnect every time" complaint.

- **B — Re-authorize popup every ~7 days.** Discord OAuth2 access tokens expire in
  **7 days** (`expires_in: 604800`). The token endpoint *also* returns a
  **`refresh_token`** that renews the access token with no user interaction (valid
  until the user revokes the app in Discord → **Authorized Apps**). But the
  `discord-rpc` library **discards the refresh token** — it keeps only the access
  token. And the RPC `AUTHORIZE` command **always shows the consent modal** (there is
  no `prompt=none` for the RPC command), so once the cached access token expires, the
  only path the current code has is a full `AUTHORIZE` → **popup**.

## Research (authoritative)

- RPC `AUTHORIZE` re-shows the modal on every call — no silent re-auth via re-authorize.
  The documented workaround is to cache the token and call `AUTHENTICATE` directly.
- Access token: 7-day expiry. Refresh token: returned by the `authorization_code`
  grant, renewable via `grant_type=refresh_token`, valid until revoked in Authorized
  Apps. The **implicit** grant returns no refresh token — not used here.
- `discord-rpc` v4.0.1 `authorize()` returns only `response.access_token` and drops
  the refresh token. `client.connect(clientId)`, `client.request('AUTHORIZE', …)`,
  and `client.authenticate(accessToken)` are all usable directly.

## Solution

### Layer A — auto-reconnect watchdog

- `DiscordRpcMuter.open()` attaches `client.on('disconnected', …)`. On a drop it sets
  state `disconnected` and invokes an injected `onDrop` callback — **unless** the
  disconnect was intentional (a `closing` flag set during `disconnect()`), to avoid a
  reconnect loop on role change / quit.
- `main.ts` sets `discord`'s `onDrop` to (re)schedule `connectDiscord()` on a timer,
  guarded by a `wantDiscord` flag (true for `local`/`host`-style local RPC use, false
  after an intentional teardown). Within the 7-day token window this reconnect is
  fully silent (cached access token → `AUTHENTICATE`).

### Layer B — refresh-token persistence

Own the OAuth token exchange instead of relying on the library's `authorize()` (which
drops the refresh token). New pure, testable helper `src/discord-oauth.ts`:

- `exchangeCode(fetchImpl, { clientId, clientSecret, code, redirectUri }): Promise<TokenSet>`
  — POST `https://discord.com/api/oauth2/token` with `grant_type=authorization_code`.
- `refreshTokens(fetchImpl, { clientId, clientSecret, refreshToken }): Promise<TokenSet>`
  — POST with `grant_type=refresh_token`.
- `computeExpiresAt(expiresIn, nowMs): number` and
  `isExpired(expiresAt, nowMs, skewMs = 60_000): boolean` — pure helpers.
- `TokenSet = { accessToken: string; refreshToken: string; expiresAt: number }`.

The POST is a plain `application/x-www-form-urlencoded` request with the client
credentials in the body — it must NOT reuse the library's `client.fetch` (which sets a
`Bearer` header). `fetchImpl` is injected (default: global `fetch`) so tests use a fake.

`DiscordRpcMuter.connect()` new order (client injected/lazy-required as today):
1. `await client.connect(clientId)` (bounded timeout).
2. Acquire a token set, **cheapest/quietest first** (avoid a needless HTTP round-trip
   when the cached token is still good):
   - have a **non-expired cached access token** (`!isExpired(tokenExpiresAt, now)`) →
     use it directly, no network;
   - else have a **refresh token** → `refreshTokens(...)`; on success use it (and store
     the rotated refresh token);
   - else (first run, or refresh failed) → `{ code } = await client.request('AUTHORIZE',
     { scopes, client_id })` (**popup, once**) → `exchangeCode(...)`.
3. Store the obtained token set **immediately** (before `authenticate()`), so a rotated
   refresh token is never lost if `authenticate()` then fails.
4. `await client.authenticate(tokenSet.accessToken)`.
5. Expose `getTokens(): TokenSet | null` so `main.ts` persists access + refresh +
   expiresAt.

Concurrency: `connect()` carries a **generation counter**; a superseded (stale)
attempt's completion/catch is a no-op and must not clobber a newer attempt's client or
state. The disconnect **watchdog** (`handleDrop`) only fires `onDrop` when the state was
`connected` (a genuine live-session drop), never during an in-flight handshake.

### Config

Extend `DiscordRpc` (`src/types.ts`): add `refreshToken?: string` and
`tokenExpiresAt?: number` (epoch ms) alongside the existing `accessToken?`. `store.ts`
migration passes them through (absent on old configs → silently omitted; the first
successful connect fills them). No default-shape change.

### main.ts

- Persist `refreshToken` + `tokenExpiresAt` after a successful connect (extend the
  existing accessToken-persist block).
- `onDrop` → schedule reconnect under a `wantDiscord` guard; clear the timer on
  intentional teardown and on success.

## Testing

- **`discord-oauth.ts`** (unit, fake fetch + injected now): `exchangeCode` /
  `refreshTokens` build the right form body and parse `{access_token, refresh_token,
  expires_in}`; HTTP error → throws; `computeExpiresAt` / `isExpired` (incl. skew).
- **Config**: `refreshToken`/`tokenExpiresAt` round-trip through migration; defaults
  unchanged.
- **`DiscordRpcMuter`** (with injected fake RPC client + fake `discord-oauth`): prefers
  refresh when a refresh token is present; falls back to cached access token; falls
  back to `AUTHORIZE` only when neither works; `onDrop` fires on an unexpected
  `'disconnected'` but NOT after an intentional `disconnect()`.
- Existing `discord-mute` best-effort tests stay green (no regression).
- Real end-to-end (real Discord: quit/reopen reconnects silently; survives past 7-day
  expiry with no popup) is verified manually.

## Out of scope

- Changing the cross-machine feature (separate branch/PR). This branch only hardens the
  local RPC auth/reconnect that both the `local` and (cross-machine) `host` roles use.
- Encrypting the stored refresh token at rest (it lives in `electron-store` next to the
  client secret, same trust level as today).

## Plan (tasks)

1. **Config + OAuth helper.** `types.ts` (`refreshToken?`, `tokenExpiresAt?`),
   `store.ts` migration passthrough, new `src/discord-oauth.ts` + `tests/discord-oauth.test.ts`
   (+ config test additions). TDD.
2. **DiscordRpcMuter refresh flow + drop watchdog.** Refactor `connect()` to the
   token-acquisition order above; add `onDrop` + `closing` guard; add `getTokens()`.
   Inject the RPC client factory + oauth helper for `tests/discord-mute.test.ts`. TDD.
3. **main.ts wiring.** Persist refresh/expiry; `onDrop` → guarded reconnect watchdog.
   Manual verification (Electron) + full suite green.
