import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTls, request as httpsRequest } from 'node:https';
import { createServer as createNet, type AddressInfo } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, mkdirSync, appendFileSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tmpdir, networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EV1 = 'event: message_start\ndata: {"type":"message_start"}\n\n';
const EV2 = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

// One throwaway CA + api.anthropic.com leaf (made by setup.sh) for the fake upstream and the transparent listener.
const CERTS = mkdtempSync(`${tmpdir()}/router-ca-`);
execFileSync(`${import.meta.dirname}/setup.sh`, ['--into', CERTS], { stdio: 'ignore' });
const TLS = { key: readFileSync(`${CERTS}/api.anthropic.com-key.pem`), cert: readFileSync(`${CERTS}/api.anthropic.com.pem`) };
const CA = readFileSync(`${CERTS}/ca.pem`);
const listen = async (srv: any, host = '127.0.0.1') => { await new Promise((r) => srv.listen(0, host, r)); return (srv.address() as AddressInfo).port; };

// Fake api.anthropic.com over TLS. Host or SNI other than api.anthropic.com (e.g. the dialled IP) -> 421, which fails
// every test's status/body check. (Not an after-hook assert: a throwing hook skips the router kill and hangs the run.)
async function fakeUpstream(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const srv = createTls(TLS, (req, res) => {
    const sni = (req.socket as any).servername;
    if (req.headers.host !== 'api.anthropic.com' || sni !== 'api.anthropic.com') return res.writeHead(421).end(`bad Host/SNI: ${req.headers.host} / ${sni}`);
    handler(req, res);
  });
  const port = await listen(srv);
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { UPSTREAM_IP: '127.0.0.1', UPSTREAM_PORT: String(port), UPSTREAM_HOST: 'api.anthropic.com', UPSTREAM_CA: `${CERTS}/ca.pem` };
}

async function startRouter(t: TestContext, env: Record<string, string>) {
  const dir = mkdtempSync(`${tmpdir()}/router-`), home = 'LEDGER_PATH' in env;
  // `LEDGER_PATH: undefined` runs a copy of the source with HOME = dir and an old ledger next to it, so the default
  // path and the one-time move happen in temp, never on the checkout's own ledger
  const src = home ? `${dir}/src` : import.meta.dirname;
  if (home) {
    cpSync(import.meta.dirname, src, { recursive: true, filter: (f) => !/\/(ledger\.sqlite|router\.log|\.git|node_modules)/.test(f) });
    const old = new DatabaseSync(`${src}/ledger.sqlite`); old.exec('create table moved (x); insert into moved values (1)'); old.close();
  }
  const ledger = home ? `${dir}/.agent-router/ledger.sqlite` : `${dir}/ledger.sqlite`;
  const child = spawn(process.execPath, [`${src}/router.ts`], { env: { ...process.env, PORT: '0', LEDGER_PATH: ledger, ...(home && { HOME: dir }), TLS_DIR: mkdtempSync(`${tmpdir()}/router-notls-`),
    CLAUDE_PROJECTS_DIR: mkdtempSync(`${tmpdir()}/router-projects-`), ...env } });
  t.after(() => child.kill());
  let stdout = '';
  const waitFor = (re: RegExp) => new Promise<RegExpMatchArray>((resolve) => {
    const check = () => { const m = stdout.match(re); if (m) resolve(m); else child.once('out', check); };
    check();
  });
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { stdout += d; child.emit('out'); });
  const base = (await waitFor(/listening on (\S+)/))[1];
  return { base, ledger, stdout: () => stdout, waitFor };
}

