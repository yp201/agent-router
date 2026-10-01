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
        ...(who in s.util7 && { 'anthropic-ratelimit-unified-7d-utilization': String(s.util7[who]) }) };
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

const B_USAGE = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 } };
const B_UNITS = 100 + 0.1 * 1000 + 1.25 * 100 + 2 * 200 + 5 * 20; // 825
async function budgetSetup(t: TestContext) {
  const log = `${mkdtempSync(`${tmpdir()}/router-notify-`)}/notify.log`, proj = mkdtempSync(`${tmpdir()}/router-proj-`);
  const h = await setup(t, { DRILLS: '1', NOTIFY: '0', NOTIFY_LOG: log, CLAUDE_PROJECTS_DIR: proj });
  h.s.usage = B_USAGE;
  // a real turn (tools, so /router/cost does not file it under one-shots); the row and the budget check land just after the response ends
  const turn = async (session: string) => { const r = await h.msg(session, { tools: [{ name: 'Read', input_schema: {} }] }); await new Promise((ok) => setTimeout(ok, 40)); return r; };
  return { ...h, proj, turn, notes: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    put: (b: unknown) => fetch(`${h.base}/router/settings`, { method: 'PUT', body: JSON.stringify(b) }) };
}

test('budgets: units formula, project/day budget notifies once at 80% and once at 100%, re-arms when the period rolls', async (t) => {
  const h = await budgetSetup(t);
  assert.deepEqual((await h.api('settings')).budgets, [], 'no budgets (so no stop) until the user adds one');
  // the session's project comes from its transcript cwd
  mkdirSync(`${h.proj}/-p`);
  writeFileSync(`${h.proj}/-p/b1.jsonl`, JSON.stringify({ type: 'user', sessionId: 'b1', cwd: '/tmp/climatefluent', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n');
  await until(async () => (await h.rows(`select cwd from sessions where session_key = 'b1'`))[0]?.cwd, 'cwd from transcript');
  const budget = { id: 'cf', name: 'climatefluent / day', scope: 'project', match: 'climatefluent', period: 'day', limit: 2000, action: 'notify', thresholds: [0.8, 1] };
  assert.equal((await h.put({ budgets: [budget] })).status, 200);
  const status = async () => (await h.api('budgets'))[0];

  await h.turn('b1');
  h.s.usage = { ...B_USAGE, cache_creation: undefined }; // no 1h/5m split -> the whole cache write at 1.25×
  await h.turn('other');
  const cost = Object.fromEntries((await h.api('cost')).per_session.map((s: any) => [s.session_key, s.units]));
  assert.deepEqual(cost, { b1: B_UNITS, other: 100 + 0.1 * 1000 + 1.25 * 300 + 5 * 20 });
  h.s.usage = B_USAGE;
  let st = await status();
  assert.deepEqual([st.spent, st.limit, st.pct, st.state, st.dollars, st.period_end > Date.now()], [B_UNITS, 2000, B_UNITS / 2000, 'ok', null, true], 'only the project counts');
  assert.deepEqual(h.notes(), []);

  await h.turn('b1'); // 1650 = 82%
  assert.equal((await status()).state, 'warn');
  await h.turn('b1'); // 2475 = 123%
  await h.turn('b1'); await h.turn('other');
  assert.equal(h.notes().length, 2, 'one per threshold, none repeated');
  assert.match(h.notes()[0], /^Budget ‘climatefluent \/ day’ at 82% — 1\.\dk of 2k units$/);
  assert.match(h.notes()[1], /^Budget ‘climatefluent \/ day’ at 123% — 2\.5k of 2k units$/);
  st = await status();
  assert.deepEqual([st.spent, st.state, st.top], [4 * B_UNITS, 'over', [{ label: 'hi', units: 4 * B_UNITS }]]);
  assert.deepEqual((await h.api('overview')).budgets, [{ name: 'climatefluent / day', pct: 4 * B_UNITS / 2000, state: 'over' }]);
  await h.put({ rate_card: { 'claude-haiku': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 } } });
  assert.ok(Math.abs((await status()).dollars - 4 * (100 + 5 * 20 + 0.1 * 1000 + 1.25 * 300) / 1e6) < 1e-12, 'dollars only from the rate card');
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
  const b = { id: 'all', name: 'everything today', scope: 'all', match: null, period: 'day', limit: 800, action: 'stop', thresholds: [1] };
  for (const bad of [{ ...b, scope: 'galaxy' }, { ...b, limit: '2M' }, { ...b, limit: 0 }, { ...b, scope: 'project' }, { ...b, scope: 'session' }, { ...b, action: 'explode' }, { ...b, thresholds: [2] }, { ...b, id: undefined }])
    assert.equal((await h.put({ budgets: [bad] })).status, 400, JSON.stringify(bad));
  assert.equal((await h.put({ budgets: [b, b] })).status, 400, 'duplicate id');
  assert.equal((await h.put({ budgets: [b] })).status, 200);

  assert.equal((await h.turn('c1')).who, 'home', 'under the limit: passes');
  const seen = h.s.seen.length, r = await h.turn('c1');
  assert.equal(r.status, 400); assert.equal(r.type, 'error'); assert.equal(r.error.type, 'invalid_request_error');
  assert.match(r.error.message, /budget ‘everything today’ is spent: 825 of 800 input-equivalent tokens today\. It resets \w{3} 00:00\. Raise or remove it at http:\/\/localhost:\d+\/router\/#cost/);
  assert.equal(h.s.seen.length, seen, 'not dialed');
  const [row] = await h.rows('select session_key, account_id, status, request_id, in_tok from requests order by id desc limit 1');
  assert.deepEqual({ ...row }, { session_key: 'c1', account_id: 'home', status: 400, request_id: null, in_tok: null });
  assert.deepEqual(h.notes(), ['Budget ‘everything today’ at 103% — 825 of 800 units — requests are now stopped']);
  const ct = await fetch(`${h.base}/v1/messages/count_tokens`, { method: 'POST', headers: { authorization: 'Bearer tok-home-fake' }, body: '{"model":"claude-haiku-4","messages":[]}' });
  assert.equal(ct.status, 200); assert.equal(h.s.seen.length, seen + 1, 'count_tokens is never blocked');

  // the runaway-agent guard: one cap, measured per session
  await h.put({ budgets: [{ id: 'cap', name: 'per-session cap', scope: 'session', match: null, period: 'session', limit: 800, action: 'stop', thresholds: [1] }] });
  assert.equal((await h.turn('c1')).status, 400, 'c1 already spent 825');
  assert.equal((await h.turn('c2')).status, 200, 'a second session has its own allowance');
  assert.match((await h.turn('c2')).error.message, /‘per-session cap’ is spent: 825 of 800 .* in this session/);
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
const gateJson = (kind: string, conf: number) => '```json\n' + JSON.stringify({ answers: { reusable: { value: true, confidence: 0.9 }, kind: { value: kind, confidence: conf }, matches: { value: 'new', confidence: 0.9 } } }) + '\n```';

async function brainSetup(t: TestContext, env: Record<string, string> = {}, enable = true) {
  const proj = mkdtempSync(`${tmpdir()}/router-proj-`), tmp = mkdtempSync(`${tmpdir()}/router-brain-`), vault = `${tmp}/vault`, skills = `${tmp}/skills`;
  // fake `claude`: canned output per prompt kind, and one line per call: kind, the --model value, the tagging env var
  writeFileSync(`${tmp}/claude`, `#!/bin/sh\np=$(cat)\ncase "$p" in "You are a classifier"*) k=classifier;; *) k=writer;; esac\necho "$k $3 $ANTHROPIC_CUSTOM_HEADERS" >> ${tmp}/calls\ncat ${tmp}/$k.json\n`, { mode: 0o755 });
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
  assert.match(note, /^---\nsession: bs\ntitle: deploy the worker\nproject: proj-x\nstarted: "\d{4}-.*"\nended: ".*"\nturns: 1\nmodels: \[claude-haiku-4\]\naccounts: \[home\]\nunits: \d+\n/);
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
  writeFileSync(`${b.proj}/-tmp-proj-x/old.jsonl`, worked('old', 'req_none', 1));
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
  assert.match(note, /<!-- agent-router:begin distilled -->\n## Distilled\n\nDeployed the worker\.\n\n### Decisions\n\n- Deploy with wrangler because the project already uses it\n\n### Learnings\n\n- wrangler needs[^\n]*\n\nSkill candidate: \[\[skills\/candidates\/deploy-worker\/SKILL\|deploy-worker\]\]\n<!-- agent-router:end distilled -->/);
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
  assert.deepEqual(q.reusable, { type: 'noul', instructions: 'The session worked out a multi-step procedure that would apply in other projects' });
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

test('brain daily cap: spend tagged source=brain over brain_daily_units queues the distill and makes no model call', async (t) => {
  const b = await brainSetup(t);
  await b.put({ brain_daily_units: 500 });
  await b.session('bc', (rid) => worked('bc', rid));
  b.s.usage = B_USAGE; // 825 units, on a request the brain's own subprocess made
  await b.msg('own', {}, { 'x-agent-router-source': 'brain' });
  await b.msg('adv', {}, { 'x-agent-router-source': 'advisor' }); // the advisor's calls are tagged too, and are not brain spend
  let st = await until(async () => { const s = (await b.call('GET', 'stats'))[1]; return s.spend_today_units && s; }, 'brain spend logged');
  assert.deepEqual([st.spend_today_units, st.cap_units, st.queued], [B_UNITS, 500, 0]);
  assert.deepEqual(await b.call('POST', 'distill', { session: 'bc' }), [200, { queued: true }]);
  assert.deepEqual(b.calls(), [], 'no subprocess call over the cap');
  assert.deepEqual({ ...(await b.rows(`select queued, gated_ts, distilled_ts from brain_sessions where session_key = 'bc'`))[0] }, { queued: 1, gated_ts: null, distilled_ts: null });
  st = (await b.call('GET', 'stats'))[1];
  assert.deepEqual([st.queued, st.distilled], [1, 0]);
  assert.equal((await b.api('cost')).one_shots.count, 1, 'own calls are not counted with the one-shots (only bc\'s request is)');
  // raise the cap: the same request goes through and clears the queue flag
  await b.put({ brain_daily_units: 100000 });
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
    { name: 'pdf-tools', status: 'promoted', uses: 1, sessions: 1, projects: 1, source: url('/a/SKILL.md'), source_session: null, source_units: null },
    { name: 'second-skill', status: 'candidate', uses: 0, sessions: 0, projects: 0, source: url('/redir'), source_session: null, source_units: null }]);
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
  for (const bad of [{ brain_distill: 'always' }, { classifier: 'gpt' }, { brain_confidence: 2 }, { brain_daily_units: '200k' }, { brain_enabled: 'yes' }, { brain_dir: 'relative/dir' }]) assert.equal((await b.put(bad)).status, 400, JSON.stringify(bad));
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
