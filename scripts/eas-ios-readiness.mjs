#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';

export async function checkReleaseReadiness({ root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), env = process.env, run = execFileSync, request = fetch, now = Date.now } = {}) {
  const appDir = resolve(root, 'artifacts/labtrax');
  let app, submit;
  try {
    app = JSON.parse(readFileSync(resolve(appDir, 'app.json'), 'utf8')).expo;
    submit = JSON.parse(readFileSync(resolve(appDir, 'eas.json'), 'utf8')).submit.production.ios;
  } catch { throw new Error('Release configuration is missing or invalid. Check app.json and eas.json.'); }
  const projectId = app.extra?.eas?.projectId;
  if (!projectId || !app.ios?.bundleIdentifier || !submit.ascAppId || !submit.ascApiKeyId || !submit.ascApiKeyIssuerId) {
    throw new Error('Release configuration needs the Expo project, iOS bundle identifier, and App Store Connect app/key identifiers.');
  }
  if (!env.EXPO_TOKEN) throw new Error('EXPO_TOKEN is missing from Replit Secrets.');
  let key;
  try {
    const raw = (env.ASC_API_KEY_P8 || '').replace(/\\n/g, '\n').trim();
    const pem = raw.match(/^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)\s*-----END PRIVATE KEY-----$/);
    if (!pem) throw new Error();
    key = createPrivateKey({ key: Buffer.from(pem[1].replace(/\s/g, ''), 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
  } catch { throw new Error('ASC_API_KEY_P8 must be a valid EC P-256 private key in Replit Secrets.'); }
  for (const args of [['whoami'], ['project:info']]) {
    let output;
    try {
      output = String(run('eas', args, { cwd: appDir, env, encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch { throw new Error('Expo access failed. Check EXPO_TOKEN, EAS CLI availability, project permissions, and network access. No build started.'); }
    if (args[0] === 'project:info' && !output.includes(projectId)) throw new Error('Expo returned a different project. Check the saved Expo project ID and account access.');
  }
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const issuedAt = Math.floor(now() / 1000);
  const payload = encode({ alg: 'ES256', kid: submit.ascApiKeyId, typ: 'JWT' }) + '.' + encode({ iss: submit.ascApiKeyIssuerId, iat: issuedAt, exp: issuedAt + 120, aud: 'appstoreconnect-v1' });
  const jwt = payload + '.' + sign('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  let response;
  try {
    response = await request('https://api.appstoreconnect.apple.com/v1/apps/' + encodeURIComponent(submit.ascAppId) + '?fields[apps]=bundleId,name', { headers: { Authorization: 'Bearer ' + jwt, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  } catch { throw new Error('App Store Connect could not be reached within the deadline. No build started.'); }
  if (!response.ok) throw new Error('App Store Connect access failed (HTTP ' + response.status + '). Verify the saved API key, issuer, app access, and Apple agreements. No build started.');
  let result;
  try { result = await response.json(); } catch { throw new Error('App Store Connect returned an unreadable app response.'); }
  if (result.data?.id !== String(submit.ascAppId) || result.data?.attributes?.bundleId !== app.ios.bundleIdentifier) throw new Error('The App Store Connect app does not match this iOS bundle identifier.');
  return ['Expo authentication and configured project access', 'Apple API key and configured App Store Connect app access', 'iOS bundle identifier matches App Store Connect'];
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const name of await checkReleaseReadiness()) console.log('PASS ' + name);
    console.log('READINESS COMPLETE. No build, upload, or App Store review submission started.');
  } catch (error) { console.error('BLOCKED: ' + error.message); process.exitCode = 2; }
}