// Raw client: no decompression, returns exact bytes. `tls` = connect to the transparent listener as api.anthropic.com.
function raw(o: { port: number; host?: string; tls?: boolean; path?: string; headers?: Record<string, string> }, body = '') {
  const opts = { host: o.host ?? '127.0.0.1', port: o.port, path: o.path ?? '/v1/messages', method: 'POST', headers: o.headers,
    ...(o.tls && { servername: 'api.anthropic.com', ca: CA }) };
  return new Promise<{ status: number; headers: IncomingMessage['headers']; chunks: Buffer[]; body: Buffer }>((ok, fail) =>
    (o.tls ? httpsRequest : httpRequest)(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c)).on('end', () => ok({ status: res.statusCode!, headers: res.headers, chunks, body: Buffer.concat(chunks) }));
    }).on('error', fail).end(body));
}
const freePort = async () => { const s = createNet(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; };

const sse = (seen: { path: string; auth?: string }[]) => (req: IncomingMessage, res: ServerResponse) => {
  seen.push({ path: req.url!, auth: req.headers.authorization });
  req.resume().on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_test${seen.length}`, 'anthropic-ratelimit-unified-status': 'allowed' });
    res.write(EV1);
    setTimeout(() => res.end(EV2), 20);
  });
};

test('router streams SSE verbatim and logs one ledger row; no certs -> HTTP only', async (t) => {
  const seen: { path: string; auth?: string }[] = [];
  const { base, ledger, stdout: out } = await startRouter(t, { ...(await fakeUpstream(t, sse(seen))), LEDGER_PATH: undefined as any });
  assert.match(out(), /transparent mode off \(no certs in TLS_DIR\)/);
  // no LEDGER_PATH -> $HOME/.agent-router/ledger.sqlite (dir 700), and the ledger that sat next to the source moved there
  assert.equal(statSync(dirname(ledger)).mode & 0o777, 0o700);
  assert.match(out(), /ledger moved: .*\/src\/ledger\.sqlite -> .*\/\.agent-router\/ledger\.sqlite/);
  assert.ok(!existsSync(`${dirname(dirname(ledger))}/src/ledger.sqlite`));
  assert.deepEqual(new DatabaseSync(ledger).prepare('select x from moved').all().map((r: any) => r.x), [1]);

  const res = await fetch(`${base}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-secret-token', 'content-type': 'application/json' },
    body: '{"model":"claude-opus-5","stream":true,"messages":[]}',
  });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const chunks: string[] = [];
  for (let r; !(r = await reader.read()).done;) chunks.push(dec.decode(r.value));
  assert.equal(chunks[0], EV1, 'first event must arrive before the second is sent (no buffering)');
  assert.equal(chunks.join(''), EV1 + EV2);

  const health = await (await fetch(`${base}/router/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.upstream.host, 'api.anthropic.com'); assert.equal(health.upstream.ip, '127.0.0.1');
  assert.deepEqual(seen.map((s) => s.path), ['/v1/messages?beta=true'], 'health must not reach upstream');
  assert.equal(seen[0].auth, 'Bearer sk-secret-token');

  const rows = new DatabaseSync(ledger).prepare('select * from requests').all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_id, 'req_test1');
  assert.equal(rows[0].model, 'claude-opus-5');
  assert.equal(rows[0].stream, 1);
  assert.equal(rows[0].status, 200);
  assert.equal(JSON.parse(rows[0].ratelimit_json)['anthropic-ratelimit-unified-status'], 'allowed');
  const stdout = out();
  assert.ok(!stdout.includes('sk-secret') && !JSON.stringify(rows).includes('sk-secret'), 'token leaked');
});

// ---- P2/P4: multi-account routing against a fake upstream + fake OAuth token endpoint ----
// Fake tokens only. Every string in SECRETS must never reach router stdout or the ledger file.
const SECRETS = ['tok-home-fake', 'tok-xkey-fake', 'tok-b-fake', 'tok-c-old', 'tok-c-new', 'tok-d-fake'];
const WHO: Record<string, string> = { 'Bearer tok-home-fake': 'home', 'Bearer tok-b-fake': 'acct-b', 'Bearer tok-c-new': 'acct-c', 'Bearer tok-d-fake': 'acct-d' };

async function setup(t: TestContext, env: Record<string, string> = {}) {
  const s = {
    seen: [] as { who: string; xkey?: string; body: string; enc?: string; src?: string }[],
    util: {} as Record<string, number>, util7: {} as Record<string, number>, fail: {} as Record<string, number>,
    refreshes: [] as any[], refreshStatus: 200, n: 0, usage: null as any, // usage: echoed as the response's top-level `usage`
    reset: 0, // epoch s sent as the 5h and 7d window reset (the limits estimator groups readings by it); 0 = no reset headers
  };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      if (req.url === '/oauth/token') {
        s.refreshes.push(JSON.parse(body));
        if (s.refreshStatus !== 200) return res.writeHead(s.refreshStatus).end('{"error":"invalid_grant"}');
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'tok-c-new', refresh_token: 'tok-c-new-r', expires_in: 3600 }));
      }
      const who = WHO[req.headers.authorization ?? ''] ?? 'unknown';
      s.seen.push({ who, xkey: req.headers['x-api-key'] as string, body, enc: req.headers['content-encoding'] as string, src: req.headers['x-agent-router-source'] as string });
      const h = { 'content-type': 'application/json', 'request-id': `req_${++s.n}`, 'anthropic-ratelimit-unified-5h-utilization': String(s.util[who] ?? 0), 'anthropic-ratelimit-unified-5h-status': 'allowed',
        ...(who in s.util7 && { 'anthropic-ratelimit-unified-7d-utilization': String(s.util7[who]) }),
        ...(s.reset && { 'anthropic-ratelimit-unified-5h-reset': String(s.reset), 'anthropic-ratelimit-unified-7d-reset': String(s.reset) }) };
      if (s.fail[who] > 0) {
        s.fail[who]--;
        return res.writeHead(429, { ...h, 'retry-after': '1', 'anthropic-ratelimit-unified-representative-claim': 'five_hour' }).end('{"type":"error","error":{"type":"rate_limit_error"}}');
      }
      res.writeHead(200, h).end(JSON.stringify({ who, ...(s.usage && { usage: s.usage }) }));
    });
  };
  const oauth = createServer(handler); // the token endpoint is plain http; the API upstream is TLS
  const oauthPort = await listen(oauth);
  t.after(() => oauth.close());
  const r = await startRouter(t, { ...(await fakeUpstream(t, handler)), OAUTH_TOKEN_URL: `http://127.0.0.1:${oauthPort}/oauth/token`, ...env });
  const tmp = mkdtempSync(`${tmpdir()}/router-acct-`);
  const api = (path: string, body?: unknown) => fetch(`${r.base}/router/${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }).then((x) => x.json());
  const creds = (dir: string, access: string, expiresAt = Date.now() + 3600e3) => writeFileSync(`${dir}/.credentials.json`,
    JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: `${access}-r`, expiresAt, scopes: ['user:inference'], subscriptionType: 'max' } }));
  // add an oauth account via the management API, give it fake creds, and `check` it healthy
  const addAcct = async (id: string, access: string, expiresAt?: number) => {
    const a = await api('accounts', { id, config_dir: `${tmp}/${id}` });
    creds(a.config_dir, access, expiresAt);
    return { ...a, check: await api(`accounts/${id}/check`, {}) };
  };
  const msg = async (session: string | null, extra: Record<string, unknown> = {}, hdrs: Record<string, string> = {}) => {
    const res = await fetch(`${r.base}/v1/messages`, {
      method: 'POST', headers: { authorization: 'Bearer tok-home-fake', 'x-api-key': 'tok-xkey-fake', 'content-type': 'application/json', ...hdrs },
      body: JSON.stringify({ model: 'claude-haiku-4', ...(session && { metadata: { user_id: JSON.stringify({ device_id: 'dev', account_uuid: 'uuid-home', session_id: session }) } }),
        messages: [{ role: 'user', content: 'hi' }], ...extra }),
    });
    return { status: res.status, ...(await res.json()) };
  };
  const db = new DatabaseSync(r.ledger, { readOnly: true, timeout: 2000 });
  t.after(() => db.close());
  // the requests row is written after the response body ends, so give the router a beat
  const rows = async (sql: string, ...a: any[]) => { await new Promise((ok) => setTimeout(ok, 30)); return db.prepare(sql).all(...a) as any[]; };
  const noLeak = () => {
    const dir = dirname(r.ledger);
    const files = readdirSync(dir).filter((f) => f.startsWith('ledger.sqlite')).map((f) => readFileSync(`${dir}/${f}`, 'latin1')).join('');
    for (const x of SECRETS) {
      assert.ok(!r.stdout().includes(x), `${x} leaked to stdout`);
      assert.ok(!files.includes(x), `${x} leaked to ledger`);
    }
  };
  return { s, ...r, api, addAcct, msg, rows, noLeak, tmp };
}

test('session key, sticky routing, rotation at session boundary, token swap', async (t) => {
  const h = await setup(t);
  assert.equal((await h.addAcct('acct-b', 'tok-b-fake')).check.ok, true);
  h.s.util = { home: 0.5, 'acct-b': 0.2 };

  assert.equal((await h.msg('s1')).who, 'home', 'unknown utilization on both -> tie -> home');
  assert.equal((await h.msg('s1')).who, 'home', 'sticky even though acct-b now looks less used');
  assert.equal((await h.msg('s2')).who, 'acct-b', 'new session lands on the least-utilized account');
  assert.equal((await h.msg('s2')).who, 'acct-b');

  // fallback session key: sha256(system[0] text + first user text)[:16]
  await h.msg(null, { system: [{ type: 'text', text: 'sys' }] });
  const fb = createHash('sha256').update('syshi').digest('hex').slice(0, 16);

  assert.deepEqual((await h.rows('select session_key, account_id from requests order by id')).map((r) => [r.session_key, r.account_id]),
    [['s1', 'home'], ['s1', 'home'], ['s2', 'acct-b'], ['s2', 'acct-b'], [fb, 'acct-b']]);
  const ss = Object.fromEntries((await h.rows('select * from sessions')).map((r) => [r.session_key, r]));
  assert.equal(ss.s1.account_id, 'home'); assert.equal(ss.s1.request_count, 2); assert.equal(ss.s1.last_model, 'claude-haiku-4');
  assert.equal(ss.s2.account_id, 'acct-b');

  // token swap: oauth gets its own bearer and no x-api-key; home is untouched; body (metadata) untouched
  const home = h.s.seen[0], b = h.s.seen[2];
  assert.equal(home.who, 'home'); assert.equal(home.xkey, 'tok-xkey-fake');
  assert.equal(b.who, 'acct-b'); assert.equal(b.xkey, undefined);
  assert.equal(JSON.parse(JSON.parse(b.body).metadata.user_id).account_uuid, 'uuid-home');

  const accts = Object.fromEntries((await h.api('accounts')).map((a: any) => [a.id, a]));
  assert.equal(accts.home.util_5h, 0.5); assert.equal(accts.home.pinned_sessions, 1); assert.equal(accts['acct-b'].status, 'ok');
  h.noLeak();
});

test('429 on pinned account -> cooldown, replay elsewhere, migration logged, pin moves', async (t) => {
  const h = await setup(t);
  await h.addAcct('acct-b', 'tok-b-fake');
  h.s.util = { home: 0.1, 'acct-b': 0.5 };
  assert.equal((await h.msg('s1')).who, 'home');

  h.s.fail.home = 1;
  const t0 = Date.now();
  const r = await h.msg('s1');
  assert.equal(r.status, 200); assert.equal(r.who, 'acct-b', 'replayed on the other account');

  const home = (await h.rows(`select * from accounts where id = 'home'`))[0];
  assert.ok(home.cooling_until >= t0 + 1000 && home.cooling_until < Date.now() + 1500, 'cooldown from retry-after: 1');
  assert.equal(home.cooling_reason, '429 five_hour');
  const [failed, final] = (await h.rows('select * from requests order by id')).slice(1);
  assert.deepEqual([failed.status, failed.account_id, failed.retry_of, failed.request_id], [429, 'home', null, 'req_2']);
  assert.deepEqual([final.status, final.account_id, final.retry_of, final.request_id], [200, 'acct-b', failed.id, 'req_3']);
  const [m] = (await h.rows('select * from migrations'));
  assert.deepEqual([m.session_key, m.from_account, m.to_account, m.request_id, m.reason], ['s1', 'home', 'acct-b', 'req_3', '429 five_hour']);
  assert.ok(m.est_cost_tokens > 0);
  assert.equal((await h.rows(`select forced_switches from sessions where session_key = 's1'`))[0].forced_switches, 1);

  assert.equal((await h.msg('s1')).who, 'acct-b', 'session stays on the new account');
  assert.equal((await h.api('accounts')).find((a: any) => a.id === 'home').status, 'cooling');
  await new Promise((ok) => setTimeout(ok, 1100));
  assert.equal((await h.msg('s3')).who, 'home', 'cooldown over: home pickable for new sessions');
  assert.equal((await h.msg('s1')).who, 'acct-b', 'migrated session stays pinned');
  h.noLeak();
});

test('all accounts cooling -> 503 router_no_healthy_account', async (t) => {
  const h = await setup(t);
  h.s.fail.home = 1;
  assert.equal((await h.msg('s1')).status, 429, 'no other account: the 429 passes through');
  const r = await h.msg('s1');
  assert.equal(r.status, 503); assert.equal(r.error.type, 'router_no_healthy_account');
  assert.equal(h.s.seen.length, 1, '503 never reaches upstream');
  h.noLeak();
});

test('oauth refresh: expired token refreshed + written back; refresh 400 -> needs_login', async (t) => {
  const h = await setup(t);
  await h.api('accounts/home/disable', {});
  const c = await h.addAcct('acct-c', 'tok-c-old', Date.now() - 1000);
  assert.equal(c.check.ok, true);
  assert.deepEqual(h.s.refreshes.map((x) => [x.grant_type, x.refresh_token, x.client_id]), [['refresh_token', 'tok-c-old-r', '9d1c250a-e61b-44d9-88ed-5944d1962f5e']]);
  const f = `${c.config_dir}/.credentials.json`;
  const blob = JSON.parse(readFileSync(f, 'utf8')).claudeAiOauth;
  assert.equal(blob.accessToken, 'tok-c-new'); assert.equal(blob.refreshToken, 'tok-c-new-r'); assert.ok(blob.expiresAt > Date.now() + 3000e3);
  assert.equal(blob.subscriptionType, 'max', 'other fields kept');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(c.config_dir), ['.credentials.json'], 'atomic write left no temp file');
  assert.equal((await h.msg('s1')).who, 'acct-c', 'upstream saw the refreshed token');

  // acct-d: valid at check time, enters the 5-min refresh window, then refresh is rejected
  h.s.util = { 'acct-c': 0.9 };
  await h.msg('s1');
  assert.equal((await h.addAcct('acct-d', 'tok-d-fake', Date.now() + 5 * 60_000 + 1000)).check.ok, true);
  await new Promise((ok) => setTimeout(ok, 1100));
  h.s.refreshStatus = 400;
  assert.equal((await h.msg('s2')).who, 'acct-c', 'acct-d skipped after refresh 400');
  const d = (await h.api('accounts')).find((a: any) => a.id === 'acct-d');
  assert.equal(d.needs_login, 1); assert.equal(d.status, 'needs_login');
  h.noLeak();
});

test('management API: add, disable, manual pin, remove, UI', async (t) => {
  const h = await setup(t);
  const add = await h.api('accounts', { id: 'acct-b', config_dir: `${h.tmp}/b` });
  assert.ok(existsSync(`${h.tmp}/b`));
  assert.equal(add.login_cmd, `CLAUDE_CONFIG_DIR=${h.tmp}/b claude auth login`);
  assert.equal((await h.api('accounts')).find((a: any) => a.id === 'acct-b').status, 'needs_login', 'not pickable before login');
  assert.equal((await h.api('accounts/acct-b/check', {})).ok, false);
  writeFileSync(`${h.tmp}/b/.credentials.json`, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-b-fake', refreshToken: 'x', expiresAt: Date.now() + 3600e3 } }));
  assert.equal((await h.api('accounts/acct-b/check', {})).ok, true);

  h.s.util = { home: 0.9 };
  await h.msg('s0');
  await h.api('accounts/acct-b/disable', {});
  assert.equal((await h.msg('s1')).who, 'home', 'disabled account excluded from pick');
  await h.api('accounts/acct-b/enable', {});

  await h.api('sessions/s1/pin', { account_id: 'acct-b' });
  assert.equal((await h.msg('s1')).who, 'acct-b', 'manual pin takes effect on the next request');
  const [m] = (await h.rows(`select * from migrations where reason = 'manual'`));
  assert.deepEqual([m.session_key, m.from_account, m.to_account], ['s1', 'home', 'acct-b']);

  assert.equal((await h.api('accounts/home/remove', {})).error.type, 'cannot_remove_home');
  for (const d of ['fault429', 'fake-util']) assert.equal((await fetch(`${h.base}/router/accounts/home/${d}`, { method: 'POST', body: '{}' })).status, 404, `${d} needs DRILLS=1`);
  assert.equal((await h.api('accounts/acct-b/remove', {})).ok, true);
  assert.equal((await h.msg('s1')).who, 'home', 'pin to a removed account falls back');
  assert.match((await h.rows(`select reason from migrations order by ts desc limit 1`))[0].reason, /removed/);

  for (const p of ['', 'ui']) {
    const res = await fetch(`${h.base}/router/${p}`);
    assert.match(res.headers.get('content-type')!, /text\/html/);
    const html = await res.text();
    assert.match(html, /<title>agent-router<\/title>/);
    for (const route of ['#overview', '#accounts', '#cache', '#cost', '#insights']) assert.ok(html.includes(`href="${route}"`), `${route} missing`);
  }
  const health = await h.api('health');
  assert.equal(health.accounts, 1); assert.equal(health.sessions, 2);
  assert.equal((await h.api('stats')).length, 4); assert.ok(Array.isArray(await h.api('sessions')));
  h.noLeak();
});

test('gzip response bytes and content-encoding pass through untouched', async (t) => {
  const gz = gzipSync(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'hi '.repeat(200) }] }));
  let acceptEncoding;
  const { base } = await startRouter(t, await fakeUpstream(t, (req, res) => {
    acceptEncoding = req.headers['accept-encoding'];
    req.resume().on('end', () => res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': gz.length, 'request-id': 'req_gz' }).end(gz));
  }));
  const r = await raw({ port: Number(new URL(base).port), headers: { 'accept-encoding': 'gzip' } }, '{"model":"m"}');
  assert.equal(acceptEncoding, 'gzip');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.equal(r.headers['content-length'], String(gz.length));
  assert.ok(r.body.equals(gz), 'client got the exact gzipped bytes');
});

test('transparent listener: TLS as api.anthropic.com on 127.0.0.1 and ::1, streams verbatim, ledger row', async (t) => {
  const seen: { path: string; auth?: string }[] = [];
  const up = await fakeUpstream(t, sse(seen));
  const TLS_PORT = String(await freePort());
  const r = await startRouter(t, { ...up, TLS_DIR: CERTS, TLS_PORT });
  await r.waitFor(/transparent mode on/);
  const body = JSON.stringify({ model: 'claude-opus-5', stream: true, metadata: { user_id: JSON.stringify({ session_id: 'sess-t' }) } });
  for (const host of ['127.0.0.1', '::1']) {
    const res = await raw({ port: Number(TLS_PORT), host, tls: true, path: '/v1/messages?beta=true', headers: { authorization: 'Bearer sk-home' } }, body);
    assert.equal(res.status, 200);
    assert.equal(res.chunks[0].toString(), EV1, 'streamed, not buffered');
    assert.equal(res.body.toString(), EV1 + EV2);
  }
  assert.deepEqual(seen, [{ path: '/v1/messages?beta=true', auth: 'Bearer sk-home' }, { path: '/v1/messages?beta=true', auth: 'Bearer sk-home' }]);
  await new Promise((ok) => setTimeout(ok, 30));
  const rows = new DatabaseSync(r.ledger).prepare('select session_key, request_id, status from requests').all() as any[];
  assert.deepEqual(rows.map((x) => ({ ...x })), [{ session_key: 'sess-t', request_id: 'req_test1', status: 200 }, { session_key: 'sess-t', request_id: 'req_test2', status: 200 }]);

  // wildcard bind is guarded: a non-loopback peer (our own LAN address) is dropped before TLS
  const lan = Object.values(networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal)?.address;
  if (lan) await assert.rejects(raw({ port: Number(TLS_PORT), host: lan, tls: true }, body));

  // port already taken -> log and keep serving HTTP, never crash
  const r2 = await startRouter(t, { ...up, TLS_DIR: CERTS, TLS_PORT });
  await r2.waitFor(/transparent mode off \(:\d+ EADDRINUSE\)/);
  assert.equal((await (await fetch(`${r2.base}/router/health`)).json()).ok, true);
});

test('gzipped request body (desktop CLI): parsed for session/model, forwarded raw', async (t) => {
  const h = await setup(t);
  const plain = JSON.stringify({ model: 'claude-fable-5-1', metadata: { user_id: JSON.stringify({ device_id: 'dev', account_uuid: 'uuid-home', session_id: 'sg' }) }, messages: [{ role: 'user', content: 'hi' }] });
  const res = await fetch(`${h.base}/v1/messages`, { method: 'POST', body: gzipSync(plain),
    headers: { authorization: 'Bearer tok-home-fake', 'content-type': 'application/json', 'content-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  const up = h.s.seen.at(-1)!;
  assert.equal(up.enc, 'gzip'); // router did not decompress what it forwards
  const [row] = await h.rows("select session_key, model from requests where session_key = 'sg'");
  assert.deepEqual([row.session_key, row.model], ['sg', 'claude-fable-5-1']);
  const [sess] = await h.rows("select last_model, request_count from sessions where session_key = 'sg'");
  assert.deepEqual([sess.last_model, sess.request_count], ['claude-fable-5-1', 1]);
  h.noLeak();
});

// ---- P3: fingerprints, transcript join, burst attribution, settings ----
const h16 = (x: string) => createHash('sha256').update(x).digest('hex').slice(0, 16);
async function until<T>(f: () => Promise<T> | T, what: string, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((ok) => setTimeout(ok, 25))) { const v = await f(); if (v) return v; }
  assert.fail(`timed out: ${what}`);
}
// one transcript `assistant` row, shaped like CLI 2.1.28x writes them
const arow = (rid: string, u: { in: number; read: number; create: number; out?: number }, content: any[] = [{ type: 'text', text: 'x' }], session = 'tj') => JSON.stringify({
  type: 'assistant', requestId: rid, sessionId: session, cwd: '/tmp/proj-x', apiBlockIndex: 1, timestamp: new Date().toISOString(), uuid: rid + Math.random(),
  message: { model: 'claude-haiku-4', content, usage: { input_tokens: u.in, output_tokens: u.out ?? 50, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.create,
    cache_creation: { ephemeral_1h_input_tokens: u.create, ephemeral_5m_input_tokens: 0 }, output_tokens_details: { thinking_tokens: 7 } } },
}) + '\n';

test('fingerprints: hashes and counts per /v1/messages, tool names only when the tool list changes, no body text stored', async (t) => {
  const h = await setup(t);
  const body = (bill: string, tools: string[]) => ({
    system: [{ type: 'text', text: `x-anthropic-billing-header: cch=${bill}` }, { type: 'text', text: 'sys' }], tools: tools.map((name) => ({ name, input_schema: {} })),
    messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>r</system-reminder>' }, { type: 'text', text: 'secret-prompt-text' }] },
      { role: 'assistant', content: 'ok' }, { role: 'user', content: 'more' }],
  });
  await h.msg('f1', body('a', ['Read', 'Bash']), { 'user-agent': 'claude-cli/2.1.281 (external, claude-desktop)' });
  await h.msg('f1', body('b', ['Read', 'Bash']));
  await h.msg('f1', body('c', ['Read', 'Bash', 'Grep']));
  const [a, b, c] = await h.rows('select * from requests order by id');
  assert.deepEqual([a.system_hash, a.tools_hash, a.tools_count, a.msg_count, a.first_user_hash, a.ua_kind],
    [h16('sys'), h16('Read\nBash'), 2, 3, h16('secret-prompt-text'), 'desktop'], 'billing header and system-reminders excluded');
  assert.ok(a.context_est > 50); assert.equal(a.tool_names_json, '["Read","Bash"]');
  assert.equal(b.system_hash, a.system_hash); assert.equal(b.tool_names_json, null); assert.equal(b.ua_kind, 'cli');
  assert.equal(c.tools_count, 3); assert.equal(c.tool_names_json, '["Read","Bash","Grep"]');
  assert.deepEqual([a.tools_loaded, a.tools_deferred, a.effort, a.speed, a.beta_hash, a.image_count, a.cli_version], [2, 0, null, null, null, 0, '2.1.281']);
  // cache-key fields: a deferred definition (defer_loading) is in neither the hash, the names nor the loaded count; effort, speed,
  // the sorted beta list (hashed), image blocks (also inside tool results) and the CLI version are recorded
  const d0 = body('d', ['Read', 'Bash', 'Grep']);
  await h.msg('f1', { ...d0, tools: [...d0.tools, { name: 'mcp__x__y', defer_loading: true, input_schema: {} }], output_config: { effort: 'high' }, speed: 'fast',
    messages: [...d0.messages, { role: 'user', content: [{ type: 'image', source: {} }, { type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: {} }] }] }] },
    { 'anthropic-beta': 'b-2, a-1', 'user-agent': 'claude-cli/2.1.300 (external, cli)' });
  const d = (await h.rows('select * from requests order by id'))[3];
  assert.deepEqual([d.tools_count, d.tools_loaded, d.tools_deferred, d.tools_hash, d.tool_names_json, d.effort, d.speed, d.beta_hash, d.image_count, d.cli_version],
    [4, 3, 1, c.tools_hash, null, 'high', 'fast', h16('a-1,b-2'), 2, '2.1.300']);
  assert.ok(d.tools_tok > 0 && d.tools_tok < 40, 'size of the loaded definitions only');
  // per-server totals ('' = built-in tools), stored when the thread's tool list changes: mcp__<server>__<tool> names the server
  assert.deepEqual([a, b, c, d].map((r) => r.tool_servers_json && JSON.parse(r.tool_servers_json)), [{ '': { loaded: 2, deferred: 0, def_tokens: 16 } }, null, { '': { loaded: 3, deferred: 0, def_tokens: 24 } },
    { '': { loaded: 3, deferred: 0, def_tokens: 24 }, x: { loaded: 0, deferred: 1, def_tokens: 15 } }]);
  const dir = dirname(h.ledger);
  assert.ok(!readdirSync(dir).map((f) => readFileSync(`${dir}/${f}`, 'latin1')).join('').includes('secret-prompt-text'), 'request body text stored');
  assert.match(h.stdout(), /user-agent shape: claude-cli\/N\.N\.N \(external, claude-desktop\)/);
  h.noLeak();
});

test('tailer: joins transcript usage on requestId, records tool_use, persists offsets, joins rows the ledger logs later', async (t) => {
  const proj = mkdtempSync(`${tmpdir()}/router-proj-`);
  const h = await setup(t, { CLAUDE_PROJECTS_DIR: proj });
  await h.msg('tj'); await h.msg('tj'); // req_1, req_2
  mkdirSync(`${proj}/-tmp-proj-x`);
  const f = `${proj}/-tmp-proj-x/tj.jsonl`;
  writeFileSync(f, JSON.stringify({ type: 'user', sessionId: 'tj', message: { role: 'user', content: 'hi' } }) + '\n'
    + arow('req_1', { in: 3, read: 1000, create: 200 }, [{ type: 'thinking', thinking: '' }])
    + arow('req_1', { in: 3, read: 1000, create: 200 }, [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }])
    + arow('req_2', { in: 4, read: 1200, create: 50 }));
  const db = new DatabaseSync(h.ledger, { timeout: 2000 });
  t.after(() => db.close());
  const row = (rid: string) => db.prepare('select * from requests where request_id = ?').get(rid) as any;
  await until(() => row('req_2').in_tok === 4, 'req_2 joined');
  const r1 = row('req_1');
  assert.deepEqual([r1.in_tok, r1.out_tok, r1.cache_read, r1.cache_create, r1.cache_1h, r1.cache_5m, r1.thinking_tok, r1.session_id, r1.api_block_index, r1.model_from_transcript, r1.jsonl_path],
    [3, 50, 1000, 200, 200, 0, 7, 'tj', 1, 'claude-haiku-4', f]);
  assert.equal(r1.usage_src, 'transcript', 'the response carried no usage, so the tailer filled it');
  assert.deepEqual({ ...(db.prepare('select * from tool_uses').get() as any) }, { id: 'tu1', request_id: 'req_1', name: 'Bash', arg: null });
  assert.equal((db.prepare(`select cwd from sessions where session_key = 'tj'`).get() as any).cwd, '/tmp/proj-x');
  const off = () => (db.prepare('select offset from tail_offsets where path = ?').get(f) as any)?.offset;
  await until(() => off() === statSync(f).size, 'offset persisted');

  // appended row only: req_1 is not re-read. And the transcript row for req_3 lands before the router logs req_3.
  db.prepare(`update requests set in_tok = -1 where request_id = 'req_1'`).run();
  appendFileSync(f, arow('req_3', { in: 9, read: 0, create: 900 }));
  await until(() => off() === statSync(f).size, 'appended row consumed');
  await h.msg('tj'); // req_3
  await until(() => row('req_3')?.in_tok === 9, 'late ledger row joined');
  assert.equal(row('req_1').in_tok, -1, 'only the appended bytes were processed');
  h.noLeak();
});

test('session titles + subagents: custom-title over first prompt, project, agent rows nested with joined counts', async (t) => {
  const proj = mkdtempSync(`${tmpdir()}/router-proj-`);
  const h = await setup(t, { CLAUDE_PROJECTS_DIR: proj });
  await h.msg('st'); await h.msg('st'); // req_1 (session), req_2 (its subagent: same metadata session_id)
  mkdirSync(`${proj}/-tmp-proj-x/st/subagents`, { recursive: true });
  const f = `${proj}/-tmp-proj-x/st.jsonl`, row = (o: any) => JSON.stringify(o) + '\n';
  writeFileSync(f, row({ type: 'user', sessionId: 'st', cwd: '/tmp/proj-x', message: { role: 'user', content: '<system-reminder>r</system-reminder>fix the  login\nbug' } })
    + arow('req_1', { in: 1, read: 100, create: 10 }, undefined, 'st'));
  const title = async () => (await h.api('sessions')).find((s: any) => s.session_key === 'st')?.title;
  await until(async () => (await title()) === 'fix the login bug', 'fallback title from first typed prompt');
  appendFileSync(f, row({ type: 'custom-title', customTitle: 'Login fix', sessionId: 'st' }));
  writeFileSync(`${proj}/-tmp-proj-x/st/subagents/agent-x.jsonl`, row({ type: 'user', sessionId: 'st', message: { role: 'user', content: 'Investigate the login flow' } })
    + row({ type: 'agent-name', agentName: 'login-scout', sessionId: 'st' }) + arow('req_2', { in: 5, read: 300, create: 40 }, undefined, 'st'));
  const s = await until(async () => (await h.api('sessions')).find((s: any) => s.title === 'Login fix' && s.agents[0]?.requests), 'title + agent joined');
  assert.deepEqual([s.session_key, s.project, s.request_count], ['st', 'proj-x', 2], 'session counts stay totals');
  assert.deepEqual(s.agents.map(({ last_ts, ...a }: any) => a), [{ agent_id: 'x', name: 'login-scout', requests: 1, cache_read: 300, cache_create: 40 }]);
  assert.deepEqual((await h.rows('select request_id, agent_id from requests order by id')).map((r) => [r.request_id, r.agent_id]), [['req_1', null], ['req_2', 'x']]);
  h.noLeak();
});

test('burst attribution: cold first turn and big growth turn are not bursts; tool list change on turn 3 (avoidable), idle gap on turn 5 (not)', async (t) => {
  const proj = mkdtempSync(`${tmpdir()}/router-proj-`);
  const h = await setup(t, { CLAUDE_PROJECTS_DIR: proj });
  const tools = (n: string[]) => ({ tools: n.map((name) => ({ name })) });
  for (const n of [['A', 'B'], ['A', 'B'], ['A', 'B', 'C'], ['A', 'B', 'C'], ['A', 'B', 'C']]) await h.msg('sb', tools(n)); // req_1..5
  await h.rows('select 1');
  const db = new DatabaseSync(h.ledger, { timeout: 2000 });
  t.after(() => db.close());
  db.prepare(`update requests set ts = ts - 7200000 where request_id in ('req_1', 'req_2', 'req_3', 'req_4')`).run(); // 2h gap before turn 5
  mkdirSync(`${proj}/p`);
  // [in, read, create]; context = their sum: 20k cold start, +40k growth (30k written), +2k with a 30k re-write (tools), +1k, idle re-write
  const u = [[10, 0, 20000], [10000, 20000, 30000], [10, 31990, 30000], [10, 62000, 1000], [10, 0, 64000]];
  writeFileSync(`${proj}/p/sb.jsonl`, u.map(([inp, read, create], i) => arow(`req_${i + 1}`, { in: inp, read, create }, undefined, 'sb')).join(''));
  await until(() => (db.prepare(`select cache_create from requests where request_id = 'req_5'`).get() as any).cache_create === 64000, 'joined');

  const c = await h.api('cache?session=sb&days=1');
  assert.equal(c.turns.length, 5);
  assert.equal(c.turns[0].burst.cause, 'first turn, cold cache');
  assert.equal(c.turns[1].burst, null, 'wrote 30k but added 40k: growth, not a burst');
  assert.deepEqual(c.bursts.map((b: any) => [b.i, b.cause, b.avoidable, b.delta]), [
    [5, 'cache lifetime expired (1h cache, idle 120 min)', false, 64000],
    [3, 'tool set changed (2 → 3 loaded tools)', true, 30000],
  ]);
  assert.deepEqual(c.bursts.map((b: any) => [b.kind, b.usd, b.ttl]), [['expired', null, '1h'], ['tools', null, '1h']], 'claude-haiku-4 is not in the price table: no dollars, never a guess');
  assert.deepEqual(c.avoidable, { count: 1, total: 2, usd: 0 });
  assert.equal(c.savings_if_avoided_tokens, 30000);
  assert.equal(c.hit_rate, 113990 / (113990 + 145000 + 10040));

  // the other console views read the same rows
  const o = await h.api('overview');
  assert.equal(o.requests_today, (await h.rows('select count(*) n from requests where ts >= ?', new Date().setHours(0, 0, 0, 0)))[0].n);
  assert.equal(o.live.length, 5); assert.equal(o.live[0].cache, 'write');
  assert.match(o.policy_line, /^new sessions start on home — /);
  const cost = await h.api('cost');
  assert.ok(Array.isArray(cost.windows['5h']));
  assert.deepEqual([cost.usd, cost.unpriced, cost.prices_as_of], [0, 5, '2026-10-01'], 'unpriced requests are counted, not summed');
  const ins = await h.api('insights');
  assert.deepEqual([ins.totals.bursts_avoidable, ins.totals.tokens_saved_est], [1, 30000]);
  assert.equal(ins.unused_tools.loaded, 3); assert.equal(ins.unpriced_requests, 5);
  h.noLeak();
});

test('settings: defaults, validation, prefer_home_until_80 keeps new sessions on home', async (t) => {
  const h = await setup(t);
  const put = (b: unknown) => fetch(`${h.base}/router/settings`, { method: 'PUT', body: JSON.stringify(b) });
  assert.equal((await h.api('settings')).policy, 'sticky_least_utilized');
  assert.equal((await put({ policy: 'round_robin' })).status, 400);
  assert.equal((await put({ nope: 1 })).status, 400);
  await h.addAcct('acct-b', 'tok-b-fake');
  h.s.util = { home: 0.5, 'acct-b': 0.1 };
  assert.equal((await h.msg('p0')).who, 'home', 'tie -> home; home util now known (50%)');
  assert.equal((await h.msg('p1')).who, 'acct-b', 'default policy: least utilized');
  const st = await (await put({ policy: 'prefer_home_until_80' })).json();
  assert.equal(st.policy, 'prefer_home_until_80'); assert.equal(st.route_cutoff_pct, 0.9);
  assert.equal((await h.msg('p2')).who, 'home', 'home at 50% < 80% wins although acct-b is lower');
  assert.match((await h.api('overview')).policy_line, /home — home is under 80%/);
  await put({ policy: 'manual' });
  await h.api('accounts/home/pause', {});
  assert.equal((await h.msg('p3')).status, 503, 'manual: never auto-picks a non-home account for a new session');
  assert.equal((await h.msg('p1')).who, 'acct-b', 'existing pins still served');
  h.noLeak();
});

// ---- migration actual cost, session timeline, context advisor ----
test('migration actual cost: forced 429 replay names its request; a manual pin takes the next request', async (t) => {
  const proj = mkdtempSync(`${tmpdir()}/router-proj-`);
  const h = await setup(t, { CLAUDE_PROJECTS_DIR: proj });
  await h.addAcct('acct-b', 'tok-b-fake');
  h.s.util = { home: 0.1, 'acct-b': 0.5 };
  await h.msg('ma'); h.s.fail.home = 1; await h.msg('ma'); // req_1 home; req_2 429 home -> req_3 acct-b
  await h.api('accounts/home/clear-cooldown', {});
  await h.api('sessions/ma/pin', { account_id: 'home' });
  await h.msg('ma'); // req_4 home
  mkdirSync(`${proj}/p`);
  writeFileSync(`${proj}/p/ma.jsonl`, [['req_1', 20000], ['req_3', 21000], ['req_4', 21500]].map(([rid, c]) => arow(rid as string, { in: 5, read: 0, create: c as number }, undefined, 'ma')).join(''));
  const migs = () => h.api('migrations');
  const ms = await until(async () => { const m = await migs(); return m.every((x: any) => x.actual_cost_tokens != null) && m; }, 'actuals filled');
  assert.deepEqual(ms.map((m: any) => [m.reason, m.request_id, m.actual_request_id, m.actual_cost_tokens, m.est_cost_tokens > 0]),
    [['manual', null, 'req_4', 21500, false], ['429 five_hour', 'req_3', 'req_3', 21000, true]]);
  assert.equal((await h.api('sessions')).find((s: any) => s.session_key === 'ma').last_switch_cost_actual, 21500);
  h.noLeak();
});

test('session timeline: ordered turns per account, migration and burst attached', async (t) => {
  const proj = mkdtempSync(`${tmpdir()}/router-proj-`);
  const h = await setup(t, { CLAUDE_PROJECTS_DIR: proj });
  await h.addAcct('acct-b', 'tok-b-fake');
  await h.msg('tl'); await h.msg('tl'); // req_1, req_2 home
  await h.api('sessions/tl/pin', { account_id: 'acct-b' });
  await h.msg('tl'); // req_3 acct-b: re-writes the whole context
  mkdirSync(`${proj}/p`);
  writeFileSync(`${proj}/p/tl.jsonl`, [[0, 20000], [20000, 500], [0, 20600]].map(([read, create], i) => arow(`req_${i + 1}`, { in: 10, read, create }, undefined, 'tl')).join(''));
  const tl = await until(async () => { const x = await h.api('sessions/tl/timeline'); return x.turns.at(-1)?.context_total && x; }, 'joined');
  assert.equal(tl.session_key, 'tl');
  assert.deepEqual(tl.turns.map((r: any) => [r.i, r.request_id, r.account_id, r.context_total]), [[1, 'req_1', 'home', 20010], [2, 'req_2', 'home', 20510], [3, 'req_3', 'acct-b', 20610]]);
  assert.deepEqual(tl.turns[2].migration, { from: 'home', to: 'acct-b', reason: 'manual', est: null, actual: 20600 });
  assert.deepEqual(tl.turns[2].burst, { cause: 'account switch', avoidable: false });
  assert.deepEqual([tl.turns[0].burst, tl.turns[0].migration, tl.turns[1].burst], [null, null, null], 'cold start is not a burst');
  h.noLeak();
});

test('context advisor: breakdown + fake Haiku on warn, no repeat, urgent, handoff; no tool output stored', async (t) => {
  const proj = mkdtempSync(`${tmpdir()}/router-proj-`), bin = `${proj}/fake-claude`;
  writeFileSync(bin, '#!/bin/sh\ncat >/dev/null; echo FAKE ADVICE\n', { mode: 0o755 });
  const h = await setup(t, { CLAUDE_PROJECTS_DIR: proj, CLAUDE_BIN: bin, NOTIFY: '0' });
  await fetch(`${h.base}/router/settings`, { method: 'PUT', body: JSON.stringify({ context_windows: { default: 100000 } }) });
  for (let i = 0; i < 4; i++) await h.msg('adv'); // req_1..4
  const row = (o: any) => JSON.stringify({ sessionId: 'adv', timestamp: new Date().toISOString(), ...o }) + '\n';
  const use = (id: string, name: string, input: any) => arow('req_1', { in: 10, read: 0, create: 30000 }, [{ type: 'tool_use', id, name, input }], 'adv');
  const result = (id: string, n: number) => row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'TOOL-OUTPUT-' + 'x'.repeat(n - 12) }] } });
  const f = `${proj}/p/adv.jsonl`;
  mkdirSync(`${proj}/p`);
  writeFileSync(f, row({ type: 'user', message: { role: 'user', content: 'fix the parser' } })
    + ['r1', 'r2', 'r3'].map((id) => use(id, 'Read', { file_path: '/src/parser.ts' }) + result(id, 16000)).join('')
    + use('b1', 'Bash', { command: 'npm test', description: 'run tests' }) + result('b1', 80000)
    + arow('req_2', { in: 10, read: 50000, create: 22000 }, undefined, 'adv')); // 72% of 100k -> warn
  const adv = (): Promise<any[]> => h.api('sessions/adv/advice');
  const [warn] = await until(async () => { const a = await adv(); return a.length && a; }, 'warn advice');
  assert.deepEqual([warn.level, warn.text, warn.window, warn.context_total], ['warn', 'FAKE ADVICE', 100000, 72010]);
  assert.deepEqual(warn.breakdown.top_results[0], { tool: 'Bash', target: 'npm test', tokens: 20000, count: 1 });
  assert.deepEqual(warn.breakdown.files_read_repeatedly, [{ target: '/src/parser.ts', count: 3, tokens: 12000 }]);
  assert.equal(warn.breakdown.pct, 72);
  appendFileSync(f, arow('req_3', { in: 10, read: 72000, create: 3000 }, undefined, 'adv')); // 75%: same level
  await until(async () => (await h.rows(`select cache_create from requests where request_id = 'req_3'`))[0].cache_create === 3000, 'req_3 joined');
  await new Promise((ok) => setTimeout(ok, 200));
  assert.equal((await adv()).length, 1, 'same level does not repeat');
  appendFileSync(f, arow('req_4', { in: 10, read: 75000, create: 15000 }, undefined, 'adv')); // 90% -> urgent
  const [urgent] = await until(async () => { const a = await adv(); return a.length === 2 && a; }, 'urgent advice');
  assert.deepEqual([urgent.level, urgent.text], ['urgent', 'FAKE ADVICE']);
  assert.equal((await h.api('advice'))[0].level, 'urgent');
  const ho = await fetch(`${h.base}/router/sessions/adv/handoff`, { method: 'POST' }).then((x) => x.json());
  assert.equal(ho.text, 'FAKE ADVICE');
  assert.deepEqual((await adv()).map((a) => a.level), ['handoff', 'urgent', 'warn']);
  const s = (await h.api('sessions')).find((x: any) => x.session_key === 'adv');
  assert.deepEqual([s.advice.level, s.handoff.text, Math.round(s.context_pct * 100)], ['urgent', 'FAKE ADVICE', 90]);
  assert.equal((await h.api('health')).claude_bin, bin);
  const dir = dirname(h.ledger);
  assert.ok(!readdirSync(dir).map((x) => readFileSync(`${dir}/${x}`, 'latin1')).join('').includes('TOOL-OUTPUT'), 'tool_result content stored');
  h.noLeak();
});

test('proactive switch before a pinned account fills up; notifications once per switch / warn window; fake-util drill hook', async (t) => {
  const log = `${mkdtempSync(`${tmpdir()}/router-notify-`)}/notify.log`;
  const h = await setup(t, { DRILLS: '1', NOTIFY: '0', NOTIFY_LOG: log });
  const notes = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const put = (b: unknown) => fetch(`${h.base}/router/settings`, { method: 'PUT', body: JSON.stringify(b) });
  await h.addAcct('acct-b', 'tok-b-fake');
  h.s.util = h.s.util7 = { home: 0.96, 'acct-b': 0.1 };
  await h.api('sessions/s0/pin', { account_id: 'acct-b' }); await h.msg('s0'); // acct-b now reads 10%
  await h.api('accounts/acct-b/pause', {});
  assert.equal((await h.msg('s1')).who, 'home'); // home now reads 96% on both windows
  assert.equal((await h.msg('s2')).who, 'home', 'only healthy account');
  assert.deepEqual(notes(), ['home at 96% of its 5h window'], 'warn crossing: one notification per window, not per response');
  await h.api('accounts/acct-b/resume', {});
  await put({ proactive_min_gain: 0.95 });
  assert.equal((await h.msg('s1')).who, 'home', 'acct-b is not 95 points emptier');
  await put({ proactive_min_gain: 0.2, policy: 'manual' });
  assert.equal((await h.msg('s1')).who, 'home', 'manual policy never moves a session');
  await put({ policy: 'sticky_least_utilized' });
  assert.equal((await h.msg('s1')).who, 'acct-b', 'moved before sending');
  const [m, ...more] = await h.rows(`select * from migrations where session_key = 's1'`);
  assert.deepEqual([m.session_key, m.from_account, m.to_account, m.reason, more.length], ['s1', 'home', 'acct-b', 'proactive: home at 96%', 0]);
  assert.equal((await h.rows('select * from requests where status >= 400')).length, 0, 'no failed request, no 429 row');
  assert.equal((await h.rows(`select cooling_until from accounts where id = 'home'`))[0].cooling_until, null, 'home is full, not broken: no cooldown');
  await new Promise((ok) => setTimeout(ok, 1000));
  // a subagent shares the parent's session key (different first message) -> follows the pin
  assert.equal((await h.msg('s1', { messages: [{ role: 'user', content: 'subagent task' }] })).who, 'acct-b', 'stays on acct-b');
  assert.deepEqual(notes(), ['home at 96% of its 5h window', 'home is at 96% of its 5h window — moved ‘s1’ to acct-b']);
  // fake-util: synthetic headers every reader sees; ping-pong guard holds s1 on acct-b for 10 min; the next real response overwrites
  const f = await h.api('accounts/acct-b/fake-util', { util_5h: 0.97, reset_in_s: 3600 });
  assert.equal(f.ratelimit['anthropic-ratelimit-unified-5h-status'], 'allowed');
  assert.equal((await h.api('accounts')).find((a: any) => a.id === 'acct-b').util_5h, 0.97);
  await h.api('accounts/home/fake-util', { util_5h: 0.1, util_7d: 0.1 });
  assert.equal((await h.msg('s1')).who, 'acct-b', 'one proactive move per session per 10 min');
  assert.equal((await h.api('accounts')).find((a: any) => a.id === 'acct-b').util_5h, 0.1, 'real response overwrote the fake');
  assert.equal(notes().length, 3); assert.match(notes()[2], /^acct-b at 97% of its 5h window, resets \w{3} \d\d:\d\d$/);
  h.noLeak();
});

// ---- usage from the response stream, budgets ----
const USAGE_COLS = 'in_tok, out_tok, cache_read, cache_create, cache_1h, cache_5m, usage_src';
test('stream usage: SSE, gzipped SSE, non-stream JSON at log time; malformed SSE -> null usage, response intact; tailer only fills nulls', async (t) => {
  const sseBody = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 10, cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 }, output_tokens: 1 } } })}\n\n`
    + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'say "usage" é' } })}\n\n`
    + `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } })}\n\n` + EV2;
  const bad = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":\n\n' + EV2;
  const gz = gzipSync(sseBody), jsonBody = JSON.stringify({ type: 'message', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  const proj = mkdtempSync(`${tmpdir()}/router-proj-`);
  const { base, ledger, stdout } = await startRouter(t, { CLAUDE_PROJECTS_DIR: proj, ...(await fakeUpstream(t, (req, res) => req.resume().on('end', () => {
    const k = new URL(req.url!, 'http://x').searchParams.get('k')!, h = { 'content-type': k === 'json' ? 'application/json' : 'text/event-stream', 'request-id': `req_${k}` };
    if (k === 'gz') return res.writeHead(200, { ...h, 'content-encoding': 'gzip' }).end(gz);
    if (k === 'json') return res.writeHead(200, h).end(jsonBody);
    const b = Buffer.from(k === 'sse' ? sseBody : bad);
    res.writeHead(200, h); res.write(b.subarray(0, 150)); // split mid-line (and for `sse`, later, mid-character)
    setTimeout(() => res.end(b.subarray(150)), 20);
  }))) });
  const get = (k: string) => raw({ port: Number(new URL(base).port), path: `/v1/messages?k=${k}` }, '{"model":"m","stream":true}');
  const db = new DatabaseSync(ledger, { readOnly: true, timeout: 2000 });
  t.after(() => db.close());
  const row = (k: string) => until(() => db.prepare(`select ${USAGE_COLS}, thinking_tok from requests where request_id = ?`).get(`req_${k}`) as any, `row ${k}`);
  const full = { in_tok: 10, out_tok: 42, cache_read: 1000, cache_create: 300, cache_1h: 200, cache_5m: 100, usage_src: 'stream', thinking_tok: null };

  assert.equal((await get('sse')).body.toString(), sseBody);
  assert.deepEqual({ ...(await row('sse')) }, full, 'usage on the row at log time, no transcript involved');
  assert.ok((await get('gz')).body.equals(gz), 'client got the exact gzipped bytes');
  assert.deepEqual({ ...(await row('gz')) }, full);
  assert.equal((await get('json')).body.toString(), jsonBody);
  assert.deepEqual({ ...(await row('json')) }, { in_tok: 5, out_tok: 7, cache_read: 0, cache_create: 0, cache_1h: null, cache_5m: null, usage_src: 'stream', thinking_tok: null });
  for (const k of ['bad', 'bad2']) {
    const r = await get(k);
    assert.equal(r.status, 200); assert.equal(r.body.toString(), bad, 'malformed SSE still proxied verbatim');
    assert.deepEqual(Object.values({ ...(await row(k)) }), Array(8).fill(null), 'row written, no usage');
  }
  assert.equal(stdout().split('usage: could not parse').length - 1, 1, 'parse failure logged once');
  assert.ok(!stdout().includes('input_tokens'), 'response text logged');

  // the transcript for the same request: usage stays the stream's; the tailer adds what only it knows
  mkdirSync(`${proj}/-p`);
  writeFileSync(`${proj}/-p/s.jsonl`, arow('req_sse', { in: 999, read: 999, create: 999 }) + arow('req_bad', { in: 3, read: 4, create: 5 }));
  await until(async () => (await row('bad')).usage_src === 'transcript', 'tailer filled the row the stream could not');
  assert.deepEqual({ ...(await row('sse')) }, { ...full, thinking_tok: 7 });
});

// one turn on Haiku 4.5 ($/MTok: input 1, 5m write 1.25, 1h write 2, read 0.1, output 5)
const B_USAGE = { input_tokens: 100e3, output_tokens: 20e3, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 300e3, cache_creation: { ephemeral_1h_input_tokens: 200e3, ephemeral_5m_input_tokens: 100e3 } };
const B_USD = 0.1 * 1 + 1 * 0.1 + 0.1 * 1.25 + 0.2 * 2 + 0.02 * 5; // $0.825
const close = (a: number, b: number, what?: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what ?? 'dollars'}: ${a} vs ${b}`);
async function budgetSetup(t: TestContext) {
  const log = `${mkdtempSync(`${tmpdir()}/router-notify-`)}/notify.log`, proj = mkdtempSync(`${tmpdir()}/router-proj-`);
  const h = await setup(t, { DRILLS: '1', NOTIFY: '0', NOTIFY_LOG: log, CLAUDE_PROJECTS_DIR: proj });
  h.s.usage = B_USAGE;
  // a real turn (tools, so /router/cost does not file it under one-shots); the row and the budget check land just after the response ends
  const turn = async (session: string) => { const r = await h.msg(session, { model: 'claude-haiku-4-5', tools: [{ name: 'Read', input_schema: {} }] }); await new Promise((ok) => setTimeout(ok, 40)); return r; };
  return { ...h, proj, turn, notes: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    put: (b: unknown) => fetch(`${h.base}/router/settings`, { method: 'PUT', body: JSON.stringify(b) }) };
}

