import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { db } from './ledger.ts';

// From `strings` on the claude CLI 2.1.268 binary (see NOTES.md "P2 credential store").
const TOKEN_URL = process.env.OAUTH_TOKEN_URL ?? 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPES = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'];
const KC_USER = /^[\w.-]+$/.test(process.env.USER ?? '') ? process.env.USER! : 'claude-code-user';
const SKEW = 5 * 60_000;
// CLI names the keychain item after the raw CLAUDE_CONFIG_DIR string it was given
export const kcService = (dir: string) =>
  `Claude Code-credentials-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`;

export type Account = {
  id: string; kind: 'home' | 'oauth'; config_dir: string | null; disabled: number; cooling_until: number | null;
  cooling_reason: string | null; last_status: number | null; last_ratelimit_json: string | null; last_seen: number | null;
  needs_login: number; note: string | null;
};
export const listAccounts = () => db.prepare(`select * from accounts order by kind = 'home' desc, id`).all() as Account[];
export const getAccount = (id: string) => db.prepare('select * from accounts where id = ?').get(id) as Account | undefined;
export const setAcct = (id: string, f: Record<string, string | number | null>) =>
  db.prepare(`update accounts set ${Object.keys(f).map((k) => `${k} = :${k}`).join(', ')} where id = :id`).run({ ...f, id });
export const healthy = (a: Account) => !a.disabled && !a.needs_login && !(a.cooling_until! > Date.now());

// Error messages below are fixed strings on purpose: JSON.parse / execFile errors can quote token bytes.
type Store = { where: 'file' | 'keychain'; blob: any };
const cache = new Map<string, Store>();
const inflight = new Map<string, Promise<any>>();
export const forget = (id: string) => cache.delete(id);

async function readStore(dir: string): Promise<Store | null> {
  try { return { where: 'file', blob: JSON.parse(readFileSync(`${dir}/.credentials.json`, 'utf8')) }; } catch {}
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await promisify(execFile)('security', ['find-generic-password', '-a', KC_USER, '-w', '-s', kcService(dir)]);
    return { where: 'keychain', blob: JSON.parse(stdout) };
  } catch { return null; }
}

async function writeStore(dir: string, s: Store) {
  const data = JSON.stringify(s.blob);
  if (s.where === 'file') {
    const f = `${dir}/.credentials.json`, tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    return renameSync(tmp, f);
  }
  // `security -i` reads the command from stdin so the secret never appears in argv (same as the CLI)
  await new Promise((ok, fail) => execFile('security', ['-i'], (e) => (e ? fail(new Error('keychain write failed')) : ok(null)))
    .stdin!.end(`add-generic-password -U -a "${KC_USER}" -s "${kcService(dir)}" -X "${Buffer.from(data).toString('hex')}"\n`));
}

async function load(a: Account) {
  const s = await readStore(a.config_dir!); // re-read first: the CLI may have rotated the refresh token
  const o = s?.blob?.claudeAiOauth;
  if (!o?.accessToken) { setAcct(a.id, { needs_login: 1 }); throw new Error('no credentials in store'); }
  if (o.expiresAt - Date.now() < SKEW) {
    const r = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: CLIENT_ID, scope: (o.scopes?.length ? o.scopes : SCOPES).join(' ') }),
    }).catch(() => null);
    if (!r?.ok) {
      if (r && r.status < 500) setAcct(a.id, { needs_login: 1 });
      throw new Error(`refresh failed: ${r?.status ?? 'network'}`);
    }
    const j: any = await r.json().catch(() => null);
    if (!j?.access_token) throw new Error('refresh failed: bad response');
    s!.blob.claudeAiOauth = { ...o, accessToken: j.access_token, refreshToken: j.refresh_token ?? o.refreshToken, expiresAt: Date.now() + j.expires_in * 1000 };
    await writeStore(a.config_dir!, s!);
  }
  cache.set(a.id, s!);
  return s!.blob.claudeAiOauth as { accessToken: string; expiresAt: number };
}

// One load/refresh per account at a time: concurrent refreshes would burn the rotating refresh token.
export function token(a: Account): Promise<{ accessToken: string; expiresAt: number }> {
  const c = cache.get(a.id)?.blob.claudeAiOauth;
  if (c && c.expiresAt - Date.now() > SKEW) return Promise.resolve(c);
  let p = inflight.get(a.id);
  if (!p) inflight.set(a.id, (p = load(a).finally(() => inflight.delete(a.id))));
  return p;
}
// token expiry for the UI (never the token itself); null until the account's creds were loaded once
export const expiresAt = (id: string): number | null => cache.get(id)?.blob?.claudeAiOauth?.expiresAt ?? null;
