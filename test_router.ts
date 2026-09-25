import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTls, request as httpsRequest } from 'node:https';
import { createServer as createNet, type AddressInfo } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, mkdirSync, appendFileSync, cpSync } from 'node:fs';
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
    seen: [] as { who: string; xkey?: string; body: string; enc?: string }[],
    util: {} as Record<string, number>, fail: {} as Record<string, number>,
    refreshes: [] as any[], refreshStatus: 200, n: 0,
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
      s.seen.push({ who, xkey: req.headers['x-api-key'] as string, body, enc: req.headers['content-encoding'] as string });
      const h = { 'content-type': 'application/json', 'request-id': `req_${++s.n}`, 'anthropic-ratelimit-unified-5h-utilization': String(s.util[who] ?? 0), 'anthropic-ratelimit-unified-5h-status': 'allowed' };
      if (s.fail[who] > 0) {
        s.fail[who]--;
        return res.writeHead(429, { ...h, 'retry-after': '1', 'anthropic-ratelimit-unified-representative-claim': 'five_hour' }).end('{"type":"error","error":{"type":"rate_limit_error"}}');
      }
      res.writeHead(200, h).end(JSON.stringify({ who }));
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
  assert.deepEqual({ ...(db.prepare('select * from tool_uses').get() as any) }, { id: 'tu1', request_id: 'req_1', name: 'Bash' });
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
    [5, 'idle > 1h, cache TTL expired', false, 64000],
    [3, 'MCP tool list changed (2 → 3 tools)', true, 30000],
  ]);
  assert.deepEqual(c.avoidable, { count: 1, total: 2 });
  assert.equal(c.savings_if_avoided_tokens, 30000);
  assert.equal(c.hit_rate, 113990 / (113990 + 145000 + 10040));

  // the other console views read the same rows
  const o = await h.api('overview');
  assert.equal(o.requests_today, (await h.rows('select count(*) n from requests where ts >= ?', new Date().setHours(0, 0, 0, 0)))[0].n);
  assert.equal(o.live.length, 5); assert.equal(o.live[0].cache, 'write');
  assert.match(o.policy_line, /^new sessions start on home — /);
  const cost = await h.api('cost');
  assert.ok(Array.isArray(cost.windows['5h'])); assert.equal(cost.dollars, null, 'no rate card -> no dollars');
  const ins = await h.api('insights');
  assert.deepEqual([ins.totals.bursts_avoidable, ins.totals.tokens_saved_est], [1, 30000]);
  assert.equal(ins.unused_tools.loaded, 3);
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