test('budgets in dollars: list price per turn, project/day budget notifies once at 80% and once at 100%, rate_card override, re-arms when the period rolls', async (t) => {
  const h = await budgetSetup(t);
  assert.deepEqual((await h.api('settings')).budgets, [], 'no budgets (so no stop) until the user adds one');
  // the session's project comes from its transcript cwd
  mkdirSync(`${h.proj}/-p`);
  writeFileSync(`${h.proj}/-p/b1.jsonl`, JSON.stringify({ type: 'user', sessionId: 'b1', cwd: '/tmp/climatefluent', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n');
  await until(async () => (await h.rows(`select cwd from sessions where session_key = 'b1'`))[0]?.cwd, 'cwd from transcript');
  const budget = { id: 'cf', name: 'climatefluent / day', scope: 'project', match: 'climatefluent', period: 'day', limit: 2, action: 'notify', thresholds: [0.8, 1] };
  assert.equal((await h.put({ budgets: [budget] })).status, 200);
  const status = async () => (await h.api('budgets'))[0];

  await h.turn('b1');
  h.s.usage = { ...B_USAGE, cache_creation: undefined }; // no 1h/5m split -> the whole cache write at the 5m price
  await h.turn('other');
  const cost = Object.fromEntries((await h.api('cost')).per_session.map((s: any) => [s.session_key, s.usd]));
  close(cost.b1, B_USD); close(cost.other, 0.1 + 0.1 + 0.3 * 1.25 + 0.1);
  h.s.usage = B_USAGE;
  let st = await status();
  close(st.spent, B_USD, 'only the project counts'); close(st.pct, B_USD / 2);
  assert.deepEqual([st.limit, st.state, st.unpriced, st.period_end > Date.now()], [2, 'ok', 0, true]);
  assert.deepEqual(h.notes(), []);

  await h.turn('b1'); // 1650 = 82%
  assert.equal((await status()).state, 'warn');
  await h.turn('b1'); // 2475 = 123%
  await h.turn('b1'); await h.turn('other');
  assert.equal(h.notes().length, 2, 'one per threshold, none repeated');
  assert.match(h.notes()[0], /^Budget ‘climatefluent \/ day’ at 82% — \$1\.65 of \$2\.00$/);
  assert.match(h.notes()[1], /^Budget ‘climatefluent \/ day’ at 123% — \$2\.4[78] of \$2\.00$/);
  st = await status();
  close(st.spent, 4 * B_USD); close(st.top[0].usd, 4 * B_USD);
  assert.deepEqual([st.state, st.top.map((x: any) => x.label)], ['over', ['hi']]);
  const [ob] = (await h.api('overview')).budgets;
  close(ob.pct, 4 * B_USD / 2); assert.deepEqual([ob.name, ob.state], ['climatefluent / day', 'over']);
  // a rate_card entry overrides the built-in price of the fields it names, for model ids containing its key
  await h.put({ rate_card: { 'haiku-4-5': { output: 10 } } });
  close((await status()).spent, 4 * (B_USD + 0.02 * 5), 'output at $10/MTok');
  await h.put({ rate_card: {} });
  // a request on a model with no price is counted apart and never guessed into the sum
  await h.msg('b1', { tools: [{ name: 'Read', input_schema: {} }] }); // claude-haiku-4: not in the table
  st = await status();
  close(st.spent, 4 * B_USD); assert.equal(st.unpriced, 1);
  assert.deepEqual((await h.rows('select threshold from budget_events order by ts')).map((r) => r.threshold), [0.8, 1]);

  assert.equal((await h.api('clock', { skew_ms: 864e5 })).ok, true); // tomorrow: a new period
  assert.equal((await status()).spent, 0);
  await h.turn('b1'); await h.turn('b1');
  assert.equal(h.notes().length, 3, 're-armed');
  assert.match(h.notes()[2], /at 82%/);
  h.noLeak();
});

test('budgets: stop answers 400 without dialing upstream; count_tokens passes; per-session cap is per session; bad shapes -> 400', async (t) => {
  const h = await budgetSetup(t);
  const b = { id: 'all', name: 'everything today', scope: 'all', match: null, period: 'day', limit: 0.8, action: 'stop', thresholds: [1] };
  for (const bad of [{ ...b, scope: 'galaxy' }, { ...b, limit: '2M' }, { ...b, limit: 0 }, { ...b, scope: 'project' }, { ...b, scope: 'session' }, { ...b, action: 'explode' }, { ...b, thresholds: [2] }, { ...b, id: undefined }])
    assert.equal((await h.put({ budgets: [bad] })).status, 400, JSON.stringify(bad));
  assert.equal((await h.put({ budgets: [b, b] })).status, 400, 'duplicate id');
  assert.equal((await h.put({ budgets: [b] })).status, 200);

  assert.equal((await h.turn('c1')).who, 'home', 'under the limit: passes');
  const seen = h.s.seen.length, r = await h.turn('c1');
  assert.equal(r.status, 400); assert.equal(r.type, 'error'); assert.equal(r.error.type, 'invalid_request_error');
  assert.match(r.error.message, /budget ‘everything today’ is spent: \$0\.8[23] of \$0\.80 at list price today\. It resets \w{3} 00:00\. Raise or remove it at http:\/\/localhost:\d+\/router\/#cost/);
  assert.equal(h.s.seen.length, seen, 'not dialed');
  const [row] = await h.rows('select session_key, account_id, status, request_id, in_tok from requests order by id desc limit 1');
  assert.deepEqual({ ...row }, { session_key: 'c1', account_id: 'home', status: 400, request_id: null, in_tok: null });
  assert.equal(h.notes().length, 1); assert.match(h.notes()[0], /^Budget ‘everything today’ at 103% — \$0\.8[23] of \$0\.80 — requests are now stopped$/);
  const ct = await fetch(`${h.base}/v1/messages/count_tokens`, { method: 'POST', headers: { authorization: 'Bearer tok-home-fake' }, body: '{"model":"claude-haiku-4","messages":[]}' });
  assert.equal(ct.status, 200); assert.equal(h.s.seen.length, seen + 1, 'count_tokens is never blocked');

  // the runaway-agent guard: one cap, measured per session
  await h.put({ budgets: [{ id: 'cap', name: 'per-session cap', scope: 'session', match: null, period: 'session', limit: 0.8, action: 'stop', thresholds: [1] }] });
  assert.equal((await h.turn('c1')).status, 400, 'c1 already spent $0.825');
  assert.equal((await h.turn('c2')).status, 200, 'a second session has its own allowance');
  assert.match((await h.turn('c2')).error.message, /‘per-session cap’ is spent: \$0\.8[23] of \$0\.80 .* in this session/);
  assert.equal((await h.turn('c3')).status, 200);
  assert.equal((await h.api('budgets'))[0].top.length, 3);
  await h.put({ budgets: [] });
  assert.equal((await h.turn('c1')).status, 200, 'budget removed');
  h.noLeak();
});

test('ui.html never reads form.id (shadowed by <input name="id">)', () => {
  assert.ok(!readFileSync(new URL('./ui.html', import.meta.url), 'utf8').includes('e.target.id ==='), 'form.id is shadowed by <input name="id">; use getAttribute'); // regression: Add account did nothing
});

// ---- brain (docs/BRAIN.md): fixture transcripts, a fake `claude`, a temp vault and a temp skills dir ----
const jrow = (sk: string, o: any) => JSON.stringify({ sessionId: sk, cwd: '/tmp/proj-x', timestamp: new Date().toISOString(), ...o }) + '\n';
const tuse = (sk: string, rid: string, id: string, name: string, input: any) => arow(rid, { in: 10, read: 0, create: 100 }, [{ type: 'tool_use', id, name, input }], sk);
const tres = (sk: string, id: string, is_error = false) => jrow(sk, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'TOOL-OUTPUT', ...(is_error && { is_error }) }] } });
// a session that did hands-on work: one prompt, n Bash commands that worked, one file written
const worked = (sk: string, rid: string, n = 8) => jrow(sk, { type: 'user', message: { role: 'user', content: `deploy the worker ${sk}` } })
  + Array.from({ length: n }, (_, i) => tuse(sk, rid, `${sk}-b${i}`, 'Bash', { command: `npx wrangler step-${i}` }) + tres(sk, `${sk}-b${i}`)).join('')
  + tuse(sk, rid, `${sk}-w`, 'Write', { file_path: '/tmp/proj-x/wrangler.toml', content: 'x' }) + tres(sk, `${sk}-w`);
const WRITER = { summary: 'Deployed the worker.', decisions: ['Deploy with wrangler because the project already uses it'], learnings: ['wrangler needs the account id in wrangler.toml'], open_threads: [],
  tags: ['Cloudflare Workers', 'deploy'], skill: { name: 'deploy-worker', description: 'Use when deploying a Cloudflare worker: build, then deploy.', body: '1. Run `npm run build`\n2. Run `npx wrangler deploy`' } };
// the scan's first question: a repeatable skill, not just something worth remembering
const REUSABLE = 'The session worked out a multi-step procedure (commands, tool sequence, or workflow) that the same person would want to repeat in a different project — for example setting up a pipeline, producing a video, deploying a service. A one-off fix or a discussion is not reusable.';
const gateJson = (kind: string, conf: number) => '```json\n' + JSON.stringify({ answers: { reusable: { value: true, confidence: 0.9 }, kind: { value: kind, confidence: conf }, matches: { value: 'new', confidence: 0.9 } } }) + '\n```';

async function brainSetup(t: TestContext, env: Record<string, string> = {}, enable = true) {
  const proj = mkdtempSync(`${tmpdir()}/router-proj-`), tmp = mkdtempSync(`${tmpdir()}/router-brain-`), vault = `${tmp}/vault`, skills = `${tmp}/skills`;
  // fake `claude`: canned output per prompt kind, and one line per call: kind, the --model value, the tagging env var. The last prompt
  // of each kind is kept in prompt.<kind>; while a file `hold` exists the call does not return.
  writeFileSync(`${tmp}/claude`, `#!/bin/sh\np=$(cat)\ncase "$p" in "You are a classifier"*) k=classifier;; *) k=writer;; esac\nprintf '%s' "$p" > ${tmp}/prompt.$k\necho "$k $3 $ANTHROPIC_CUSTOM_HEADERS" >> ${tmp}/calls\nwhile [ -f ${tmp}/hold ]; do sleep 0.05; done\ncat ${tmp}/$k.json\n`, { mode: 0o755 });
  writeFileSync(`${tmp}/classifier.json`, gateJson('skill', 0.85));
  writeFileSync(`${tmp}/writer.json`, JSON.stringify(WRITER));
  // HOME = temp: a real ~/.agent-router/typesafe.key must never turn these into live Jev calls
  const h = await setup(t, { CLAUDE_PROJECTS_DIR: proj, BRAIN_DIR: vault, CLAUDE_SKILLS_DIR: skills, CLAUDE_BIN: `${tmp}/claude`, HOME: tmp, NOTIFY: '0', DRILLS: '1', ...env });
  const put = (b: unknown) => fetch(`${h.base}/router/settings`, { method: 'PUT', body: JSON.stringify(b) });
  const call = async (method: string, path: string, body?: unknown): Promise<[number, any]> => {
    const r = await fetch(`${h.base}/router/brain/${path}`, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
    return [r.status, await r.json()];
  };
  // one routed request for the session, then its transcript; resolves once the tailer has joined the two (the path capture reads)
  const session = async (sk: string, text: (rid: string) => string) => {
    await h.msg(sk);
    const rid = `req_${h.s.n}`, f = `${proj}/-tmp-proj-x/${sk}.jsonl`;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text(rid));
    await until(async () => (await h.rows('select jsonl_path p from requests where request_id = ?', rid))[0]?.p, `${sk} joined`);
    return f;
  };
  if (enable) assert.equal((await put({ brain_enabled: true })).status, 200);
  return { ...h, proj, tmp, vault, skills, put, call, session, read: (rel: string) => readFileSync(`${vault}/${rel}`, 'utf8'),
    calls: () => (existsSync(`${tmp}/calls`) ? readFileSync(`${tmp}/calls`, 'utf8').trim().split('\n') : []) };
}

