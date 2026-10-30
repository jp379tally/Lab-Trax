import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeyPairSync, verify } from 'node:crypto';
const { checkReleaseReadiness } = await import(pathToFileURL(resolve(import.meta.dirname, '../../eas-ios-readiness.mjs')).href);
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ios-ready-')); roots.push(root);
  const dir = join(root, 'artifacts/labtrax'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.labtrax' }, extra: { eas: { projectId: 'expected-project' } } } }));
  writeFileSync(join(dir, 'eas.json'), JSON.stringify({ submit: { production: { ios: { ascAppId: '123', ascApiKeyId: 'test-key', ascApiKeyIssuerId: 'test-issuer' } } } }));
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const env = { EXPO_TOKEN: 'test-secret', ASC_API_KEY_P8: String(pair.privateKey.export({ format: 'pem', type: 'pkcs8' })) };
  const run = vi.fn((_cmd: string, args: string[]): string => args[0] === 'project:info' ? 'ID expected-project' : 'test-user');
  const request = vi.fn(async () => ({ ok: true, json: async () => ({ data: { id: '123', attributes: { bundleId: 'com.example.labtrax' } } }) }));
  return { root, env, run, request, publicKey: pair.publicKey };
}
describe('iOS release account readiness', () => {
  it.each(['normal', 'compact', 'escaped'])('accepts the supported %s PEM format and sends a valid short-lived Apple JWT', async format => {
    const f = fixture();
    if (format === 'compact') f.env.ASC_API_KEY_P8 = f.env.ASC_API_KEY_P8.replace(/\n/g, ' ');
    if (format === 'escaped') f.env.ASC_API_KEY_P8 = f.env.ASC_API_KEY_P8.replace(/\n/g, '\\n');
    expect(await checkReleaseReadiness(f)).toHaveLength(3);
    expect(f.run.mock.calls.map(call => call[1][0])).toEqual(['whoami', 'project:info']);
    const [url, options] = (f.request.mock.calls as unknown as [string, { headers: { Authorization: string }; signal: AbortSignal }][]) [0];
    expect(url).toBe('https://api.appstoreconnect.apple.com/v1/apps/123?fields[apps]=bundleId,name');
    const parts = options.headers.Authorization.slice(7).split('.');
    expect(verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key: f.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    expect(claims.exp - claims.iat).toBe(120); expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it('rejects malformed Apple keys before any remote call', async () => {
    const f = fixture(); f.env.ASC_API_KEY_P8 = 'private-sensitive-value';
    await expect(checkReleaseReadiness(f)).rejects.toThrow('valid EC P-256'); expect(f.run).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
  it('refuses a different Expo project before contacting Apple', async () => {
    const f = fixture(); f.run.mockReturnValue('unrelated-project');
    await expect(checkReleaseReadiness(f)).rejects.toThrow('different project'); expect(f.request).not.toHaveBeenCalled();
  });
  it('does not expose credential-bearing CLI error output', async () => {
    const f = fixture(); f.run.mockImplementation(() => { throw new Error('private-sensitive-value'); });
    await expect(checkReleaseReadiness(f)).rejects.toThrow('Expo access failed');
    try { await checkReleaseReadiness(f); } catch (error) { expect(String(error)).not.toContain('private-sensitive-value'); }
  });
  it('blocks rejected Apple access without including the provider body', async () => {
    const f = fixture(); const request = vi.fn(async () => ({ ok: false, status: 403 }));
    await expect(checkReleaseReadiness({ ...f, request })).rejects.toThrow('HTTP 403');
  });
  it('rejects a different Apple bundle identifier', async () => {
    const f = fixture(); const request = vi.fn(async () => ({ ok: true, json: async () => ({ data: { id: '123', attributes: { bundleId: 'another.app' } } }) }));
    await expect(checkReleaseReadiness({ ...f, request })).rejects.toThrow('does not match');
  });
});
