import { describe, it, expect } from 'vitest';
import {
  compareVersions, parseLatestRelease, checkForUpdate, RELEASES_API_URL,
} from '../src/update-check';

describe('compareVersions', () => {
  it('returns 0 for equal versions (with or without v prefix)', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });
  it('detects patch / minor / major differences', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('1.3.0', '1.2.9')).toBe(1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
  });
  it('compares numerically, not lexically (0.10.0 > 0.9.0)', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
  });
  it('treats a missing component as 0 and ignores a pre-release suffix', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBe(0);
  });
});

describe('parseLatestRelease', () => {
  it('extracts version + url from a valid payload, stripping a leading v', () => {
    expect(parseLatestRelease({ tag_name: 'v0.2.0', html_url: 'https://x/rel' }))
      .toEqual({ version: '0.2.0', url: 'https://x/rel' });
  });
  it('returns null when a field is missing or non-string', () => {
    expect(parseLatestRelease({ tag_name: 'v0.2.0' })).toBeNull();
    expect(parseLatestRelease({ html_url: 'https://x' })).toBeNull();
    expect(parseLatestRelease({ tag_name: 1, html_url: 'https://x' })).toBeNull();
  });
  it('returns null for a non-object', () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease('nope')).toBeNull();
  });
  it('returns null for a non-https url', () => {
    expect(parseLatestRelease({ tag_name: 'v0.2.0', html_url: 'http://x/rel' })).toBeNull();
  });
});

describe('checkForUpdate', () => {
  const ok = (body: any): any =>
    async () => ({ ok: true, status: 200, json: async () => body });

  it('returns the release when it is newer', async () => {
    const fetchImpl = ok({ tag_name: 'v0.2.0', html_url: 'https://x/rel' });
    expect(await checkForUpdate(fetchImpl, '0.1.7'))
      .toEqual({ version: '0.2.0', url: 'https://x/rel' });
  });
  it('returns null when the release is equal or older', async () => {
    expect(await checkForUpdate(ok({ tag_name: 'v0.1.7', html_url: 'https://x' }), '0.1.7')).toBeNull();
    expect(await checkForUpdate(ok({ tag_name: 'v0.1.0', html_url: 'https://x' }), '0.1.7')).toBeNull();
  });
  it('returns null on a non-OK HTTP status', async () => {
    const fetchImpl: any = async () => ({ ok: false, status: 403, json: async () => ({}) });
    expect(await checkForUpdate(fetchImpl, '0.1.7')).toBeNull();
  });
  it('returns null when fetch rejects (offline)', async () => {
    const fetchImpl: any = async () => { throw new Error('offline'); };
    expect(await checkForUpdate(fetchImpl, '0.1.7')).toBeNull();
  });
  it('returns null on malformed JSON body', async () => {
    expect(await checkForUpdate(ok({ nope: true }), '0.1.7')).toBeNull();
  });
  it('hits the upstream releases endpoint', async () => {
    let seen = '';
    const fetchImpl: any = async (url: string) => {
      seen = url; return { ok: true, status: 200, json: async () => ({ tag_name: 'v0.2.0', html_url: 'https://x' }) };
    };
    await checkForUpdate(fetchImpl, '0.1.7');
    expect(seen).toBe(RELEASES_API_URL);
    expect(RELEASES_API_URL).toContain('MatthysDev/hush');
  });
});