test('brain capture: note from the transcript, secret redacted, failed command absent, user text kept, retitle renames, own calls skipped', async (t) => {
  const b = await brainSetup(t), SECRET = 'sk-ant-api03-SECRETSECRETSECRET';
  // every shape the scrubber names, in one command
  const MORE = ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github_pat_11ABCDEFG0123456789abcdef', 'AKIAIOSFODNN7EXAMPLE', 'hunter2', 'zzz999', 'wJalrXUtnFEMI', 'MIIEpAIBAAKCAQEA'];
  const leaky = `GH=${MORE[0]} PAT=${MORE[1]} AWS=${MORE[2]} mysql --password=${MORE[3]} "api_key": "${MORE[4]}" AWS_SECRET_ACCESS_KEY=${MORE[5]}\n-----BEGIN RSA PRIVATE KEY-----\n${MORE[6]}\n-----END RSA PRIVATE KEY-----\necho done`;
  await b.session('bs', (rid) => jrow('bs', { type: 'user', message: { role: 'user', content: '<system-reminder>r</system-reminder>deploy the worker' } })
    + jrow('bs', { type: 'user', isMeta: true, message: { role: 'user', content: 'INJECTED-SKILL-TEXT' } })
    + jrow('bs', { type: 'user', message: { role: 'user', content: '<task-notification>agent done</task-notification>' } })
    + tuse('bs', rid, 'b1', 'Bash', { command: 'npm run depoly' }) + tres('bs', 'b1', true)
    + tuse('bs', rid, 'b2', 'Bash', { command: 'npm run deploy' }) + tres('bs', 'b2')
    + tuse('bs', rid, 'b3', 'Bash', { command: `curl -H "Authorization: Bearer ${SECRET}" https://api.example.com/deploy` }) + tres('bs', 'b3')
    + tuse('bs', rid, 'b4', 'Bash', { command: leaky }) + tres('bs', 'b4')
    + tuse('bs', rid, 'w1', 'Write', { file_path: '/tmp/proj-x/wrangler.toml', content: 'x' }) + tres('bs', 'w1'));
  // the brain's own model call: tagged by header, stored in requests.source, never forwarded, never captured
  await b.msg('own', {}, { 'x-agent-router-source': 'brain' });
  assert.equal(b.s.seen.at(-1)!.src, undefined, 'the tagging header must not reach upstream');
  writeFileSync(`${b.proj}/-tmp-proj-x/own.jsonl`, worked('own', `req_${b.s.n}`));
  await until(async () => (await b.rows(`select jsonl_path p from requests where session_key = 'own'`))[0]?.p, 'own joined');
  assert.deepEqual((await b.rows('select session_key k, source from requests order by id')).map((r) => [r.k, r.source]), [['bs', null], ['own', 'brain']]);
  assert.deepEqual((await b.api('sessions')).map((s: any) => s.session_key), ['bs'], 'the router\'s own sessions stay out of the Sessions view');

  assert.deepEqual((await b.call('POST', 'capture', {}))[1].notes, 1);
  const day = new Date().toLocaleDateString('sv'), logs = () => readdirSync(`${b.vault}/wiki/logs`);
  assert.deepEqual(logs(), [`${day} deploy the worker.md`]);
  let note = b.read(`wiki/logs/${logs()[0]}`);
  assert.match(note, /^---\nsession: bs\ntitle: deploy the worker\nproject: proj-x\nstarted: "\d{4}-.*"\nended: ".*"\nturns: 1\nmodels: \[claude-haiku-4\]\naccounts: \[home\]\nusd: 0\n/);
  assert.match(note, /tags: \[session, proj-x\]\n---\n<!-- agent-router:begin -->\n# deploy the worker\n/);
  assert.match(note, /## Asked\n\n- deploy the worker\n\n## Files touched\n\n- `wrangler\.toml`\n\n## Commands run\n\n- `npm run deploy`\n- `curl -H "Authorization: \[redacted\]" https:\/\/api\.example\.com\/deploy`\n- `GH=\[redacted\] PAT=\[redacted\] AWS=\[redacted\] mysql --password=\[redacted\] "api_key": "\[redacted\]" AWS_SECRET_ACCESS_KEY=\[redacted\] \[redacted\] echo done`\n\n## Tools\n\n- Bash × 4\n- Write × 1\n/);
  for (const x of [SECRET, ...MORE, 'depoly', 'TOOL-OUTPUT', 'INJECTED', 'task-notification']) assert.ok(!note.includes(x), `${x} in the note`);
  assert.match(b.read('index.md'), new RegExp(`## Sessions\\n\\n- \\[\\[${day} deploy the worker\\]\\] — proj-x`));
  assert.match(b.read(`wiki/daily/${day}.md`), new RegExp(`## Sessions\\n\\n- \\[\\[${day} deploy the worker\\]\\]`));
  assert.match(b.read('wiki/projects/proj-x.md'), new RegExp(`<!-- agent-router:begin knowledge -->\\n\\n?<!-- agent-router:end knowledge -->[\\s\\S]*## Sessions\\n\\n- \\[\\[${day} deploy the worker\\]\\]`));
  assert.match(b.read('_CLAUDE.md'), /## Folder Map\n\n\| Note type \| Folder \|[\s\S]*`wiki\/logs\/`[\s\S]*`wiki\/projects\/`[\s\S]*`wiki\/daily\/`[\s\S]*`skills\/`[\s\S]*`skills\/candidates\/`/);

  // text outside the markers is the user's: kept on recapture; _CLAUDE.md is never rewritten; a retitled session renames its note
  appendFileSync(`${b.vault}/wiki/logs/${logs()[0]}`, '\nMY OWN NOTE\n');
  writeFileSync(`${b.vault}/_CLAUDE.md`, 'mine now');
  appendFileSync(`${b.proj}/-tmp-proj-x/bs.jsonl`, jrow('bs', { type: 'custom-title', customTitle: 'Worker: deploy/fix' }));
  await until(async () => (await b.rows(`select title from sessions where session_key = 'bs'`))[0].title === 'Worker: deploy/fix', 'retitled');
  assert.deepEqual((await b.call('POST', 'capture', { session: 'bs' }))[1].notes, 1);
  assert.deepEqual(logs(), [`${day} Worker deploy fix.md`]);
  note = b.read(`wiki/logs/${logs()[0]}`);
  assert.match(note, /title: "Worker: deploy\/fix"\n[\s\S]*<!-- agent-router:end -->\n\nMY OWN NOTE\n$/);
  assert.equal(note.split('agent-router:begin').length, 2, 'one generated block, rewritten in place');
  assert.equal(b.read('_CLAUDE.md'), 'mine now');
  assert.match(b.read('index.md'), /Worker deploy fix\]\]/); assert.ok(!b.read('index.md').includes('deploy the worker'));
  assert.equal((await b.call('GET', 'stats'))[1].sessions_captured, 1);
  // a transcript the router never routed (it is older than the ledger): found by its file name
  writeFileSync(`${b.proj}/-tmp-proj-x/old.jsonl`, worked('old', 'req_none', 2));
  await until(async () => (await b.rows(`select 1 from sessions where session_key = 'old'`)).length, 'transcript-only session seen');
  assert.equal((await b.call('POST', 'capture', {}))[1].notes, 2);
  assert.deepEqual(logs(), [`${day} Worker deploy fix.md`, `${day} deploy the worker old.md`]);
  assert.deepEqual(b.calls(), [], 'capture never calls a model');
  b.noLeak();
});

test('brain gate + distill: classifier then writer through the tagged runner; low confidence, pre-filter and bad JSON never reach the writer', async (t) => {
  const b = await brainSetup(t), day = new Date().toLocaleDateString('sv');
  await b.session('bd', (rid) => worked('bd', rid));
  const [status, r] = await b.call('POST', 'distill', { session: 'bd' });
  assert.deepEqual([status, r.gated, r.backend, r.want_skill, r.distilled, r.skill], [200, true, 'model', true, true, 'deploy-worker']);
  assert.deepEqual(r.answers, { reusable: { value: true, confidence: 0.9 }, kind: { value: 'skill', confidence: 0.85 } }, 'fenced JSON is tolerated');
  assert.deepEqual(r.pre, { tool_calls: 9, files: 1, commands: 8 });
  assert.deepEqual(b.calls(), ['classifier haiku x-agent-router-source: brain', 'writer sonnet x-agent-router-source: brain']);
  const [row] = await b.rows(`select * from brain_sessions where session_key = 'bd'`);
  assert.deepEqual([row.gate_backend, JSON.parse(row.gate_json).answers.kind.confidence, row.skill_candidate, row.queued, row.distilled_ts > 0, row.gated_ts > 0], ['model', 0.85, 'deploy-worker', 0, true, true]);
  const note = b.read(row.note_path);
  assert.match(note, /<!-- agent-router:begin distilled -->\n## Distilled\n\nDeployed the worker\.\n\n### Decisions\n\n- Deploy with wrangler because the project already uses it\n\n### Learnings\n\n- wrangler needs[^\n]*\n\nSkill candidate: \[\[skills\/deploy-worker\|deploy-worker\]\]\n<!-- agent-router:end distilled -->/);
  assert.match(note, /^---\nsession: bd\n[\s\S]*\ntags: \[cloudflare-workers, deploy, session, proj-x\]\n---\n/);
  assert.match(note, /## Commands run\n\n- `npx wrangler step-0`/, 'the captured block is still there');
  const skill = b.read('skills/candidates/deploy-worker/SKILL.md');
  assert.equal(skill, '---\nname: deploy-worker\ndescription: "Use when deploying a Cloudflare worker: build, then deploy."\n---\n\n1. Run `npm run build`\n2. Run `npx wrangler deploy`\n');
  assert.ok(!existsSync(`${b.skills}/deploy-worker`), 'a candidate never reaches the skills dir by itself');
  const bullet = `- ${day} · decision · Deploy with wrangler because the project already uses it ([[${day} deploy the worker bd]])`;
  assert.equal(b.read('wiki/projects/proj-x.md').split(bullet).length, 2);
  assert.match(b.read('log.md'), /distill wiki\/logs\/.* -> skill candidate deploy-worker/);

  // a second run of the same session: the same dated bullets are not added twice, the session keeps its own candidate; a run that
  // words things differently replaces that session's bullets instead of piling up
  assert.equal((await b.call('POST', 'distill', { session: 'bd' }))[1].skill, 'deploy-worker');
  assert.equal(b.read('wiki/projects/proj-x.md').split(bullet).length, 2, 'duplicate bullet dropped');
  assert.equal(b.read('wiki/projects/proj-x.md').split(' · learning · ').length, 2);
  writeFileSync(`${b.tmp}/writer.json`, JSON.stringify({ ...WRITER, decisions: ['Deploy with wrangler, as before'] }));
  await b.call('POST', 'distill', { session: 'bd' });
  assert.deepEqual(b.read('wiki/projects/proj-x.md').match(/· decision · [^(]+/g), ['· decision · Deploy with wrangler, as before ']);
  writeFileSync(`${b.tmp}/writer.json`, JSON.stringify(WRITER));
  assert.equal(b.calls().length, 6);

  // low confidence -> the writer is not called
  writeFileSync(`${b.tmp}/classifier.json`, gateJson('skill', 0.4));
  await b.session('bl', (rid) => worked('bl', rid));
  const low = (await b.call('POST', 'distill', { session: 'bl' }))[1];
  assert.deepEqual([low.gated, low.distilled, low.answers.kind.confidence], [false, undefined, 0.4]);
  assert.deepEqual(b.calls().slice(6), ['classifier haiku x-agent-router-source: brain']);
  // …unless the user says so
  assert.deepEqual((await b.call('POST', 'distill', { session: 'bl', force: true }))[1].distilled, true);
  assert.deepEqual(b.calls().slice(7), ['writer sonnet x-agent-router-source: brain']);
  // too little hands-on work: no model call at all
  await b.session('bp', (rid) => worked('bp', rid, 2));
  const pre = (await b.call('POST', 'distill', { session: 'bp' }))[1];
  assert.deepEqual([pre.gated, pre.why, pre.pre.tool_calls], [false, 'prefilter', 3]);
  // an answer that is not the JSON asked for: no gate stored, no writer
  writeFileSync(`${b.tmp}/classifier.json`, 'Sure! I think this is a skill.');
  await b.session('bj', (rid) => worked('bj', rid));
  assert.deepEqual((await b.call('POST', 'distill', { session: 'bj' }))[1], { pre: { tool_calls: 9, files: 1, commands: 8 }, gated: false, why: 'classifier_failed' });
  assert.equal((await b.rows(`select gated_ts from brain_sessions where session_key = 'bj'`))[0].gated_ts, null);
  assert.match(b.stdout(), /brain: classifier did not return the JSON asked for; no gate/);
  assert.equal(b.calls().length, 9);
  assert.deepEqual((await b.call('POST', 'distill', { session: 'nope' })), [404, { error: { type: 'no_note' } }]);
  const st = (await b.call('GET', 'stats'))[1];
  assert.deepEqual([st.sessions_captured, st.distilled, st.candidates, st.promoted, st.classifier_backend], [4, 2, 1, 0, 'model']);
  assert.deepEqual(st.skills.map((k: any) => [k.name, k.status, k.source, k.source_session, k.uses]), [['deploy-worker', 'candidate', 'session', 'bd', 0]]);
  b.noLeak();
});

test('brain classifier: Jev request and answers follow the TypeSafe docs; a 500 falls back to the model backend', async (t) => {
  const reqs: { url: string; auth?: string; body: any }[] = [];
  let fail = false;
  const ts = createServer((req, res) => { let d = ''; req.on('data', (c) => (d += c)).on('end', () => {
    reqs.push({ url: req.url!, auth: req.headers.authorization, body: JSON.parse(d) });
    if (fail) return res.writeHead(500).end('{"error":"boom"}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 392, output_tokens: 65 }, answers: {
      reusable: { type: 'noul', noul: 0.25 }, kind: { type: 'choice', choice: 'project-knowledge', confidence: 0.8, probabilities: { skill: 0.1, 'project-knowledge': 0.85, nothing: 0.05 } } } }));
  }); });
  const port = await listen(ts);
  t.after(() => ts.close());
  const b = await brainSetup(t, { TYPESAFE_URL: `http://127.0.0.1:${port}`, TYPESAFE_API_KEY: 'ts-fake-key' });
  await b.session('bj', (rid) => worked('bj', rid));
  const r = (await b.call('POST', 'distill', { session: 'bj' }))[1];
  assert.deepEqual([reqs.length, reqs[0].url, reqs[0].auth, reqs[0].body.model, Object.keys(reqs[0].body).sort()], [1, '/v1/systemone', 'Bearer ts-fake-key', 'jev-latest', ['model', 'questions', 'state']]);
  assert.match(reqs[0].body.state, /^# deploy the worker bj\n[\s\S]*## Commands run\n\n- `npx wrangler step-0`/);
  const q = reqs[0].body.questions;
  assert.deepEqual(Object.keys(q), ['reusable', 'kind'], 'no `matches` question while no skill exists');
  assert.deepEqual(q.reusable, { type: 'noul', instructions: REUSABLE });
  assert.deepEqual([q.kind.type, typeof q.kind.instructions, Object.keys(q.kind.criteria), Object.values(q.kind.criteria).every((v) => typeof v === 'string')], ['choice', 'string', ['skill', 'project-knowledge', 'nothing'], true]);
  // noul is p(yes) only: value = p >= 0.5, confidence = max(p, 1 - p); choice carries its own confidence
  assert.deepEqual([r.backend, r.gated, r.want_skill, r.distilled, r.skill], ['jev', true, false, true, null]);
  assert.deepEqual(r.answers, { reusable: { value: false, confidence: 0.75 }, kind: { value: 'project-knowledge', confidence: 0.8 } });
  assert.deepEqual(b.calls(), ['writer sonnet x-agent-router-source: brain'], 'Jev answered: the classifier model is not called');
  assert.ok(!existsSync(`${b.vault}/skills/candidates/deploy-worker`), 'the writer\'s skill is dropped when the gate did not ask for one');
  assert.equal((await b.call('GET', 'stats'))[1].classifier_backend, 'jev');

  fail = true;
  await b.session('bk', (rid) => worked('bk', rid));
  const f = (await b.call('POST', 'distill', { session: 'bk' }))[1];
  assert.deepEqual([reqs.length, f.backend, f.gated, f.skill], [2, 'model', true, 'deploy-worker']);
  assert.deepEqual(b.calls().slice(1), ['classifier haiku x-agent-router-source: brain', 'writer sonnet x-agent-router-source: brain']);
  assert.match(b.stdout(), /brain: jev failed \(500\)/);
  // a skill now exists, so the next gate also asks whether it already covers the session
  fail = false;
  await b.session('bm', (rid) => worked('bm', rid));
  await b.call('POST', 'distill', { session: 'bm' });
  assert.deepEqual(Object.keys(reqs[2].body.questions.matches.criteria), ['deploy-worker', 'new']);
  assert.ok(!b.stdout().includes('ts-fake-key'), 'TypeSafe key leaked to stdout');
  b.noLeak();
});

test('brain daily cap: spend tagged source=brain over brain_daily_usd queues the distill and makes no model call', async (t) => {
  const b = await brainSetup(t);
  assert.equal((await b.api('settings')).brain_daily_usd, 1, 'default cap: $1 a day at list price');
  await b.put({ brain_daily_usd: 0.5 });
  await b.session('bc', (rid) => worked('bc', rid));
  b.s.usage = B_USAGE; // $0.825 on Haiku 4.5, on a request the brain's own subprocess made
  await b.msg('own', { model: 'claude-haiku-4-5' }, { 'x-agent-router-source': 'brain' });
  await b.msg('adv', { model: 'claude-haiku-4-5' }, { 'x-agent-router-source': 'advisor' }); // the advisor's calls are tagged too, and are not brain spend
  let st = await until(async () => { const s = (await b.call('GET', 'stats'))[1]; return s.spend_today_usd && s; }, 'brain spend logged');
  close(st.spend_today_usd, B_USD); assert.deepEqual([st.cap_usd, st.queued], [0.5, 0]);
  assert.deepEqual(await b.call('POST', 'distill', { session: 'bc' }), [200, { queued: true }]);
  assert.deepEqual(b.calls(), [], 'no subprocess call over the cap');
  assert.deepEqual({ ...(await b.rows(`select queued, gated_ts, distilled_ts from brain_sessions where session_key = 'bc'`))[0] }, { queued: 1, gated_ts: null, distilled_ts: null });
  st = (await b.call('GET', 'stats'))[1];
  assert.deepEqual([st.queued, st.distilled], [1, 0]);
  assert.equal((await b.api('cost')).one_shots.count, 1, 'own calls are not counted with the one-shots (only bc\'s request is)');
  // raise the cap: the same request goes through and clears the queue flag
  await b.put({ brain_daily_usd: 100 });
  assert.equal((await b.call('POST', 'distill', { session: 'bc' }))[1].distilled, true);
  assert.equal((await b.rows(`select queued from brain_sessions where session_key = 'bc'`))[0].queued, 0);
  b.noLeak();
});

test('brain skills: import by URL (https only, 200 KB, text, must be a skill), promote with marker, unmarked dir is never touched, demote, recall, uses counted', async (t) => {
  const skill = (name: string) => `---\nname: ${name}\ndescription: >\n  Use when working with PDFs:\n  split, merge.\n---\n\n1. Run \`qpdf --split-pages in.pdf\`\n<!-- hidden -->\n`;
  const web = createServer((req, res) => {
    const text = (body: string, type = 'text/plain; charset=utf-8') => res.writeHead(200, { 'content-type': type }).end(body);
    if (req.url === '/a/SKILL.md') return text(skill('pdf-tools'));
    if (req.url === '/raw/o/r/main/skills/gh-blob/SKILL.md' || req.url === '/raw/o/r/v1.2/skills/gh-tree/SKILL.md') return text(skill(req.url.split('/')[6]));
    if (req.url === '/b/SKILL.md') return text(skill('second-skill'), 'text/markdown');
    if (req.url === '/redir') return res.writeHead(302, { location: '/b/SKILL.md' }).end();
    if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
    if (req.url === '/out') return res.writeHead(302, { location: 'http://example.com/SKILL.md' }).end();
    if (req.url === '/big') return text(skill('big-skill') + 'x'.repeat(210 << 10));
    if (req.url === '/readme') return text('# Not a skill\n');
    if (req.url === '/badname') return text(skill('Bad Name'));
    if (req.url === '/bin') return text(skill('bin-skill'), 'application/octet-stream');
    res.writeHead(404).end();
  });
  const port = await listen(web), url = (p: string) => `http://127.0.0.1:${port}${p}`;
  t.after(() => web.close());
  const b = await brainSetup(t, { GITHUB_RAW_URL: `http://127.0.0.1:${port}/raw` }), imp = (u: string) => b.call('POST', 'skills/import', { url: u });

  assert.deepEqual(await imp(url('/a/SKILL.md')), [201, { name: 'pdf-tools', description: 'Use when working with PDFs: split, merge.', status: 'candidate', source: url('/a/SKILL.md') }]);
  assert.equal(b.read('skills/candidates/pdf-tools/SKILL.md'), skill('pdf-tools'), 'stored verbatim');
  assert.ok(!existsSync(`${b.skills}/pdf-tools`), 'an import is never promoted by itself');
  assert.deepEqual((await imp(url('/redir')))[0], 201, 'one redirect is followed');
  assert.deepEqual([(await imp(url('/big')))[0], (await imp(url('/loop')))[0], (await imp(url('/missing')))[0]], [413, 502, 502]);
  assert.deepEqual(await imp(url('/readme')), [422, { error: { type: 'not_a_skill', message: 'no YAML frontmatter' } }]);
  assert.deepEqual([(await imp(url('/badname')))[1].error.message, (await imp(url('/bin')))[1].error.type], ['frontmatter `name` must be kebab-case, at most 64 characters', 'not_text']);
  for (const bad of ['http://example.com/SKILL.md', `http://localhost:${port}/a/SKILL.md`, 'ftp://x/SKILL.md', 'file:///etc/passwd', url('/out')]) assert.deepEqual(await imp(bad), [400, { error: { type: 'https_only' } }], bad);
  assert.deepEqual((await imp('not a url'))[0], 400);
  assert.deepEqual((await imp(url('/a/SKILL.md')))[0], 409, 'a name that exists is not overwritten');
  assert.deepEqual(readdirSync(`${b.vault}/skills/candidates`).sort(), ['pdf-tools', 'second-skill']);
  // github.com page URLs are rewritten to the raw file: /blob/<ref>/<path>, and /tree/<ref>/<dir> -> <dir>/SKILL.md
  assert.deepEqual([(await imp('https://github.com/o/r/blob/main/skills/gh-blob/SKILL.md'))[1].name, (await imp('https://github.com/o/r/tree/v1.2/skills/gh-tree/'))[1].name], ['gh-blob', 'gh-tree']);
  for (const n of ['gh-blob', 'gh-tree']) assert.equal((await b.call('POST', `skills/${n}/reject`))[0], 200);

  // promote: copied to the skills dir with a marker
  assert.deepEqual(await b.call('POST', 'skills/pdf-tools/promote'), [200, { ok: true, name: 'pdf-tools', status: 'promoted' }]);
  assert.equal(readFileSync(`${b.skills}/pdf-tools/SKILL.md`, 'utf8'), skill('pdf-tools'));
  assert.equal(JSON.parse(readFileSync(`${b.skills}/pdf-tools/.agent-router`, 'utf8')).source, url('/a/SKILL.md'));
  // a directory of that name that we did not install: refused, untouched
  mkdirSync(`${b.skills}/second-skill`); writeFileSync(`${b.skills}/second-skill/SKILL.md`, 'theirs');
  assert.deepEqual((await b.call('POST', 'skills/second-skill/promote'))[0], 409);
  assert.equal(readFileSync(`${b.skills}/second-skill/SKILL.md`, 'utf8'), 'theirs');
  assert.deepEqual([(await b.call('POST', 'skills/nope/promote'))[0], (await b.call('POST', 'skills/..%2F..%2Fx/promote'))[0], (await b.call('POST', 'skills/pdf-tools/reject'))[0]], [404, 404, 409]);

  // a Skill tool call in a transcript counts as a use of that skill
  await b.session('su', (rid) => jrow('su', { type: 'user', message: { role: 'user', content: 'split this pdf' } }) + tuse('su', rid, 'sk1', 'Skill', { skill: 'pdf-tools' }) + tres('su', 'sk1') + tuse('su', rid, 'sk2', 'Skill', { skill: 'other' }));
  const st = await until(async () => { const s = (await b.call('GET', 'stats'))[1]; return s.skills[0].uses && s; }, 'skill use counted');
  assert.deepEqual([st.promoted, st.candidates], [1, 1]);
  assert.deepEqual(st.skills.map(({ last_used, promoted_ts, ...k }: any) => k), [
    { name: 'pdf-tools', status: 'promoted', uses: 1, sessions: 1, projects: 1, source: url('/a/SKILL.md'), source_session: null, source_usd: null },
    { name: 'second-skill', status: 'candidate', uses: 0, sessions: 0, projects: 0, source: url('/redir'), source_session: null, source_usd: null }]);
  assert.ok(st.skills[0].last_used > 0 && st.skills[0].promoted_ts > 0);
  assert.deepEqual((await b.rows(`select name, arg from tool_uses where name = 'Skill' order by id`)).map((r) => r.arg), ['pdf-tools', 'other']);
  assert.match(b.read('skills/pdf-tools.md'), /Status: promoted since \d{4}-\d\d-\d\d · Source: http:\/\/127\.0\.0\.1/);

  // demote removes only what carries the marker; reject deletes the candidate
  assert.deepEqual((await b.call('POST', 'skills/pdf-tools/demote'))[1].status, 'candidate');
  assert.ok(!existsSync(`${b.skills}/pdf-tools`) && existsSync(`${b.vault}/skills/candidates/pdf-tools/SKILL.md`) && !existsSync(`${b.vault}/skills/pdf-tools.md`));
  assert.deepEqual((await b.call('POST', 'skills/second-skill/reject'))[1].status, 'rejected');
  assert.ok(!existsSync(`${b.vault}/skills/candidates/second-skill`) && existsSync(`${b.skills}/second-skill/SKILL.md`));
  // the recall skill installs under the same rule
  mkdirSync(`${b.skills}/brain`);
  assert.deepEqual((await b.call('POST', 'recall'))[0], 409);
  rmSync(`${b.skills}/brain`, { recursive: true });
  assert.deepEqual(await b.call('POST', 'recall'), [200, { ok: true, name: 'brain', status: 'promoted' }]);
  const recall = readFileSync(`${b.skills}/brain/SKILL.md`, 'utf8');
  assert.ok(/^---\nname: brain\ndescription: Recall past work[^\n]+\n---\n/.test(recall) && recall.includes(`${b.vault}/index.md`));
  assert.ok(existsSync(`${b.skills}/brain/.agent-router`));
  assert.deepEqual(readdirSync(b.skills).sort(), ['brain', 'second-skill']);
  b.noLeak();
});

test('brain safety: writes are 409 until enabled, API paths cannot leave the vault, the renderer escapes HTML and only links http(s)', async (t) => {
  const b = await brainSetup(t, {}, false);
  assert.deepEqual((await b.api('settings')).brain_enabled, false, 'off by default');
  for (const [m, p] of [['POST', 'capture'], ['POST', 'distill'], ['POST', 'consolidate'], ['POST', 'skills/import'], ['POST', 'skills/x/promote'], ['POST', 'recall'], ['PUT', 'facts']])
    assert.deepEqual(await b.call(m, p, { session: 's', url: 'https://example.com/SKILL.md', text: 'x' }), [409, { error: { type: 'brain_disabled' } }], p);
  assert.ok(!existsSync(b.vault) && !existsSync(b.skills), 'nothing is written while disabled');
  assert.deepEqual([(await b.call('GET', 'stats'))[1].enabled, (await b.call('GET', 'tree'))[1].files], [false, []]);
  for (const bad of [{ brain_distill: 'always' }, { classifier: 'gpt' }, { brain_confidence: 2 }, { brain_daily_usd: '1' }, { brain_daily_units: 200000 }, { brain_enabled: 'yes' }, { brain_dir: 'relative/dir' }]) assert.equal((await b.put(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await b.put({ brain_enabled: true, brain_distill: 'on_idle', brain_dir: null })).status, 200);

  assert.deepEqual(await b.call('PUT', 'facts', { text: '# Facts\n\nDeploys go through wrangler.\n' }), [200, { ok: true }]);
  assert.equal((await b.call('PUT', 'facts', { text: 'x'.repeat(9000) }))[0], 400);
  const note = (p: string) => b.call('GET', `note?path=${encodeURIComponent(p)}`);
  assert.deepEqual((await note('CRITICAL_FACTS.md'))[1], { path: 'CRITICAL_FACTS.md', abs: `${b.vault}/CRITICAL_FACTS.md`, text: '# Facts\n\nDeploys go through wrangler.\n', session: null });
  writeFileSync(`${b.tmp}/outside.md`, 'OUTSIDE');
  symlinkSync(`${b.tmp}/outside.md`, `${b.vault}/wiki/link.md`);
  for (const bad of ['../outside.md', 'wiki/../../outside.md', '/etc/passwd', `${b.tmp}/outside.md`, 'wiki/link.md', '']) assert.deepEqual(await note(bad), [400, { error: { type: 'bad_path' } }], bad);
  assert.equal((await note('wiki/missing.md'))[0], 404);
  assert.deepEqual((await b.call('GET', 'tree'))[1], { dir: b.vault, files: ['CRITICAL_FACTS.md', '_CLAUDE.md', 'log.md'] }, 'symlinks are not listed');
  assert.deepEqual((await b.call('GET', 'search?q=WRANGLER'))[1], [{ path: 'CRITICAL_FACTS.md', line: 3, snippet: 'Deploys go through wrangler.' }]);
  assert.deepEqual((await b.call('GET', 'search?q=x'))[1], []);

  // the renderer, loaded from the page itself
  const page = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');
  const md = new Function(`${page.slice(page.indexOf('// md:begin'), page.indexOf('// md:end'))}; return md;`)() as (s: string) => string;
  const html = md(['---', 'title: "<script>alert(0)</script>"', '---', '# Head <script>alert(1)</script>', '<!-- agent-router:begin -->', '<img src=x onerror=alert(2)>', '- item **bold** `code <b>`',
    '[x](javascript:alert(3))', '[y](JaVaScRiPt:alert(4))', '[d](data:text/html,<script>alert(5)</script>)', '[q](https://a.b/"onmouseover="alert(6))', '[ok](https://example.com/a?b=1&c=2)',
    '[[wiki/projects/proj-x|proj]] and [[2026-10-01 note]]', '[[a" onclick="alert(7)]]', '<a href="javascript:alert(8)">raw</a>', '```', '<script>alert(9)</script>', '```', '| a | <b>b</b> |'].join('\n'));
  assert.deepEqual([...new Set(html.match(/<\/?[a-zA-Z][\w-]*/g))].sort(), ['</a', '</b', '</code', '</h1', '</li', '</p', '</pre', '</table', '</td', '</tr', '</ul', '<a', '<b', '<code', '<h1', '<li', '<p', '<pre', '<table', '<td', '<tr', '<ul'], 'only tags the renderer makes');
  assert.ok(!/<script|<img/i.test(html) && !/href="(?!https?:\/\/|#brain")/i.test(html), html);
  assert.deepEqual(html.match(/<a [^>]*>/g), ['<a href="https://a.b/&#34;onmouseover=&#34;alert(6" target="_blank" rel="noopener noreferrer">', '<a href="https://example.com/a?b=1&#38;c=2" target="_blank" rel="noopener noreferrer">',
    '<a href="#brain" data-wl="wiki/projects/proj-x">', '<a href="#brain" data-wl="2026-10-01 note">', '<a href="#brain" data-wl="a&#34; onclick=&#34;alert(7)">']);
  assert.match(html, /<li>item <b>bold<\/b> <code>code &#60;b&#62;<\/code><\/li>/);
  assert.ok(html.includes('[x](javascript:alert(3))') && !html.includes('agent-router:begin'), 'a refused link stays visible as text; our markers are hidden');
  b.noLeak();
});

// ---- cost insights (docs/COST-INSIGHTS.md): dollars at list price, rewrite causes, lifetime fit, going cold, carrying cost, safe switches ----
// The arithmetic is tested directly: console.ts imported in this process against a throwaway ledger (never the default one).
const arith = async () => { process.env.LEDGER_PATH ??= `${mkdtempSync(`${tmpdir()}/router-arith-`)}/ledger.sqlite`; return import('./console.ts'); };

test('cost(): list price per model, the 0.05× and 0.025× cache-read cases, rate_card override, unknown model -> null', async () => {
  const { cost, rates, PRICES_AS_OF } = await arith();
  const u = { in_tok: 1e6, out_tok: 1e6, cache_read: 1e6, cache_5m: 1e6, cache_1h: 1e6 }; // $/MTok: input + output + read + 5m write + 1h write
  for (const [model, want] of [['claude-fable-5-1', 10 + 50 + 0.25 + 12.5 + 20], ['claude-opus-5-5', 4 + 20 + 0.2 + 5 + 8], ['claude-opus-5', 5 + 25 + 0.5 + 6.25 + 10],
    ['claude-sonnet-5-5', 2 + 10 + 0.2 + 2.5 + 4], ['claude-sonnet-5', 2 + 10 + 0.2 + 2.5 + 4], ['claude-haiku-4-5-20251001', 1 + 5 + 0.1 + 1.25 + 2]] as [string, number][]) close(cost({ ...u, model }, {})!, want, model);
  const mult = (m: string) => rates(m, {})!.read / rates(m, {})!.input;
  close(mult('claude-opus-5-5'), 0.05); close(mult('claude-fable-5-1'), 0.025); close(mult('claude-opus-5'), 0.1); close(mult('claude-sonnet-5-5'), 0.1); close(mult('claude-haiku-4-5'), 0.1);
  close(cost({ model: 'claude-opus-5-5', cache_create: 1e6 }, {})!, 5, 'a write without the 1h/5m split is priced at the 5m rate');
  close(cost({ model: 'claude-opus-5-5', in_tok: 1e6, out_tok: 1e6, cache_read: 1e6, speed: 'fast' }, {})!, 2 * 4 + 2 * 20 + 0.2, 'fast mode doubles input and output on Opus 5.5');
  close(cost({ model: 'claude-sonnet-5-5', in_tok: 1e6, speed: 'fast' }, {})!, 2);
  close(cost({ ...u, model: 'claude-opus-5-5' }, { 'opus-5-5': { read: 1 } })!, 4 + 20 + 1 + 5 + 8, 'rate_card overrides the fields it names');
  close(cost({ model: 'claude-opus-4-6', in_tok: 1e6 }, { 'opus-4-6': { input: 15 } })!, 15, 'rate_card can price a model the table does not know');
  assert.deepEqual([cost({ ...u, model: 'claude-opus-4-6' }, {}), cost({ ...u, model: null }, {}), cost({ ...u, model: 'gpt-9' }, {})], [null, null, null], 'unknown model: no price, never a guess');
  assert.equal(PRICES_AS_OF, '2026-10-01');
});

test('rewrite causes: model, fast mode, effort (not on Opus 5.5), tool set (not a deferred tool), images, compaction, lifetime at 5m and 1h, CLI upgrade; avoidable flags and dollars', async (t) => {
  const h = await setup(t);
  const wdb = new DatabaseSync(h.ledger, { timeout: 2000 });
  t.after(() => wdb.close());
  const use = (create: number, ttl: string) => ({ input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: create,
    cache_creation: { ephemeral_1h_input_tokens: ttl === '1h' ? create : 0, ephemeral_5m_input_tokens: ttl === '5m' ? create : 0 } });
  const tools = [{ name: 'A' }, { name: 'B' }], img = [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: {} }] }];
  // each case is one session: a cold first turn (20k written), then a turn that writes the whole context again (20.5k, nothing read)
  const pair = async (sk: string, a: any, b: any, o: { ttl?: string; gapMin?: number; ha?: any; hb?: any } = {}) => {
    h.s.usage = use(20000, o.ttl ?? '1h'); await h.msg(sk, { model: 'claude-opus-5-5', tools, ...a }, o.ha);
    h.s.usage = use(20500, o.ttl ?? '1h'); await h.msg(sk, { model: 'claude-opus-5-5', tools, ...b }, o.hb);
    await until(async () => (await h.rows('select count(*) n from requests where session_key = ?', sk))[0].n === 2, `${sk} logged`);
    if (o.gapMin) wdb.prepare('update requests set ts = ts - ? where id = (select min(id) from requests where session_key = ?)').run(o.gapMin * 60_000, sk);
  };
  await pair('m', {}, { model: 'claude-sonnet-5-5' });
  await pair('f', {}, { speed: 'fast' });
  await pair('e', { model: 'claude-opus-5', output_config: { effort: 'high' } }, { model: 'claude-opus-5', output_config: { effort: 'low' } });
  await pair('e55', { output_config: { effort: 'low' } }, { output_config: { effort: 'high' } });
  await pair('s', { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'a long answer that the client later clears out of the history' }] },
    { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '[cleared]' }, { role: 'user', content: 'more' }] });
  await pair('t', {}, { tools: [...tools, { name: 'C' }] });
  await pair('td', {}, { tools: [...tools, { name: 'C', defer_loading: true }] });
  await pair('i', { messages: img }, {});
  await pair('c', { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'more' }] }, {});
  await pair('x1', {}, {}, { gapMin: 61 });
  await pair('w1', {}, {}, { gapMin: 59 });
  await pair('x5', {}, {}, { ttl: '5m', gapMin: 6 });
  await pair('w5', {}, {}, { ttl: '5m', gapMin: 4 });
  await pair('v', {}, {}, { ha: { 'user-agent': 'claude-cli/2.1.268 (external, cli)' }, hb: { 'user-agent': 'claude-cli/2.1.300 (external, cli)' } });

  const c = await h.api('cache?days=1'), w = (perMTok: number) => +(20500 * perMTok / 1e6).toFixed(6);
  assert.deepEqual(Object.fromEntries(c.bursts.map((b: any) => [b.session_key, [b.cause, b.avoidable, +b.usd.toFixed(6)]])), {
    m: ['model changed (opus-5-5 → sonnet-5-5)', true, w(4)], // re-written on the new model, at its 1h write price
    f: ['fast mode turned on', true, w(8)],
    e: ['effort changed (high → low)', true, w(10)],
    e55: ['unexplained', false, w(8)],                        // Opus 5.5 keeps its cache across an effort change: not the cause
    t: ['tool set changed (2 → 3 loaded tools)', true, w(8)],
    td: ['unexplained', false, w(8)],                         // a deferred definition is not part of the prefix: not the cause
    i: ['images removed (1 → 0)', false, w(8)],
    c: ['compaction or tool-result clearing (expected rebuild)', false, w(8)],
    s: ['compaction or tool-result clearing (expected rebuild)', false, w(8)], // more messages, smaller body: something was cleared
    x1: ['cache lifetime expired (1h cache, idle 61 min)', false, w(8)],
    w1: ['unexplained', false, w(8)],                         // 59 minutes: still inside the 1h lifetime
    x5: ['cache lifetime expired (5m cache, idle 6 min)', false, w(5)],
    w5: ['unexplained', false, w(5)],
    v: ['CLI upgraded (2.1.268 → 2.1.300)', false, w(8)],
  });
  assert.ok(c.bursts.every((b: any) => (b.fix != null) === !['rebuild', 'unexplained'].includes(b.kind)), 'every explained cause but an expected rebuild carries a fix');
  assert.match(c.bursts.find((b: any) => b.kind === 'tools').fix, /ENABLE_TOOL_SEARCH=true/);
  assert.equal(c.avoidable.count, 4); close(c.avoidable.usd, 20500 * (4 + 8 + 10 + 8) / 1e6);
  // the same re-writes as ranked findings: avoidable ones and 1h caches that went cold; 5m expiries are the lifetime fit's business
  const ins = await h.api('insights?days=1'), a1 = ins.findings.filter((f: any) => f.id.startsWith('a1:'));
  assert.deepEqual(a1.map((f: any) => f.id).sort(), ['a1:effort:e', 'a1:expired:x1', 'a1:fast:f', 'a1:model:m', 'a1:tools:t']);
  assert.ok(a1.every((f: any) => f.tier === 'A' && f.quality === 'none' && f.fix && f.evidence.length && f.session_key));
  assert.deepEqual([a1.find((f: any) => f.id === 'a1:model:m').title, +a1.find((f: any) => f.id === 'a1:model:m').usd.toFixed(6)], ['Model switched mid-session once in ‘m’', w(4)]);
  assert.deepEqual(ins.findings.map((f: any) => f.usd ?? 0), ins.findings.map((f: any) => f.usd ?? 0).sort((x: number, y: number) => y - x), 'ranked by dollars');
  h.noLeak();
});

