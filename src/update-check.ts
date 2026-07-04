// Best-effort "is there a newer release?" check against the upstream GitHub
// Releases API. Pure and fetch-injected so it unit-tests without a network
// stack or Electron — mirrors discord-oauth.ts. Never throws: every failure
// (offline, rate-limited, malformed) resolves to null so the caller treats
// "no update" and "couldn't check" identically.

export type UpdateInfo = { version: string; url: string };

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

// Upstream is where the user installs from (the fork only contributes).
export const RELEASES_API_URL =
  'https://api.github.com/repos/MatthysDev/hush/releases/latest';

// Numeric semver compare on MAJOR.MINOR.PATCH. Tolerates a leading 'v' and a
// pre-release suffix (ignored). Missing/non-numeric parts count as 0.
// Returns -1 (a<b), 0 (equal), 1 (a>b).
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('-')[0].split('.').map((n) => {
      const x = parseInt(n, 10);
      return Number.isFinite(x) ? x : 0;
    });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// Pull { version, url } out of a GitHub "latest release" payload. Returns null
// if the shape isn't what we expect (missing tag_name/html_url, non-object).
export function parseLatestRelease(json: unknown): UpdateInfo | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const version = obj.tag_name;
  const url = obj.html_url;
  if (typeof version !== 'string' || typeof url !== 'string') return null;
  if (!version || !url) return null;
  if (!url.startsWith('https://')) return null;
  return { version: version.replace(/^v/, ''), url };
}

// Returns the newer release ({ version, url }) if one exists, else null.
// Best-effort: swallows every error path to null.
export async function checkForUpdate(
  fetchImpl: FetchLike,
  currentVersion: string,
): Promise<UpdateInfo | null> {
  try {
    const res = await fetchImpl(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Hush' },
    });
    if (!res.ok) return null;
    const info = parseLatestRelease(await res.json());
    if (!info) return null;
    return compareVersions(info.version, currentVersion) === 1 ? info : null;
  } catch {
    return null;
  }
}