test('cache lifetime fit: a hand-built gap sequence replayed under 5m and 1h', async () => {
  const { ttlFit, cost } = await arith(), M = 60_000;
  const row = (o: any) => { const r = { model: 'claude-opus-5-5', in_tok: 0, out_tok: 0, cache_read: 0, cache_1h: 0, cache_5m: 0, agent_id: null, gap: null, prev_ctx: null, ...o };
    r.cache_create = r.cache_1h + r.cache_5m; r.usd = cost(r, {}); return r; };
  // a subagent on 5m: cold start 200k; re-written after a 10 min pause; a turn a minute later; re-written after a 20 min pause; cold again after 2 h
  const sub = (agent_id: string) => [row({ agent_id, cache_5m: 200e3 }), row({ agent_id, cache_5m: 210e3, gap: 10 * M, prev_ctx: 200e3 }), row({ agent_id, cache_read: 210e3, cache_5m: 5e3, gap: M, prev_ctx: 210e3 }),
    row({ agent_id, cache_5m: 220e3, gap: 20 * M, prev_ctx: 215e3 }), row({ agent_id, cache_5m: 225e3, gap: 120 * M, prev_ctx: 220e3 })];
  const [main, subs] = ttlFit([
    // the main conversation on 1h: cold start 1M; a turn 2 min later; a turn after a 30 min pause (read on 1h, written again on 5m)
    row({ cache_1h: 1e6 }), row({ cache_read: 1e6, cache_1h: 10e3, gap: 2 * M, prev_ctx: 1e6 }), row({ cache_read: 1.01e6, cache_1h: 10e3, gap: 30 * M, prev_ctx: 1.01e6 }),
    ...sub('a'), ...sub('b')], 7, {});
  // Opus 5.5 $/MTok: read 0.2, 5m write 5, 1h write 8
  assert.deepEqual([main.bucket, main.setting, main.current, main.turns, main.turns_5_60, main.switch_to], ['main', 'promptCacheTtl', '1h', 3, 1, null]);
  close(main.actual_usd, 8 + (0.2 + 0.08) + (0.202 + 0.08)); close(main.usd_1h, main.actual_usd);
  close(main.usd_5m, 5 + (0.2 + 0.05) + 1.02 * 5, 'the 30-minute pause re-writes the whole 1.02M prefix at the 5m price');
  assert.equal(main.recommend, 'Keep the current lifetime (1h): 5m would have cost $1.79 more (+21%).');
  assert.deepEqual([subs.bucket, subs.setting, subs.current, subs.turns, subs.turns_5_60, subs.switch_to], ['subagents', 'subagentPromptCacheTtl', '5m', 10, 4, '1h']);
  close(subs.actual_usd, 2 * (1 + 1.05 + (0.042 + 0.025) + 1.1 + 1.125)); close(subs.usd_5m, subs.actual_usd);
  // on 1h: the 10 and 20 minute pauses read the previous context (200k, 215k) and write only what is new; every write costs 8 instead of 5
  close(subs.usd_1h, 2 * (1.6 + (0.04 + 0.08) + (0.042 + 0.04) + (0.043 + 0.04) + 1.8));
  assert.equal(subs.recommend, 'Set `subagentPromptCacheTtl` to `1h`: about $1.31 less over these 7 days (15%).');
  // one subagent alone saves $0.66: under the $1 bar, so no switch is suggested
  assert.equal(ttlFit(sub('a'), 7, {})[1].recommend, 'Keep the current lifetime (5m): 1h would save $0.66 (15%), under the $1 and 5% bar.');
});

test('going cold: one notification before a large 1h cache lapses, not again until the session is active again; sessions carry cold_at and rebuild_usd', async (t) => {
  const log = `${mkdtempSync(`${tmpdir()}/router-notify-`)}/notify.log`;
  const h = await setup(t, { DRILLS: '1', NOTIFY: '0', NOTIFY_LOG: log, COLD_TICK_MS: '40' });
  const notes = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []), wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  const turn = async (sk: string, read: number, create: number, ttl = '1h') => {
    h.s.usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: create,
      cache_creation: { ephemeral_1h_input_tokens: ttl === '1h' ? create : 0, ephemeral_5m_input_tokens: ttl === '5m' ? create : 0 } };
    await h.msg(sk, { model: 'claude-opus-5-5', tools: [{ name: 'Read' }] });
  };
  await turn('gc', 0, 200e3);         // 200k on the 1h cache: a rebuild is 200k × $8/MTok = $1.60
  await turn('small', 0, 50e3);       // under cold_min_context
  await turn('five', 0, 200e3, '5m'); // a 5m cache: never warned about
  const ts = Object.fromEntries((await h.rows('select session_key k, ts from requests')).map((r) => [r.k, r.ts]));
  const ss = Object.fromEntries((await h.api('sessions')).map((s: any) => [s.session_key, s]));
  assert.deepEqual([ss.gc.cold_at - ts.gc, ss.five.cold_at - ts.five], [3600_000, 300_000]);
  close(ss.gc.rebuild_usd, 200010 * 8 / 1e6); close(ss.five.rebuild_usd, 200010 * 5 / 1e6);
  await wait(150);
  assert.deepEqual(notes(), [], 'an hour to go: nothing yet');
  await h.api('clock', { skew_ms: 56 * 60_000 });
  await until(() => notes().length === 1, 'warned inside the last 5 minutes');
  assert.equal(notes()[0], '‘gc’ goes cold in 4 min — a message now costs about $0.04, after that the next turn costs about $1.60');
  await wait(200);
  assert.equal(notes().length, 1, 'once per idle period');
  await turn('gc', 200e3, 500); // active again, 56 minutes in: the lifetime starts over
  await wait(200);
  assert.equal(notes().length, 1);
  await h.api('clock', { skew_ms: 112 * 60_000 });
  await until(() => notes().length === 2, 'warned again for the new idle period');
  assert.match(notes()[1], /^‘gc’ goes cold in 4 min/);
  assert.equal(h.s.seen.length, 4, 'the router sent nothing upstream for any of this');
  h.noLeak();
});

test('carrying cost: each tool result × the turns that re-read it × the read price, cut at compaction; sizes and targets only', async (t) => {
  const proj = mkdtempSync(`${tmpdir()}/router-proj-`);
  const h = await setup(t, { CLAUDE_PROJECTS_DIR: proj });
  for (let i = 0; i < 5; i++) await h.msg('cc'); // req_1..5
  const A = (rid: string, content?: any[]) => arow(rid, { in: 10, read: 1000, create: 100 }, content, 'cc').replace('claude-haiku-4', 'claude-opus-5-5'); // read: $0.20/MTok
  const use = (rid: string, id: string, name: string, input: any) => A(rid, [{ type: 'tool_use', id, name, input }]);
  const result = (id: string, chars: number) => JSON.stringify({ type: 'user', sessionId: 'cc', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'TOOL-OUTPUT-' + 'x'.repeat(chars - 12) }] } }) + '\n';
  mkdirSync(`${proj}/p`);
  writeFileSync(`${proj}/p/cc.jsonl`, JSON.stringify({ type: 'user', sessionId: 'cc', message: { role: 'user', content: 'fix the parser' } }) + '\n'
    + use('req_1', 'r1', 'Read', { file_path: '/src/big.ts' }) + result('r1', 40_000)                       // 10k tokens, re-read by req_2 and req_3
    + use('req_2', 'b1', 'Bash', { command: 'npm test', description: 'run tests' }) + result('b1', 100_000) // 25k tokens, re-read by req_3
    + A('req_3') + JSON.stringify({ type: 'system', subtype: 'compact_boundary', sessionId: 'cc' }) + '\n'  // compaction: both stop being carried
    + use('req_4', 'r2', 'Read', { file_path: '/src/big.ts' }) + result('r2', 4_000)                        // 1k tokens, re-read by req_5
    + A('req_5'));
  await until(async () => (await h.rows(`select jsonl_path p from requests where request_id = 'req_5'`))[0]?.p, 'joined');
  const tl = await h.api('sessions/cc/timeline');
  assert.deepEqual(tl.carrying.map((c: any) => [c.tool, c.target, c.tokens, c.turns, +c.usd.toFixed(6)]),
    [['Bash', 'npm test', 25000, 1, 0.005], ['Read', '/src/big.ts', 10000, 2, 0.004], ['Read', '/src/big.ts', 1000, 1, 0.0002]]);
  assert.match(tl.carrying[0].suggestion, /PreToolUse hook/);
  assert.match(tl.carrying[1].suggestion, /^Read it once: this file was read 2 times/);
  const a4 = (await h.api('insights')).findings.filter((f: any) => f.id.startsWith('a4:'));
  assert.deepEqual(a4.map((f: any) => [f.tier, f.quality, f.session_key, +f.usd.toFixed(6)]), [['A', 'none', 'cc', 0.005], ['A', 'none', 'cc', 0.004], ['A', 'none', 'cc', 0.0002]]);
  assert.equal(a4[0].title, 'Bash npm test: one result re-read on 1 turn in ‘fix the parser’');
  assert.ok(!JSON.stringify([tl, a4]).includes('TOOL-OUTPUT'), 'tool result content left the transcript');
  const dir = dirname(h.ledger);
  assert.ok(!readdirSync(dir).map((x) => readFileSync(`${dir}/${x}`, 'latin1')).join('').includes('TOOL-OUTPUT'), 'tool result content stored');
  h.noLeak();
});

test('model choices: read-only subagent above Haiku (docs-recommended), newer same-family sibling (no quality change), step-down (unverified), switch-now break-even', async (t) => {
  const proj = mkdtempSync(`${tmpdir()}/router-proj-`);
  const h = await setup(t, { CLAUDE_PROJECTS_DIR: proj });
  await h.msg('ro', { model: 'claude-sonnet-5-5', tools: [{ name: 'Agent' }] });                               // req_1: the session itself
  await h.msg('ro', { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'find the parser' }] }); // req_2: subagent x, which only reads
  await h.msg('ro', { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'run the tests' }] });   // req_3: subagent y, which runs Bash
  await h.msg('o5', { model: 'claude-opus-5', tools: [{ name: 'Read' }] });                                    // req_4: a session on Opus 5
  const U = { in: 1000, read: 100e3, create: 10e3 }, uses = (...names: string[]) => names.map((name, i) => ({ type: 'tool_use', id: `${name}${i}`, name, input: {} }));
  mkdirSync(`${proj}/-tmp-proj-x/ro/subagents`, { recursive: true });
  writeFileSync(`${proj}/-tmp-proj-x/ro.jsonl`, arow('req_1', U, undefined, 'ro'));
  writeFileSync(`${proj}/-tmp-proj-x/ro/subagents/agent-x.jsonl`, arow('req_2', U, uses('Read', 'Grep'), 'ro'));
  writeFileSync(`${proj}/-tmp-proj-x/ro/subagents/agent-y.jsonl`, arow('req_3', U, uses('Read', 'Bash'), 'ro'));
  writeFileSync(`${proj}/-tmp-proj-x/o5.jsonl`, arow('req_4', U, undefined, 'o5'));
  await until(async () => (await h.rows('select count(*) n from requests where cache_create is not null'))[0].n === 4 && (await h.rows('select count(*) n from requests where agent_id is not null'))[0].n === 2, 'joined');
  // one turn = 1k in, 50 out, 100k read, 10k written (1h), in dollars per model
  const usd = { sonnet: (1000 * 2 + 50 * 10 + 100e3 * 0.2 + 10e3 * 4) / 1e6, haiku: (1000 + 50 * 5 + 100e3 * 0.1 + 10e3 * 2) / 1e6, opus5: (1000 * 5 + 50 * 25 + 100e3 * 0.5 + 10e3 * 10) / 1e6, opus55: (1000 * 4 + 50 * 20 + 100e3 * 0.2 + 10e3 * 8) / 1e6 };
  const f = Object.fromEntries((await h.api('insights')).findings.map((x: any) => [x.id, x]));
  assert.deepEqual([f['b2:haiku-subagents'].tier, f['b2:haiku-subagents'].quality, f['b2:haiku-subagents'].title, f['b2:haiku-subagents'].evidence[1]],
    ['B', 'docs-recommended', '1 read-only subagent run on a larger model than the docs suggest', 'tools called: Grep, Read'], 'the Bash subagent is not read-only');
  close(f['b2:haiku-subagents'].usd, usd.sonnet - usd.haiku); assert.match(f['b2:haiku-subagents'].fix, /`model: haiku`/);
  assert.deepEqual([f['b2:opus-5'].quality, f['b2:opus-5'].title], ['none', 'Opus 5 → Opus 5.5: same family, newer and cheaper']); close(f['b2:opus-5'].usd, usd.opus5 - usd.opus55);
  assert.deepEqual([f['b1:sonnet-5-5'].quality, f['b1:sonnet-5-5'].title, f['b1:sonnet-5-5'].evidence[2]], ['unverified', 'The same tokens on Haiku 4.5 instead of Sonnet 5.5', 'saving if quality holds — unverified']);
  close(f['b1:sonnet-5-5'].usd, 3 * (usd.sonnet - usd.haiku)); assert.equal(f['b1:opus-5'], undefined, 'Opus 5 has a safe switch, not an unverified one');
  // /router/cost: the same tokens on every model; for one session, what switching now costs and when it pays back
  const all = (await h.api('cost')).model_whatif, one = (await h.api('cost?session=o5')).model_whatif;
  assert.deepEqual([all.label, all.rows.map((r: any) => [r.from, r.turns]), all.switch_now], ['saving if quality holds — unverified', [['sonnet-5-5', 3], ['opus-5', 1]], null]);
  close(all.rows[0].on['haiku-4-5'], 3 * usd.haiku); close(one.rows[0].on['opus-5-5'], usd.opus55);
  const to = Object.fromEntries(one.switch_now.to.map((x: any) => [x.model, x]));
  assert.deepEqual([one.switch_now.from, one.switch_now.context, to['opus-5-5'].breakeven_turns, to['fable-5-1'].breakeven_turns], ['opus-5', 111000, 18, null]);
  close(to['opus-5-5'].rewrite_usd, 111000 * 8 / 1e6, 'the whole context re-written at the target model\'s 1h write price'); // 0.888 / (0.15625 − 0.105) = 17.3 turns
  h.noLeak();
});

test('brain noise: a probe one-shot gets no note; a note from before that rule is removed unless the user wrote in it, and leaves every list', async (t) => {
  const b = await brainSetup(t), day = new Date().toLocaleDateString('sv');
  await b.session('tv', (rid) => worked('tv', rid, 1)); // 1 prompt, 2 tool calls: a one-shot
  await b.session('ok', (rid) => worked('ok', rid, 2)); // 3 tool calls: kept
  await b.session('lg', (rid) => worked('lg', rid, 0)); // one-shots that already have a note from an earlier version:
  await b.session('ed', (rid) => worked('ed', rid, 0)); // …lg's is as generated, ed's has the user's own text below the block
  const gen = (sk: string) => `---\nsession: ${sk}\ntitle: old ${sk}\n---\n<!-- agent-router:begin -->\n# old ${sk}\n<!-- agent-router:end -->\n\n<!-- agent-router:begin distilled -->\n## Distilled\n<!-- agent-router:end distilled -->\n`;
  mkdirSync(`${b.vault}/wiki/logs`, { recursive: true });
  writeFileSync(`${b.vault}/wiki/logs/${day} old lg.md`, gen('lg'));
  writeFileSync(`${b.vault}/wiki/logs/${day} old ed.md`, gen('ed') + '\nMY OWN NOTE\n');
  const wdb = new DatabaseSync(b.ledger, { timeout: 2000 });
  t.after(() => wdb.close());
  for (const sk of ['lg', 'ed']) wdb.prepare('insert into brain_sessions (session_key, last_captured_ts, note_path) values (?, 1, ?)').run(sk, `wiki/logs/${day} old ${sk}.md`);

  const r = (await b.call('POST', 'capture', {}))[1];
  assert.deepEqual([r.notes, r.removed], [1, 1]);
  assert.deepEqual(readdirSync(`${b.vault}/wiki/logs`).sort(), [`${day} deploy the worker ok.md`, `${day} old ed.md`], 'lg removed, ed kept, tv never written');
  assert.equal(b.read(`wiki/logs/${day} old ed.md`), gen('ed') + '\nMY OWN NOTE\n', 'a note the user edited is not touched');
  assert.deepEqual((await b.rows('select session_key k, note_path is not null p, trivial from brain_sessions order by 1')).map((x) => [x.k, x.p, x.trivial]), [['ed', 1, 1], ['lg', 0, 1], ['ok', 1, 0], ['tv', 0, 1]]);
  for (const f of ['index.md', `wiki/daily/${day}.md`, 'wiki/projects/proj-x.md']) {
    assert.ok(b.read(f).includes(`[[${day} deploy the worker ok]]`), `${f} lists the real session`);
    assert.ok(!b.read(f).includes('old ed') && !b.read(f).includes('old lg') && !b.read(f).includes('worker tv'), `${f} lists a one-shot`);
  }
  assert.match(b.read('log.md'), /remove wiki\/logs\/.* old lg\.md \(one-shot session\)/);
  assert.equal((await b.call('GET', 'stats'))[1].sessions_captured, 1);
  assert.deepEqual((await b.call('POST', 'capture', {}))[1].removed, 0, 'nothing left to remove');
  assert.deepEqual(b.calls(), [], 'no model call');
  b.noLeak();
});

// ---- brain pipeline, graph, opening the vault (docs/BRAIN.md "Viewer") ----
test('brain pipeline: one session per stage, funnel counts and chip data; scan calls only the classifier; scan-all reports progress, 409s a second run, stops at the cap; extract-all reuses the scans', async (t) => {
  const b = await brainSetup(t), TAG = 'x-agent-router-source: brain', pipe = async () => (await b.call('GET', 'pipeline'))[1];
  for (const sk of ['p1', 'p2', 'p3', 'p4', 'p5']) await b.session(sk, (rid) => worked(sk, rid));
  await b.session('p0', (rid) => worked('p0', rid, 3)); // 4 tool calls: kept as a note, too small for the gate
  await b.call('POST', 'capture', {});
  let p = await pipe();
  assert.deepEqual(p.stages.map((s: any) => [s.id, s.label, s.model, s.count]), [['captured', 'Captured · no model', null, 6], ['scanned', 'Scanned · Haiku', 'haiku', 0], ['extracted', 'Extracted · Sonnet', 'sonnet', 0],
    ['candidate', 'Skill candidate · you review', null, 0], ['promoted', 'Promoted · you decide', null, 0]]);
  assert.deepEqual([p.todo, p.cap, p.running], [{ scan: { count: 5, estimate_usd: null }, extract: { count: 0, estimate_usd: null } }, { spent_usd: 0, cap_usd: 1 }, null], 'no call yet: no estimate');

  // scan = the classifier alone, asked for a repeatable skill
  const [status, gate] = await b.call('POST', 'scan', { session: 'p2' });
  assert.deepEqual([status, gate.gated, gate.want_skill, gate.answers.kind], [200, true, true, { value: 'skill', confidence: 0.85 }]);
  assert.deepEqual(b.calls(), [`classifier haiku ${TAG}`], 'one classifier call, no writer');
  assert.ok(readFileSync(`${b.tmp}/prompt.classifier`, 'utf8').includes(JSON.stringify(REUSABLE).slice(1, -1)), 'the classifier is asked for a repeatable skill');
  assert.deepEqual({ ...(await b.rows(`select distilled_ts, scan_usd, extract_usd, gate_backend from brain_sessions where session_key = 'p2'`))[0] }, { distilled_ts: null, scan_usd: 0, extract_usd: null, gate_backend: 'model' });
  assert.deepEqual([(await b.call('POST', 'scan', {}))[0], await b.call('POST', 'scan', { session: 'nope' })], [400, [404, { error: { type: 'no_note' } }]]);
  // p3: knowledge, extracted, no skill. p4: scanned, then extracted off that scan (no second classifier call) -> candidate. p5: promoted.
  writeFileSync(`${b.tmp}/classifier.json`, gateJson('project-knowledge', 0.9));
  assert.deepEqual((await b.call('POST', 'distill', { session: 'p3' }))[1].skill, null);
  assert.ok(!readFileSync(`${b.tmp}/prompt.writer`, 'utf8').includes('The classifier found a repeatable skill'));
  writeFileSync(`${b.tmp}/classifier.json`, gateJson('skill', 0.85));
  await b.call('POST', 'scan', { session: 'p4' });
  assert.deepEqual((await b.call('POST', 'distill', { session: 'p4' }))[1].skill, 'deploy-worker');
  assert.deepEqual(b.calls().slice(1), [`classifier haiku ${TAG}`, `writer sonnet ${TAG}`, `classifier haiku ${TAG}`, `writer sonnet ${TAG}`], 'p4\'s extract used its scan');
  const asked = readFileSync(`${b.tmp}/prompt.writer`, 'utf8');
  assert.match(asked, /The classifier found a repeatable skill in this session\. Write it in "skill": a name, a description that says when to use it, and a body\nwith the prerequisites, numbered steps with the exact commands that worked, and the pitfalls seen in the session\./);
  assert.match(asked, /## Prerequisites[\s\S]*## Steps[\s\S]*## Pitfalls/);
  writeFileSync(`${b.tmp}/writer.json`, JSON.stringify({ ...WRITER, skill: { ...WRITER.skill, name: 'ship-worker' } }));
  assert.deepEqual((await b.call('POST', 'distill', { session: 'p5' }))[1].skill, 'ship-worker');
  assert.equal((await b.call('POST', 'skills/ship-worker/promote'))[0], 200);

  p = await pipe();
  assert.deepEqual(p.stages.map((s: any) => s.count), [6, 4, 3, 2, 1], 'cumulative: a funnel');
  const row = Object.fromEntries(p.rows.map((r: any) => [r.session_key, r])), chips = (r: any) => [r.stage, r.pre, r.scan && [r.scan.backend, r.scan.reusable, r.scan.kind, r.scan.matches, r.scan.confidence], r.extract && [r.extract.ts > 0, r.extract.usd, r.extract.skipped_reason], r.skill, r.queued];
  assert.deepEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5'].map((k) => chips(row[k])), [
    ['captured', false, null, [false, null, 'prefilter'], null, false],
    ['captured', true, null, null, null, false],
    ['scanned', true, ['model', true, 'skill', null, 0.85], null, null, false],
    ['extracted', true, ['model', true, 'project-knowledge', null, 0.9], [true, 0, null], null, false],
    ['candidate', true, ['model', true, 'skill', null, 0.85], [true, 0, null], { name: 'deploy-worker', status: 'candidate' }, false],
    ['promoted', true, ['model', true, 'skill', 'new', 0.85], [true, 0, null], { name: 'ship-worker', status: 'promoted' }, false]]);
  assert.deepEqual([row.p1.title, row.p1.project, row.p1.turns, row.p1.tool_calls, row.p0.tool_calls, row.p1.note_path, row.p2.scan.ts > 0], ['deploy the worker p1', 'proj-x', 1, 9, 4, `wiki/logs/${new Date().toLocaleDateString('sv')} deploy the worker p1.md`, true]);
  assert.deepEqual(p.todo, { scan: { count: 1, estimate_usd: 0 }, extract: { count: 1, estimate_usd: 0 } }, 'p1 to scan, p2 to extract; the fake calls cost nothing');
  // low confidence: scanned, the writer is skipped
  writeFileSync(`${b.tmp}/classifier.json`, gateJson('nothing', 0.9));
  await b.call('POST', 'scan', { session: 'p1' });
  assert.deepEqual(chips((await pipe()).rows.find((r: any) => r.session_key === 'p1')).slice(0, 4), ['scanned', true, ['model', true, 'nothing', 'new', 0.9], [false, null, 'nothing']]);

  // scan-all: three unscanned sessions, a $0.50 cap. The first call is held open; brain spend lands meanwhile; the second never starts.
  writeFileSync(`${b.tmp}/classifier.json`, gateJson('skill', 0.85));
  for (const sk of ['q1', 'q2', 'q3']) await b.session(sk, (rid) => worked(sk, rid));
  await b.call('POST', 'capture', {});
  const wdb = new DatabaseSync(b.ledger, { timeout: 2000 });
  t.after(() => wdb.close());
  wdb.exec('update brain_sessions set scan_usd = 0.004 where scan_usd is not null'); // history: every scan so far cost $0.004
  await b.put({ brain_daily_usd: 0.5 });
  const n0 = b.calls().length;
  writeFileSync(`${b.tmp}/hold`, '');
  const [s1, r1] = await b.call('POST', 'scan-all', {});
  assert.deepEqual([s1, r1.ok, r1.kind, r1.total, r1.cap], [202, true, 'scan', 3, { spent_usd: 0, cap_usd: 0.5 }]);
  close(r1.estimate_usd, 3 * 0.004, 'count × the recent average');
  assert.deepEqual([(await b.call('POST', 'scan-all', {}))[1].error.type, (await b.call('POST', 'extract-all', {}))[0]], ['brain_busy', 409], 'one background run at a time');
  await until(() => b.calls().length === n0 + 1, 'first scan started');
  assert.deepEqual((await pipe()).running, { kind: 'scan', done: 0, total: 3 });
  b.s.usage = B_USAGE; // $0.825 of brain spend, over the cap
  await b.msg('own', { model: 'claude-haiku-4-5' }, { 'x-agent-router-source': 'brain' });
  await until(async () => (await pipe()).cap.spent_usd > 0.5, 'brain spend logged');
  rmSync(`${b.tmp}/hold`);
  p = await until(async () => { const x = await pipe(); return !x.running && x; }, 'scan-all finished');
  assert.deepEqual(b.calls().slice(n0), [`classifier haiku ${TAG}`], 'stopped at the cap: one scan, no writer');
  assert.match(b.stdout(), /brain: scan-all stopped at the daily cap after 1 of 3/);
  const scanned = p.rows.filter((r: any) => /^q/.test(r.session_key) && r.scan);
  assert.deepEqual([p.stages[1].count, scanned.length, p.todo.scan.count], [6, 1, 2]);
  close(scanned[0].scan.usd, B_USD, 'a scan costs what the brain spent while it ran');
  assert.deepEqual(await b.call('POST', 'scan-all', {}), [409, { error: { type: 'brain_over_cap' } }]);
  assert.deepEqual(await b.call('POST', 'scan', { session: 'q1' }), [409, { error: { type: 'brain_over_cap' } }], 'a single scan over the cap is refused, not queued');
  assert.equal((await b.rows(`select coalesce(sum(queued), 0) q from brain_sessions`))[0].q, 0);

  // extract-all: the two scanned-and-wanted sessions (p2 and the q above), straight to the writer
  await b.put({ brain_daily_usd: 100 });
  const [s2, r2] = await b.call('POST', 'extract-all', {});
  assert.deepEqual([s2, r2.kind, r2.total], [202, 'extract', 2]);
  p = await until(async () => { const x = await pipe(); return !x.running && x; }, 'extract-all finished');
  assert.deepEqual(b.calls().slice(n0 + 1), [`writer sonnet ${TAG}`, `writer sonnet ${TAG}`], 'extract-all reuses the stored scans');
  assert.deepEqual([p.stages[2].count, p.todo.extract.count], [5, 0]);
  b.noLeak();
});

test('brain graph: nodes by type, provenance and use edges, reciprocal wikilinks in the notes, user text kept', async (t) => {
  const b = await brainSetup(t), day = new Date().toLocaleDateString('sv'), graph = async () => (await b.call('GET', 'graph'))[1];
  assert.deepEqual(await graph(), { nodes: [], edges: [] }, 'an empty vault is an empty graph');
  await b.session('ga', (rid) => worked('ga', rid));
  // gb invokes the skill ga will produce
  await b.session('gb', (rid) => jrow('gb', { type: 'user', message: { role: 'user', content: 'deploy it again' } }) + tuse('gb', rid, 'gb-s', 'Skill', { skill: 'deploy-worker' }) + tres('gb', 'gb-s')
    + tuse('gb', rid, 'gb-1', 'Bash', { command: 'npx wrangler deploy' }) + tres('gb', 'gb-1') + tuse('gb', rid, 'gb-2', 'Bash', { command: 'npx wrangler tail' }) + tres('gb', 'gb-2'));
  await until(async () => (await b.rows(`select 1 from tool_uses where name = 'Skill' and arg = 'deploy-worker'`)).length, 'skill use joined');
  await b.call('POST', 'capture', {});
  assert.equal((await b.call('POST', 'distill', { session: 'ga' }))[1].skill, 'deploy-worker');
  const A = `wiki/logs/${day} deploy the worker ga.md`, B = `wiki/logs/${day} deploy it again.md`, P = 'wiki/projects/proj-x.md', D = `wiki/daily/${day}.md`, K = 'skills/deploy-worker.md';
  // the provenance is in the files: session -> skill note, skill note -> session, project and the SKILL.md
  assert.match(b.read(A), /\n\nSkill candidate: \[\[skills\/deploy-worker\|deploy-worker\]\]\n<!-- agent-router:end distilled -->/);
  assert.match(b.read(K), new RegExp(`^---\\nskill: deploy-worker\\ntags: \\[skill\\]\\n---\\n<!-- agent-router:begin -->\\n# deploy-worker\\n\\nStatus: candidate · Source: \\[\\[${day} deploy the worker ga\\]\\] · Project: \\[\\[proj-x\\]\\]\\n[\\s\\S]*\\nSkill file: \\[\\[skills/candidates/deploy-worker/SKILL\\|SKILL\\.md\\]\\]\\n`));
  assert.ok(!b.read('index.md').includes('## Skills (promoted)'), 'a candidate\'s note is not listed as promoted');
  // the user's own lines, outside the markers, with a link of their own
  appendFileSync(`${b.vault}/${A}`, `\nMY OWN NOTE, see [[${day} deploy it again]]\n`);
  appendFileSync(`${b.vault}/${K}`, '\nMY SKILL NOTE\n');

  let g = await graph();
  const types = (x: any) => Object.fromEntries(['session', 'project', 'day', 'skill', 'candidate', 'tag'].map((k) => [k, x.nodes.filter((n: any) => n.type === k).map((n: any) => n.id)]));
  const pairs = (x: any, kind: string) => x.edges.filter((e: any) => e.kind === kind).map((e: any) => [e.a, e.b].sort().join(' ~ ')).sort();
  assert.deepEqual(types(g), { session: [B, A], project: [P], day: [D], skill: [], candidate: [K], tag: ['tag:cloudflare-workers', 'tag:deploy'] });
  assert.deepEqual(g.nodes.find((n: any) => n.id === K), { id: K, path: K, title: 'deploy-worker', type: 'candidate', degree: 3, meta: { status: 'candidate', source: 'session' } });
  assert.deepEqual(g.nodes.find((n: any) => n.id === A), { id: A, path: A, title: 'deploy the worker ga', type: 'session', degree: 6, meta: { session: 'ga', project: 'proj-x' } });
  assert.deepEqual(pairs(g, 'source'), [`${K} ~ ${A}`], 'the candidate is tied to the session it came from');
  assert.deepEqual(pairs(g, 'used'), [`${K} ~ ${B}`], 'a Skill call in a transcript');
  assert.deepEqual(pairs(g, 'project'), [`${K} ~ ${P}`, `${B} ~ ${P}`, `${A} ~ ${P}`].sort());
  assert.deepEqual(pairs(g, 'day'), [`${D} ~ ${B}`, `${D} ~ ${A}`].sort());
  assert.deepEqual(pairs(g, 'tag'), [`tag:cloudflare-workers ~ ${A}`, `tag:deploy ~ ${A}`]);
  assert.deepEqual(pairs(g, 'link'), [`${B} ~ ${A}`].sort(), 'the user\'s own wikilink; links that repeat a typed edge are not doubled');
  assert.equal(g.edges.length, 10);

  // promote: the same node becomes a skill; the generated blocks are rewritten, the user's lines stay
  assert.equal((await b.call('POST', 'skills/deploy-worker/promote'))[0], 200);
  g = await graph();
  assert.deepEqual([types(g).skill, types(g).candidate, g.edges.length], [[K], [], 10]);
  assert.match(b.read(K), /Status: promoted since \d{4}-\d\d-\d\d · Source: \[\[[^\]]+ ga\]\] · Project: \[\[proj-x\]\]\n[\s\S]*<!-- agent-router:end -->\n\nMY SKILL NOTE\n$/);
  assert.match(b.read(A), /\n\nSkill: \[\[skills\/deploy-worker\|deploy-worker\]\]\n<!-- agent-router:end distilled -->\n\nMY OWN NOTE, see \[\[[^\]]+\]\]\n$/);
  assert.match(b.read('index.md'), /## Skills \(promoted\)\n\n- \[\[deploy-worker\]\]\n/);
  // a later extract that returns no skill keeps the link; demote keeps the note; reject removes the link and the node
  writeFileSync(`${b.tmp}/writer.json`, JSON.stringify({ ...WRITER, skill: null }));
  await b.call('POST', 'distill', { session: 'ga' });
  assert.equal(b.read(A).split('[[skills/deploy-worker|deploy-worker]]').length, 2);
  assert.equal((await b.call('POST', 'skills/deploy-worker/demote'))[1].status, 'candidate');
  assert.match(b.read(K), /Status: candidate · Source: /);
  assert.equal((await b.call('POST', 'skills/deploy-worker/reject'))[1].status, 'rejected');
  assert.ok(!b.read(A).includes('[[skills/') && b.read(A).includes('MY OWN NOTE') && b.read(K).endsWith('\nMY SKILL NOTE\n'), 'the link goes; a note the user wrote in is not deleted');
  g = await graph();
  assert.deepEqual([types(g).skill, types(g).candidate, pairs(g, 'source'), pairs(g, 'used')], [[], [], [], []]);
  b.noLeak();
});

test('brain open: obsidian flag follows OBSIDIAN_APP; open runs the opener on the vault only; 409 while disabled', async (t) => {
  const bin = mkdtempSync(`${tmpdir()}/router-bin-`), app = `${bin}/Obsidian.app`, mac = process.platform === 'darwin';
  for (const n of ['open', 'xdg-open']) writeFileSync(`${bin}/${n}`, `#!/bin/sh\necho "$@" >> ${bin}/opened\n`, { mode: 0o755 }); // no window is opened by this test
  const b = await brainSetup(t, { OBSIDIAN_APP: app, PATH: `${bin}:${process.env.PATH}` }, false);
  assert.equal((await b.call('GET', 'stats'))[1].obsidian, false);
  for (const [p, body] of [['open', { target: 'folder' }], ['open', { target: 'obsidian' }], ['scan', { session: 's' }], ['scan-all', {}], ['extract-all', {}]] as [string, any][])
    assert.deepEqual(await b.call('POST', p, body), [409, { error: { type: 'brain_disabled' } }], p);
  await b.put({ brain_enabled: true });
  assert.deepEqual(await b.call('POST', 'open', { target: 'obsidian' }), [409, { error: { type: 'obsidian_not_installed' } }]);
  assert.deepEqual((await b.call('POST', 'open', { target: '/etc' }))[1].error.type, 'bad_target');
  // the directory is the configured vault, whatever the client sends
  assert.deepEqual(await b.call('POST', 'open', { target: 'folder', path: '/etc', dir: '/etc' }), [200, { ok: true, target: 'folder' }]);
  mkdirSync(app);
  assert.equal((await b.call('GET', 'stats'))[1].obsidian, true);
  assert.equal((await b.call('POST', 'open', { target: 'obsidian' }))[0], 200);
  const opened = await until(() => { const l = existsSync(`${bin}/opened`) ? readFileSync(`${bin}/opened`, 'utf8').trim().split('\n') : []; return l.length === 2 && l.sort(); }, 'opener ran twice');
  assert.deepEqual(opened, [mac ? `-a ${app} ${b.vault}` : `obsidian://open?path=${encodeURIComponent(b.vault)}`, b.vault].sort());
  b.noLeak();
});

test('ui.html: Brain has the Pipeline, Notes and Graph views; the layout runs to rest on 200 notes and leaves a pinned one alone; no form.id read', () => {
  const page = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');
  for (const x of ["['pipeline', 'Pipeline'], ['notes', 'Notes'], ['graph', 'Graph']", 'data-bview=', 'brainPipeline(t)', 'brainGraph(t, hits)', 'id="graph"', "data-target=\"folder\">Reveal folder", "Obsidian isn\\'t installed — the Graph view here shows the same links."])
    assert.ok(page.includes(x), `ui.html lacks ${x}`);
  assert.ok(!page.includes('e.target.id ===') && !page.includes('obsidian://'), 'no form.id read, no dead obsidian:// link');
  const glayout = new Function(`${page.slice(page.indexOf('// graph:begin'), page.indexOf('// graph:end'))}; return glayout;`)() as (N: any[], E: any[], iters?: number, step?: number) => void;
  const N = Array.from({ length: 200 }, (_, i) => ({ x: 14 * Math.sqrt(i + 1) * Math.cos(i * 2.4), y: 14 * Math.sqrt(i + 1) * Math.sin(i * 2.4), pin: i === 7 }));
  const E = N.flatMap((_, i) => [{ a: i, b: (i * 7 + 1) % 200 }, ...(i % 3 ? [] : [{ a: i, b: (i + 40) % 200 }])]), pinned = { ...N[7] }, t0 = performance.now();
  glayout(N, E);
  const ms = performance.now() - t0, far = Math.max(...N.map((n) => Math.hypot(n.x, n.y)));
  assert.ok(N.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)) && far < 5000, `positions stay finite and near the centre (max ${far})`);
  assert.deepEqual(N[7], pinned, 'a pinned note does not move');
  let near = Infinity;
  for (let i = 0; i < 200; i++) for (let j = i + 1; j < 200; j++) near = Math.min(near, Math.hypot(N[i].x - N[j].x, N[i].y - N[j].y));
  assert.ok(near > 2, `no two notes on top of each other (closest ${near.toFixed(1)})`);
  assert.ok(ms < 3000, `200 notes laid out in ${ms.toFixed(0)} ms`);
});

// ---- limits as the unit, keep warm, tool loading advisor, facts switch (docs/COST-INSIGHTS.md "Next") ----
// rows written straight into the arith ledger (console.ts is imported in-process): one priced /v1/messages row per call
const RLH = 'anthropic-ratelimit-unified-';
async function ledgerRows() {
  const c = await arith(), { db } = await import('./ledger.ts');
  const ins = db.prepare(`insert into requests (ts, request_id, session_key, account_id, method, path, model, status, in_tok, out_tok, cache_read, cache_create, cache_1h, cache_5m, agent_id,
    tools_hash, tools_count, tool_names_json, tool_servers_json, first_user_hash, ratelimit_json) values (:ts, :request_id, :session_key, :account_id, 'POST', '/v1/messages', :model, 200, :in_tok, :out_tok, :cache_read,
    :cache_create, :cache_1h, :cache_5m, :agent_id, :tools_hash, :tools_count, :tool_names_json, :tool_servers_json, :first_user_hash, :ratelimit_json)`);
  const row = (o: Record<string, any>) => ins.run({ ts: Date.now(), request_id: null, session_key: null, account_id: 'home', model: 'claude-opus-5-5', in_tok: 0, out_tok: 0, cache_read: 0, cache_create: 0, cache_1h: 0, cache_5m: 0,
    agent_id: null, tools_hash: null, tools_count: null, tool_names_json: null, tool_servers_json: null, first_user_hash: null, ratelimit_json: '{}', ...o });
  return { c, db, row };
}

test('limits: $ per 1% of each window from readings grouped by reset; low confidence on thin data and on use outside the router; asLimits formatting', async () => {
  const { c, row } = await ledgerRows(), t0 = Date.now() - 3 * 864e5;
  let n = 0;
  // one reading: `usd` at list price on Opus 5.5 ($4/MTok input) and the utilization the response carried
  const reading = (account_id: string, usd: number, r5: number, u5: number, u7: number) => row({ ts: t0 + n++ * 1000, account_id, in_tok: usd / 4 * 1e6,
    ratelimit_json: JSON.stringify({ [`${RLH}5h-reset`]: String(r5), [`${RLH}5h-utilization`]: String(u5), [`${RLH}7d-reset`]: '9000', [`${RLH}7d-utilization`]: String(u7) }) });
  // 'la': a window that moved 2 points (under 3: left out), one that moved 10 on $12 and one that moved 10 on $8 (the first reading's
  // own cost is before the reading, so it is not counted); the week moved 16 points on the $32 after its first reading
  reading('la', 4, 100, 0.50, 0.10); reading('la', 4, 100, 0.52, 0.10);
  for (const [u5, u7] of [[0.10, 0.12], [0.12, 0.14], [0.16, 0.16], [0.20, 0.18]]) reading('la', 4, 200, u5, u7);
  for (const [u5, u7] of [[0.00, 0.20], [0.04, 0.22], [0.10, 0.26]]) reading('la', 4, 300, u5, u7);
  // 'lb': the account that moved 43 points on $0.51 of router traffic; 'lc': two steady windows, then one that moved 40 points on $4
  reading('lb', 1, 100, 0.10, 0.10); reading('lb', 0.51, 100, 0.53, 0.19);
  for (const [r5, us] of [[100, [0, 0.05, 0.10]], [200, [0, 0.05, 0.10]]] as [number, number[]][]) for (const u of us) reading('lc', 6, r5, u, 0.5);
  reading('lc', 4, 300, 0.10, 0.5); reading('lc', 4, 300, 0.50, 0.5);
  const L = c.limits(), la = L.get('la'), lb = L.get('lb'), lc = L.get('lc');
  close(la['5h'].usd_per_pct, (12 + 8) / (10 + 10)); close(la['7d'].usd_per_pct, 32 / 16);
  assert.deepEqual([la.requests, la['5h'].windows, la['5h'].moved, la['7d'].windows, la.confidence, la.reason], [9, 2, 20, 1, 'ok', null]);
  close(lb['5h'].usd_per_pct, 0.51 / 43);
  assert.deepEqual([lb.confidence, lb.reason], ['low', 'not enough traffic through the router yet'], '43 points on $0.51');
  close(lc['5h'].usd_per_pct, 28 / 60); close(lc['5h'].usd, 28);
  assert.deepEqual([lc['5h'].confidence, lc['5h'].reason, lc.confidence], ['low', 'used outside the router', 'low'], 'the latest window moved 10 points per dollar, the median is 0.83');
  // asLimits: dollars -> percentage points of that account's windows
  const a = c.asLimits(2, 'la')!;
  close(a.pct_5h!, 2); close(a.pct_7d!, 1); assert.equal(a.confidence, 'ok');
  assert.equal(c.limText(2, 'la'), '≈ 2.0% of your 5-hour window · 1.0% of your week');
  assert.equal(c.limText(0.05, 'la'), '≈ <0.1% of your 5-hour window · <0.1% of your week');
  assert.equal(c.limText(30, 'la'), '≈ 30% of your 5-hour window · 15% of your week');
  assert.match(c.limText(1, 'lb'), /^≈ 84% of your 5-hour window · \d+% of your week \(rough\)$/);
  assert.deepEqual([c.asLimits(1, 'nobody'), c.limText(1, 'nobody'), c.limText(null, 'la'), c.limText(1, null)], [null, '', '', ''], 'no estimate: nothing is shown');
});

test('budget in % of a window: waits for the estimator and never fires; then fires through it; needs one account', async (t) => {
  const h = await budgetSetup(t);
  const b = { id: 'w', name: 'home week', scope: 'account', match: 'home', period: 'day', limit: 5, unit: 'pct_7d', action: 'stop', thresholds: [1] };
  const bad = await h.put({ budgets: [{ ...b, scope: 'project', match: 'p' }] });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error.message, /a limit in % of a window is measured against one account/);
  assert.equal((await h.put({ budgets: [{ ...b, unit: 'euros' }] })).status, 400);
  assert.equal((await h.put({ budgets: [{ ...b, scope: 'all', match: null }] })).status, 200, 'scope all with a single account');
  assert.equal((await h.put({ budgets: [b] })).status, 200);
  // no utilization readings yet: dollars are spent, the budget has no rate to convert them with
  for (let i = 0; i < 3; i++) assert.equal((await h.turn('p1')).status, 200);
  let [st] = await h.api('budgets');
  assert.deepEqual([st.state, st.spent, st.pct, st.unit, st.account], ['waiting', null, 0, 'pct_7d', 'home']); close(st.spent_usd, 3 * B_USD);
  assert.deepEqual(h.notes(), [], 'waiting for data never notifies');
  assert.equal((await h.api('limits')).find((x: any) => x.account === 'home').confidence, null);
  // two more turns between a reading of 10% and one of 20% of the week: $1.65 moved it 10 points -> $0.165 per point
  h.s.reset = Math.round(Date.now() / 1000) + 86400;
  for (const u of [0.10, 0.10, 0.20]) { h.s.util7.home = u; assert.equal((await h.turn('p1')).status, 200); }
  const lim = (await h.api('limits')).find((x: any) => x.account === 'home');
  close(lim.usd_per_pct_7d, 2 * B_USD / 10); close(lim.window_usd_7d, 20 * B_USD);
  assert.deepEqual([lim.confidence, lim.usd_per_pct_5h, lim.basis.windows_7d, lim.util_7d], ['low', null, 1, 0.2]);
  [st] = await h.api('budgets');
  close(st.spent, 6 * B_USD / (2 * B_USD / 10), 'the $4.95 spent today is 30 points of the week'); assert.equal(st.state, 'over');
  assert.equal(h.notes().length, 1); assert.match(h.notes()[0], /^Budget ‘home week’ at 600% — 30% of 5% of home's week \(\$4\.95 at list price\) — requests are now stopped$/);
  const seen = h.s.seen.length, r = await h.turn('p1');
  assert.equal(r.status, 400); assert.match(r.error.message, /budget ‘home week’ is spent: 30% of 5% of home's week \(\$4\.95 at list price\) today\./);
  assert.equal(h.s.seen.length, seen, 'not dialed');
  // a dollar budget's row says what it is in windows; with a second account a % budget over "all" is refused
  await h.put({ budgets: [{ ...b, id: 'd', unit: 'usd', limit: 100, action: 'notify' }] });
  assert.equal((await h.api('budgets'))[0].limits, '≈ 30% of your week (rough)');
  await h.addAcct('acct-b', 'tok-b-fake');
  assert.equal((await h.put({ budgets: [{ ...b, scope: 'all', match: null }] })).status, 400);
  h.noLeak();
});

// A fake upstream that answers /v1/messages as SSE with usage in message_start, and records exactly what it was sent.
async function warmSetup(t: TestContext) {
  const s = { seen: [] as { body: string; headers: IncomingMessage['headers']; aborted: boolean }[], status: 200, util: 0.1, read: 0, create: 200e3 };
  const up = await fakeUpstream(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c)).on('end', () => {
      const rec = { body: Buffer.concat(chunks).toString(), headers: req.headers, aborted: false };
      s.seen.push(rec);
      res.on('close', () => { rec.aborted = !res.writableEnded; });
      const h = { 'request-id': `req_w${s.seen.length}`, [`${RLH}5h-utilization`]: String(s.util), [`${RLH}5h-status`]: 'allowed' };
      if (s.status !== 200) return res.writeHead(s.status, { ...h, 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"authentication_error"}}');
      res.writeHead(200, { ...h, 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: s.read, cache_creation_input_tokens: s.create,
        cache_creation: { ephemeral_1h_input_tokens: s.create, ephemeral_5m_input_tokens: 0 } } } })}\n\n`);
      setTimeout(() => res.end(EV2), 150); // long enough for a ping to hang up first
    });
  });
  const log = `${mkdtempSync(`${tmpdir()}/router-notify-`)}/notify.log`;
  const r = await startRouter(t, { ...up, DRILLS: '1', NOTIFY: '0', NOTIFY_LOG: log, WARM_TICK_MS: '40', COLD_TICK_MS: '40' });
  const api = (path: string, body?: unknown, method = 'POST') => fetch(`${r.base}/router/${path}`, body === undefined ? {} : { method, body: JSON.stringify(body) }).then((x) => x.json());
  const db = new DatabaseSync(r.ledger, { readOnly: true, timeout: 2000 });
  t.after(() => db.close());
  const rows = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];
  // a main-conversation request: streamed, with tools; `pad` bytes of text carry MARKER
  const turn = async (sk: string, pad = 16e3, extra: Record<string, unknown> = {}) => {
    const body = JSON.stringify({ model: 'claude-opus-5-5', stream: true, metadata: { user_id: JSON.stringify({ session_id: sk }) }, tools: [{ name: 'Read', input_schema: {} }],
      messages: [{ role: 'user', content: `MARKER-IN-BODY ${'x'.repeat(pad)}` }], ...extra });
    const res = await fetch(`${r.base}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: 'Bearer tok-home-fake', 'content-type': 'application/json', 'anthropic-beta': 'b-1' }, body });
    await res.text(); await new Promise((ok) => setTimeout(ok, 40));
    return { status: res.status, body };
  };
  const warm = async (sk: string) => (await api('warm')).sessions.find((x: any) => x.session_key === sk);
  const pings = () => rows(`select * from requests where source = 'warm' order by id`);
  return { s, ...r, api, rows, turn, warm, pings, wait: (ms: number) => new Promise((ok) => setTimeout(ok, ms)), put: (b: unknown) => api('settings', b, 'PUT'),
    notes: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}
const M = 60_000;

test('keep warm: a request is held only for a large main conversation and only in memory; a ping replays it byte for byte, is logged as source=warm and leaves the session alone', async (t) => {
  const h = await warmSetup(t);
  await h.turn('off');
  assert.equal((await h.api('warm')).memory.entries, 0, 'nothing is held while keep-warm is off');
  assert.deepEqual(await h.api('sessions/off/warm', { hours: 1 }), { error: { type: 'warm_disabled' } });
  for (const bad of [{ warm_max_hours: 25 }, { warm_daily_usd: -1 }, { warm_enabled: 'yes' }, { warm_rules: [{ id: 'r', name: 'x', days: [7], from: '10:00', to: '11:00', scope: 'all' }] },
    { warm_rules: [{ id: 'r', name: 'x', days: [1], from: '25:00', to: '11:00', scope: 'all' }] }, { warm_rules: [{ id: 'r', name: 'x', days: [1], from: '10:00', to: '11:00', scope: 'project' }] }])
    assert.equal((await h.put(bad)).error?.type, 'invalid_setting', JSON.stringify(bad));
  assert.equal((await h.put({ warm_enabled: true, warm_min_context: 2000, warm_rules: [{ id: 'r', name: 'lunch', days: [1, 2, 3, 4, 5], from: '12:30', to: '14:00', scope: 'all', match: null }] })).warm_enabled, true);
  await h.turn('small', 2e3);                      // about 500 tokens: under warm_min_context
  await h.turn('nostream', 16e3, { stream: false });
  await h.turn('notools', 16e3, { tools: [] });
  assert.equal((await h.api('warm')).memory.entries, 0);
  const big = await h.turn('big');                 // 16 KB / 4 = 4k tokens on its first turn
  const mem = (await h.api('warm')).memory;
  assert.equal(mem.entries, 1); assert.ok(mem.bytes === Buffer.byteLength(big.body));
  const first = h.s.seen.at(-1)!, before = h.rows(`select * from sessions where session_key = 'big'`)[0];
  // the ping: same bytes, same headers (authorization included), hung up after message_start
  h.s.read = 200e3; h.s.create = 0;
  assert.deepEqual(await h.api('sessions/big/ping', {}), { ok: true, status: 200 });
  const ping = h.s.seen.at(-1)!;
  assert.equal(h.s.seen.length, 6); assert.equal(ping.body, big.body); assert.deepEqual(ping.headers, first.headers);
  assert.equal(ping.headers.authorization, 'Bearer tok-home-fake');
  await until(() => ping.aborted, 'the ping closes the stream once message_start has arrived');
  assert.equal(first.aborted, false);
  const [w] = h.pings();
  assert.deepEqual([w.session_key, w.account_id, w.status, w.model, w.request_id, w.cache_read, w.cache_create, w.in_tok, w.usage_src, w.first_user_hash],
    ['big', 'home', 200, 'claude-opus-5-5', 'req_w6', 200e3, 0, 10, 'stream', null]);
  const view = await h.api('warm');
  close(view.pings[0].usd, (200e3 * 0.2 + 10 * 4 + 1 * 20) / 1e6); close(view.spent_today_usd, view.pings[0].usd);
  // the session is untouched: same pin, turn count and last_ts; one turn in its timeline; no migration; the account was not cooled
  assert.deepEqual(h.rows(`select * from sessions where session_key = 'big'`)[0], before);
  assert.deepEqual([before.account_id, before.request_count], ['home', 1]);
  assert.equal((await h.api('sessions/big/timeline')).turns.length, 1);
  const srow = (await h.api('sessions')).find((x: any) => x.session_key === 'big');
  assert.ok(srow, 'a session with a warm row is still listed'); assert.equal(srow.cold_at, w.ts + 60 * M, 'the ping restarted the lifetime');
  assert.deepEqual(h.rows('select count(*) n from migrations')[0].n, 0);
  assert.deepEqual({ ...h.rows(`select cooling_until, needs_login from accounts where id = 'home'`)[0] }, { cooling_until: null, needs_login: 0 });
  assert.deepEqual((await h.api('sessions/small/ping', {})).error, { type: 'nothing_held' });
  // a thread the tailer has matched to a subagent transcript is not held (and what was held for it is dropped)
  await h.turn('sub'); assert.equal((await h.api('warm')).memory.entries, 2);
  const rw = new DatabaseSync(h.ledger, { timeout: 2000 }); rw.prepare(`update requests set agent_id = 'agent-1' where session_key = 'sub'`).run(); rw.close();
  await h.turn('sub'); assert.equal((await h.api('warm')).memory.entries, 1);
  // the thread's next request replaces the held one (a thread = the session and its first user message, as in the burst code)
  const next = await h.turn('big', 16e3, { max_tokens: 5 });
  assert.deepEqual((await h.api('warm')).memory, { entries: 1, bytes: Buffer.byteLength(next.body) }); assert.notEqual(next.body, big.body);
  // at most 20 are held: the oldest goes first
  await Promise.all(Array.from({ length: 22 }, (_, i) => h.turn(`lru${i}`)));
  assert.equal((await h.api('warm')).memory.entries, 20);
  assert.deepEqual((await h.api('sessions/big/ping', {})).error, { type: 'nothing_held' }, 'evicted');
  await h.put({ warm_enabled: false });
  await until(async () => (await h.api('warm')).memory.entries === 0, 'held requests are dropped when keep-warm is turned off');
  // nothing of any body reached the disk or the log
  const dir = dirname(h.ledger), files = readdirSync(dir).filter((f) => f.startsWith('ledger.sqlite')).map((f) => readFileSync(`${dir}/${f}`, 'latin1')).join('');
  assert.ok(!files.includes('MARKER-IN-BODY') && !h.stdout().includes('MARKER-IN-BODY'), 'request body text on disk or in the log');
  assert.ok(!files.includes('tok-home-fake') && !h.stdout().includes('tok-home-fake'), 'token on disk or in the log');
});

test('keep warm scheduler: one ping inside the lead window, again after a real request, stops at the daily budget, on a 401 (no cooldown, no needs_login) and above warn_pct', async (t) => {
  const h = await warmSetup(t), base = new Date().getHours() >= 20 ? 5 * 60 * M : 0; // every step on one calendar day: the budget is per day
  const clock = (min: number) => h.api('clock', { skew_ms: base + min * M });
  await clock(0);
  await h.put({ warm_enabled: true, warm_min_context: 2000 });
  await h.turn('s1');                               // writes 200k on the 1h cache: a rebuild is $1.60, a ping (a read) $0.04
  assert.equal(await h.warm('s1'), undefined, 'not covered: nobody asked for it');
  const quote = await h.api('sessions/s1/warm?hours=2');
  close(quote.ping_usd, 200010 * 0.2 / 1e6); close(quote.rebuild_usd, 200010 * 8 / 1e6); close(quote.breakeven_pings, 40); close(quote.breakeven_hours, 40 * 55 / 60);
  assert.deepEqual([quote.pings, quote.lifetime, quote.account], [2, '1h', 'home'], 'pings at 55 and 110 minutes keep it warm for 2 hours');
  assert.match(quote.text, /One ping \(a cache read of 200k tokens\): \$0\.04\nA rebuild once it has gone cold: \$1\.60\nPings needed: 2 — \$0\.08 in total\nBreak-even: a rebuild costs as much as 40 pings ≈ 37 hours/);
  assert.equal((await h.api('sessions/s1/warm', { hours: 30 })).ok, true);
  let w = await h.warm('s1');
  const t0 = h.rows(`select ts from requests where session_key = 's1'`)[0].ts;
  assert.deepEqual([w.by, w.stop, w.pings, w.next, w.until - t0 <= 8 * 60 * M], ['one-off', null, 0, t0 + 55 * M, true], 'never past warm_max_hours');
  h.s.read = 200e3; h.s.create = 0;
  await clock(54); await h.wait(200);
  assert.equal(h.pings().length, 0, 'not yet inside the 5-minute lead');
  await clock(56);
  await until(() => h.pings().length === 1, 'pinged inside the lead window'); await h.wait(250);
  assert.equal(h.pings().length, 1, 'once: the ping restarted the lifetime');
  w = await h.warm('s1');
  assert.deepEqual([w.pings, w.stop, w.next, w.cold_at], [1, null, h.pings()[0].ts + 55 * M, h.pings()[0].ts + 60 * M]); close(w.usd, (200e3 * 0.2 + 40 + 20) / 1e6);
  assert.deepEqual(h.notes(), [], 'no going-cold warning for a session that is being kept warm');
  // a real request: the session is active, the count starts over and the next ping is due 55 minutes after it
  await h.turn('s1');
  w = await h.warm('s1');
  assert.deepEqual([w.pings, w.stop], [0, null]); assert.ok(w.next > h.pings()[0].ts + 55 * M - 1000);
  // the daily budget is spent ($0.04 so far): due, but not sent
  await h.put({ warm_daily_usd: 0.03 });
  await clock(112); await h.wait(250);
  assert.equal(h.pings().length, 1); assert.equal((await h.warm('s1')).stop, 'today’s keep-warm budget of $0.03 is spent');
  await until(() => h.notes().length === 1, 'going-cold warning, since nothing keeps it warm now');
  assert.match(h.notes()[0], /^‘s1’ goes cold in 4 min — .* — keep-warm is on but does not cover this session: today’s keep-warm budget of \$0\.03 is spent$/);
  // budget raised, and the login has expired: the ping gets a 401; warming stops, the account is neither cooled nor marked
  h.s.status = 401;
  await h.put({ warm_daily_usd: 2 });
  await until(() => h.pings().length === 2, 'pinged once the budget allows it'); await h.wait(250);
  assert.deepEqual([h.pings().length, h.pings()[1].status], [2, 401], 'one failure stops it: no retry');
  assert.equal((await h.warm('s1')).stop, 'the desktop app’s login expired; warming resumes when the session next sends a request');
  assert.deepEqual({ ...h.rows(`select cooling_until, needs_login, disabled from accounts where id = 'home'`)[0] }, { cooling_until: null, needs_login: 0, disabled: 0 });
  assert.equal(h.rows('select count(*) n from migrations')[0].n, 0);
  assert.equal(h.rows(`select reason from warm_sessions where session_key = 's1'`)[0].reason, 'the desktop app’s login expired; warming resumes when the session next sends a request');
  // the next real request resumes it; that response says the account is at 90% of its 5-hour window, over warn_pct
  h.s.status = 200; h.s.util = 0.9;
  await h.turn('s1');
  assert.equal((await h.warm('s1')).stop, 'home is at 90% of its 5-hour window (warn threshold 80%)');
  await clock(170); await h.wait(250);
  assert.equal(h.pings().length, 2);
  // Stop: no cover until the session's next request, whatever else would cover it
  await h.put({ warn_pct: 0.95, warm_after_stop_hours: 6, warm_min_usd: 0 });
  assert.equal((await h.warm('s1')).stop, null);
  assert.deepEqual(await h.api('sessions/s1/warm', {}, 'DELETE'), { ok: true });
  assert.deepEqual([(await h.warm('s1')).by, (await h.warm('s1')).stop], [null, 'stopped by you']);
  await h.turn('s1');
  assert.deepEqual([(await h.warm('s1')).by, (await h.warm('s1')).stop], ['after you stop', null], 'active again: "after I stop" covers it');
});

test('keep-warm rules: a local-time window, also across midnight; a rule covers a matching session whose rebuild is worth it; Stop wins', async () => {
  const { c, db, row } = await ledgerRows(), at = (day: number, hh: number, mm: number) => new Date(2026, 8, 27 + day, hh, mm).getTime(); // 27 Sep 2026 is a Sunday: day 1 = Monday
  const night = { id: 'n', name: 'night', days: [1], from: '22:00', to: '02:00', scope: 'all', match: null }, lunch = { id: 'l', name: 'lunch', days: [3], from: '12:30', to: '14:00', scope: 'project', match: 'proj' };
  assert.equal(new Date(at(1, 0, 0)).getDay(), 1);
  assert.deepEqual([at(1, 21, 59), at(1, 22, 0), at(1, 23, 30), at(2, 1, 59), at(2, 2, 0), at(2, 23, 0), at(1, 1, 0)].map((x) => c.ruleEnd(night, x)),
    [null, at(2, 2, 0), at(2, 2, 0), at(2, 2, 0), null, null, null], 'Monday 22:00 to Tuesday 02:00; Monday 01:00 belongs to Sunday night');
  assert.deepEqual([at(3, 12, 29), at(3, 12, 30), at(3, 13, 59), at(3, 14, 0), at(4, 13, 0)].map((x) => c.ruleEnd(lunch, x)), [null, at(3, 14, 0), at(3, 14, 0), null, null]);
  // a main conversation with 200k on the 1h cache ($1.60 to rebuild), last active Wednesday 12:00, in project `proj`
  const ts = at(3, 12, 0), now = at(3, 12, 40);
  row({ ts, session_key: 'rs', cache_create: 200e3, cache_1h: 200e3, tools_count: 3, first_user_hash: 'fh' });
  db.prepare(`insert into sessions (session_key, account_id, cwd) values ('rs', 'home', '/w/proj')`).run();
  const w = c.warmth(ts - 1).find((x: any) => x.sk === 'rs')!, st = { ...(await import('./ledger.ts')).settings(), warm_enabled: true, warm_rules: [night, lunch] };
  assert.deepEqual([w.thread, w.cold_at], ['rs\0fh', ts + 60 * M]);
  c.warmMem.has = (th: string) => th === 'rs\0fh';
  let p = c.warmPlan(w, st, now);
  assert.deepEqual([p.by, p.until, p.stop, p.next, p.pings], ['rule ‘lunch’', at(3, 14, 0), null, ts + 55 * M, 0]);
  assert.equal(c.warmPlan(w, { ...st, warm_rules: [{ ...lunch, match: 'other' }] }, now).by, null, 'another project');
  assert.equal(c.warmPlan(w, { ...st, warm_min_usd: 2 }, now).by, null, 'a rebuild under warm_min_usd is not worth a rule');
  assert.equal(c.warmPlan(w, st, at(3, 14, 1)).by, null, 'the window is over');
  c.warmMem.has = () => false;
  assert.match(c.warmPlan(w, st, now).stop!, /^its last request is not in memory \(router restart or eviction\)/);
  c.warmMem.has = () => true;
  db.prepare(`insert into warm_sessions values ('rs', 0, ?, 'stopped by you')`).run(ts + 1);
  p = c.warmPlan(w, st, now);
  assert.deepEqual([p.by, p.stop, p.next], [null, 'stopped by you', null]);
});

test('tool loading advisor: always load, leave deferred, disable and tool-search-off on a fixture, with the arithmetic and where the server is defined', async () => {
  const { c, db, row } = await ledgerRows(), home = mkdtempSync(`${tmpdir()}/router-chome-`), t0 = Date.now() - 5 * 3600_000;
  // the user's own config: alpha at user scope. Only names may be read from it.
  process.env.CLAUDE_HOME = `${home}/.claude`;
  writeFileSync(`${home}/.claude.json`, JSON.stringify({ mcpServers: { alpha: { command: 'npx', env: { API_KEY: 'sk-config-secret' }, headers: { authorization: 'Bearer hdr-secret' } } } }));
  const use = db.prepare('insert into tool_uses (id, request_id, name) values (?, ?, ?)'), sess = db.prepare('insert into sessions (session_key, account_id, cwd) values (?, ?, ?)');
  const servers = { '': { loaded: 10, deferred: 0, def_tokens: 5000 }, alpha: { loaded: 0, deferred: 3, def_tokens: 1000 }, beta: { loaded: 0, deferred: 2, def_tokens: 50_000 },
    plugin_acme_gamma: { loaded: 0, deferred: 4, def_tokens: 800 }, delta: { loaded: 5, deferred: 0, def_tokens: 2000 } };
  let n = 0;
  // 12 turns per session on Opus 5.5, each reading a 100k prefix: $0.02 a request at $0.20/MTok
  const session = (sk: string, cwd: string, calls: Record<number, string>, extra: Record<string, any> = {}) => {
    sess.run(sk, 'home', cwd);
    for (let i = 1; i <= 12; i++) { const rid = `req_${sk}_${i}`;
      row({ ts: t0 + n++ * 1000, request_id: rid, session_key: sk, cache_read: 100e3, tools_count: 20, tools_hash: 'th-on', first_user_hash: sk, ...(i === 12 && extra) });
      if (calls[i]) use.run(`tu_${sk}_${i}`, rid, calls[i]); }
  };
  const alpha = Object.fromEntries([1, 3, 5, 7, 9].flatMap((i) => [[i, 'ToolSearch'], [i + 1, 'mcp__alpha__query']])); // 5 searches, each followed by an alpha call
  row({ ts: t0 - 1000, tools_hash: 'th-on', tool_names_json: '["Read","ToolSearch"]' }); // the names behind each tools_hash, as the router stores them once
  row({ ts: t0 - 1000, tools_hash: 'th-off', tool_names_json: '["Read","mcp__alpha__query"]' });
  session('t1', '/w/tp', { ...alpha, 11: 'ToolSearch', 12: 'mcp__beta__run' });
  session('t2', '/w/tp', alpha); session('t3', '/w/tp', alpha);
  session('t4', '/w/tp', { 1: 'ToolSearch', 2: 'mcp__beta__run', 3: 'Read' }, { tool_servers_json: JSON.stringify(servers) });
  session('o1', '/w/other', { 1: 'mcp__alpha__query' }, { tools_hash: 'th-off', tool_servers_json: JSON.stringify({ '': { loaded: 10, deferred: 0, def_tokens: 5000 }, alpha: { loaded: 3, deferred: 0, def_tokens: 1000 } }) });
  const v = c.toolsView(new URLSearchParams('project=tp')), by = Object.fromEntries(v.servers.map((x: any) => [x.server, x])), perTok = 48 * 0.2 / 1e6;
  assert.deepEqual([v.project, v.sessions, v.turns, v.days, v.tool_search], ['tp', 4, 48, 30, { on: true, calls: 17, sessions: 4, class: null, fix: null }]);
  assert.deepEqual(v.servers.map((x: any) => [x.server, x.class]), [['alpha', 'always_load'], ['delta', 'disable'], ['beta', 'leave_deferred'], ['plugin_acme_gamma', 'disable'], ['(built-in tools)', 'builtin']], 'ranked by dollars, built-ins last');
  // alpha: 3 of 4 sessions, 15 round trips × $0.02 against 1,000 definition tokens × 48 turns × the read price
  close(by.alpha.benefit_usd, 15 * 0.02); close(by.alpha.cost_usd, 1000 * perTok); close(by.alpha.usd, 0.30 - 0.0096);
  assert.deepEqual([by.alpha.calls, by.alpha.sessions, by.alpha.share, by.alpha.searches, by.alpha.origin, by.alpha.projects], [15, 3, 0.75, 15, 'user', ['tp']]);
  assert.deepEqual(by.alpha.where, { file: `${home}/.claude.json`.replace(process.env.HOME!, '~'), at: 'mcpServers["alpha"]', scope: 'user' });
  assert.match(by.alpha.change, /^Add `"alwaysLoad": true` to mcpServers\["alpha"\] in .*\.claude\.json \(applies from the next session\)\.$/);
  // beta: half the sessions, but 2 round trips ($0.04) do not pay for 50k tokens of definitions on every turn ($0.48)
  close(by.beta.benefit_usd, 0.04); close(by.beta.cost_usd, 0.48);
  assert.deepEqual([by.beta.share, by.beta.searches, by.beta.usd, by.beta.change, by.beta.origin], [0.5, 2, 0, null, 'app']);
  // never called: a deferred one still costs its names, a loaded one its definitions on every turn that carried them
  assert.deepEqual([by.plugin_acme_gamma.calls, by.plugin_acme_gamma.usd, by.plugin_acme_gamma.origin], [0, 0, 'plugin']);
  assert.deepEqual(by.plugin_acme_gamma.evidence, ['not called in 30 days', 'deferred: it still costs its 4 tool names in the deferred list of every request']);
  assert.match(by.plugin_acme_gamma.change, /^Switch it off in `\/mcp`: it comes from a plugin/);
  // delta's definitions are charged over the turns of the one session whose recorded tool list had them loaded (t4: 12 turns)
  close(by.delta.usd, 2000 * 12 * 0.2 / 1e6); assert.match(by.delta.evidence[1], /^loaded upfront: 2k tokens of definitions × the 12 turns that carried them × the read price = \$0\.00$/);
  assert.equal(by['(built-in tools)'].calls, 18);
  assert.deepEqual(v.tools.slice(0, 3).map((x: any) => [x.name, x.server, x.calls, x.sessions]), [['ToolSearch', null, 17, 4], ['mcp__alpha__query', 'alpha', 15, 3], ['mcp__beta__run', 'beta', 2, 2]]);
  // the other project: its newest tool list has no tool-search tool, so everything is loaded upfront
  const o = c.toolsView(new URLSearchParams('project=other&days=7'));
  assert.deepEqual([o.sessions, o.tool_search.class, o.tool_search.on], [1, 'tool_search_off', false]); assert.match(o.tool_search.fix, /"ENABLE_TOOL_SEARCH": "true"/);
  assert.deepEqual(o.servers.map((x: any) => [x.server, x.class]), [['alpha', 'loaded'], ['(built-in tools)', 'builtin']]);
  // every project together: "now" is the newest tool list (the other project's), where alpha is loaded. Nothing from the config file but the server's name got out
  const all = c.toolsView(new URLSearchParams()), a = all.servers.find((x: any) => x.server === 'alpha');
  assert.ok(all.sessions >= 5 && all.projects.includes('tp') && all.projects.includes('other'));
  assert.deepEqual([a.class, a.calls, a.sessions], ['loaded', 16, 4]);
  assert.ok(!/sk-config-secret|hdr-secret|npx/.test(JSON.stringify([v, o, all])), 'config values leaked');
  delete process.env.CLAUDE_HOME;
});

test('brain facts: "Load in every session" adds and removes exactly one import line in the user CLAUDE.md; new facts files carry no boilerplate', async (t) => {
  const chome = `${mkdtempSync(`${tmpdir()}/router-chome-`)}/.claude`, b = await brainSetup(t, { CLAUDE_HOME: chome }), md = `${chome}/CLAUDE.md`;
  const stats = async () => (await b.call('GET', 'stats'))[1], LINE = '@~/vault/CRITICAL_FACTS.md'; // the vault is under HOME: the ~ form
  assert.deepEqual([(await stats()).facts_loaded, (await stats()).facts_line, (await stats()).facts_file, existsSync(md)], [false, LINE, md, false]);
  // no file: created with just the line; off again: the file held nothing else, so it goes
  assert.deepEqual(await b.call('POST', 'facts-load', { on: true }), [200, { ok: true, facts_loaded: true }]);
  assert.equal(readFileSync(md, 'utf8'), `${LINE}\n`);
  assert.deepEqual(await b.call('POST', 'facts-load', { on: true }), [200, { ok: true, facts_loaded: true }]);
  assert.equal(readFileSync(md, 'utf8'), `${LINE}\n`, 'not added twice');
  assert.deepEqual(await b.call('POST', 'facts-load', { on: false }), [200, { ok: true, facts_loaded: false }]);
  assert.ok(!existsSync(md));
  // a file with the user's own content: the line is appended, and removing it leaves the rest byte for byte
  const mine = '# Mine\n\n- always use pnpm\n@~/other/notes.md\n';
  writeFileSync(md, mine);
  await b.call('POST', 'facts-load', { on: true });
  assert.equal(readFileSync(md, 'utf8'), `${mine}${LINE}\n`); assert.equal((await stats()).facts_loaded, true);
  await b.call('POST', 'facts-load', { on: false });
  assert.equal(readFileSync(md, 'utf8'), mine); assert.equal((await stats()).facts_loaded, false);
  // a line in the middle, and a file without a final newline
  writeFileSync(md, `# Mine\n${LINE}\nlast line`);
  assert.equal((await stats()).facts_loaded, true, 'the state is read from the file');
  await b.call('POST', 'facts-load', { on: false });
  assert.equal(readFileSync(md, 'utf8'), '# Mine\nlast line');
  await b.call('POST', 'facts-load', { on: true });
  assert.equal(readFileSync(md, 'utf8'), `# Mine\nlast line\n${LINE}\n`);
  // the template of a new facts file is one HTML comment; an existing file is never rewritten
  assert.match(b.read('CRITICAL_FACTS.md'), /^<!-- [^\n]* -->\n$/);
  await b.call('PUT', 'facts', { text: 'Deploys go through wrangler.\n' });
  await b.call('POST', 'capture', {});
  assert.equal(b.read('CRITICAL_FACTS.md'), 'Deploys go through wrangler.\n');
  const ui = readFileSync(`${import.meta.dirname}/ui.html`, 'utf8');
  assert.match(ui, /Load in every session/); assert.match(ui, /Applies from the next session; Cowork sessions skip it\./);
});

