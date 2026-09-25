import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTls, request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { Resolver } from 'node:dns/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { db, logRequest, settings, putSetting, DEFAULTS } from './ledger.ts';
import { startTailer, joined } from './tailer.ts';
import { consoleApi, util, timeline, advice } from './console.ts';
import { CLAUDE_BIN, handoff } from './advisor.ts';
import { type Account, listAccounts, getAccount, setAcct, healthy, token, forget, expiresAt } from './accounts.ts';

const { UPSTREAM_IP, UPSTREAM_CA, TLS_DIR = `${homedir()}/.agent-router/ca` } = process.env;
const UP_HOST = process.env.UPSTREAM_HOST ?? 'api.anthropic.com', UP_PORT = Number(process.env.UPSTREAM_PORT ?? 443);
const UP_TRUST = UPSTREAM_CA ? [...rootCertificates, readFileSync(UPSTREAM_CA, 'utf8')] : undefined;
const PORT = Number(process.env.PORT ?? 4001), TLS_PORT = Number(process.env.TLS_PORT ?? 443);
const DUMP = process.env.DUMP_BODIES_DIR;
// host/content-length recomputed; the rest are hop-by-hop
const SKIP_REQ = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect', 'te', 'trailer', 'proxy-connection']);
// the body is piped raw, so content-encoding/content-length/transfer-encoding still describe it; only hop-by-hop goes
const SKIP_RES = new Set(['connection', 'keep-alive']);

// Upstream IP via c-ares (DNS only, never /etc/hosts, which maps UP_HOST to us in transparent mode).
const resolver = new Resolver();
let upIp: string | undefined, upIpAt = 0;
async function upstreamIp() {
  if (UPSTREAM_IP) return UPSTREAM_IP;
  if (!upIp || Date.now() - upIpAt > 5 * 60_000) {
    const ips = await resolver.resolve4(UP_HOST);
    [upIp, upIpAt] = [ips[Math.floor(Math.random() * ips.length)], Date.now()];
  }
  return upIp;
}
// Dial by IP with SNI + cert check against UP_HOST. Connect-level failures never reached upstream, so re-resolve and retry once.
async function dial(opts: Record<string, any>, body: Buffer | undefined, retry = true): Promise<IncomingMessage> {
  try {
    const host = await upstreamIp();
    return await new Promise((ok, fail) =>
      httpsRequest({ ...opts, host, port: UP_PORT, servername: UP_HOST, ca: UP_TRUST }, ok).on('error', fail).end(body));
  } catch (e: any) {
    if (!retry || UPSTREAM_IP || !['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(e.code)) throw e;
    upIp = undefined;
    return dial(opts, body, false);
  }
}
const RL = 'anthropic-ratelimit-unified-';
let dumped = 0;

const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const all = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];
const one = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
const migrate = (...r: any[]) => db.prepare('insert into migrations (ts, session_key, from_account, to_account, est_cost_tokens, request_id, reason) values (?, ?, ?, ?, ?, ?, ?)').run(...r);

const h16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const texts = (c: any): string[] => typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text)) : [];
// Fingerprints of a /v1/messages body: hashes and counts only, no body text is kept.
function fingerprint(p: any, bytes: number) {
  const tools: string[] = Array.isArray(p.tools) ? p.tools.map((t: any) => String(t?.name ?? t?.type ?? '')) : [];
  // the CLI's first system block is a per-request billing header, not part of the cached prefix
  const sys = texts(p.system).filter((t) => !t.startsWith('x-anthropic-billing-header'));
  const first = texts(p.messages?.find?.((m: any) => m?.role === 'user')?.content);
  const typed = first.filter((t) => !t.trimStart().startsWith('<system-reminder>')).join('\n') || first.join('\n');
  const tools_hash = h16(tools.join('\n'));
  return {
    system_hash: h16(sys.join('\n')), tools_hash, tools_count: tools.length, msg_count: Array.isArray(p.messages) ? p.messages.length : null,
    first_user_hash: typed ? h16(typed) : null, first_user_tok: Math.round(typed.length / 4), context_est: Math.round(bytes / 4),
    tool_names_json: one('select 1 from requests where tools_hash = ? and tool_names_json is not null', tools_hash) ? null : JSON.stringify(tools),
  };
}
const uaShapes = new Set<string>(); // log each user-agent *shape* once (digits and hex masked), never the value
const text = (c: any): string => typeof c === 'string' ? c : Array.isArray(c) ? text(c.find((b: any) => b?.type === 'text')?.text) : '';
function sessionKey(p: any): string | null {
  try { const id = JSON.parse(p.metadata.user_id).session_id; if (id) return String(id); } catch {}
  const s = text(p.system) + text(p.messages?.find?.((m: any) => m?.role === 'user')?.content);
  return s ? createHash('sha256').update(s).digest('hex').slice(0, 16) : null;
}

const rl = (a: Account) => { try { return JSON.parse(a.last_ratelimit_json ?? '{}'); } catch { return {}; } };
const num = (v: any) => (v == null ? null : Number(v));
const util5h = (a: Account) => util(a.last_ratelimit_json, '5h') ?? 0;
const statusOf = (a?: Account) => !a ? 'removed' : a.disabled ? 'disabled' : a.needs_login ? 'needs_login'
  : a.cooling_until! > Date.now() ? 'cooling' : a.last_seen ? 'ok' : 'unknown';
const pinOf = (key: string | null) => (key ? one('select account_id from sessions where session_key = ?', key)?.account_id : undefined) as string | undefined;

// Sticky: pinned healthy account wins. New sessions: settings.policy over accounts under the cutoffs.
// Non-messages endpoints never rotate: pinned if healthy, else home.
export function pick(key: string | null, exclude: string[], nonMsg: boolean) {
  const accts = listAccounts(), ok = accts.filter((a) => healthy(a) && !exclude.includes(a.id)), pin = pinOf(key);
  const found = ok.find((a) => a.id === pin);
  if (found || nonMsg) return found ?? accts.find((a) => a.kind === 'home');
  return newSession(ok).a;
}
// Returns the pick for a new session plus the reason (the Overview's policy line).
export function newSession(ok: Account[]): { a?: Account; why: string } {
  const st = settings(), home = ok.find((a) => a.kind === 'home');
  if (st.policy === 'manual') return { a: home, why: home ? 'manual policy: home only' : 'manual policy and home is unavailable' };
  // soft limits: over the 5h cutoff or into the weekly reserve -> avoided, unless nothing else is left
  const under = ok.filter((a) => util5h(a) <= st.route_cutoff_pct && (util(a.last_ratelimit_json, '7d') ?? 0) <= 1 - st.weekly_reserve_pct);
  const pool = under.length ? under : ok, skipped = ok.length - under.length && under.length ? `, ${ok.length - under.length} over cutoff/reserve` : '';
  const pct = (a: Account) => `${Math.round(util5h(a) * 100)}%`;
  const h = pool.find((a) => a.kind === 'home');
  if (st.policy === 'prefer_home_until_80' && h && util5h(h) < 0.8) return { a: h, why: `home is under 80% of its 5h window (${pct(h)})${skipped}` };
  const a = pool.sort((x, y) => util5h(x) - util5h(y) || Number(y.kind === 'home') - Number(x.kind === 'home'))[0];
  return { a, why: a ? `lowest 5h utilization (${pct(a)})${skipped}` : 'no healthy account' };
}
// pick + token; an oauth account whose token can't be loaded is skipped for this request
async function choose(key: string | null, nonMsg: boolean, exclude: string[] = []) {
  for (let a; (a = pick(key, exclude, nonMsg)); exclude.push(a.id)) {
    if (a.kind !== 'oauth') return { a, tok: null };
    try { return { a, tok: (await token(a)).accessToken }; } catch {}
  }
}

// fault injection for live drills: POST /router/accounts/:id/fault429 {count} → the next N /v1/messages on that account are
// treated as an upstream 429 (retry-after 60) without dialing, so cooldown + replay run against the real API elsewhere
const faults: Record<string, number> = {};
const forced = (status: number, a: Account) => status === 429 || status === 529 || (status === 401 && a.kind === 'oauth');
function cool(a: Account, up: IncomingMessage) {
  const g = (k: string) => up.headers[k] as string | undefined, ra = Number(g('retry-after')), now = Date.now();
  const until = g('retry-after') && ra >= 0 ? now + ra * 1000
    : g(`${RL}5h-status`) && g(`${RL}5h-status`) !== 'allowed' && g(`${RL}5h-reset`) ? Number(g(`${RL}5h-reset`)) * 1000
    : g(`${RL}reset`) ? Number(g(`${RL}reset`)) * 1000 : now + 5 * 60_000;
  const reason = `${up.statusCode} ${g(`${RL}representative-claim`) ?? ''}`.trim();
  setAcct(a.id, { cooling_until: until, cooling_reason: reason, ...(up.statusCode === 401 && { needs_login: 1 }) });
  if (up.statusCode === 401) forget(a.id);
  return reason;
}

const handler = (req: IncomingMessage, res: ServerResponse) => handle(req, res).catch((e) => {
  console.error('handler error:', e.message);
  if (!res.headersSent) json(res, 500, { error: { type: 'router_error' } }); else res.destroy();
});

async function handle(req: IncomingMessage, res: ServerResponse) {
  const start = Date.now();
  const { pathname } = new URL(req.url!, 'http://x');
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (pathname === '/router' || pathname.startsWith('/router/'))
    return api(req, res, pathname, body).catch((e) => json(res, 500, { error: { type: 'router_error', message: e.message } }));

  // the desktop CLI gzips request bodies: decode a copy for parsing, forward the raw bytes untouched
  const enc = String(req.headers['content-encoding'] ?? '').toLowerCase();
  const decode = enc === 'gzip' ? gunzipSync : enc === 'deflate' ? inflateSync : enc === 'br' ? brotliDecompressSync : (b: Buffer) => b;
  let parsed: any = {};
  try { parsed = JSON.parse(decode(body).toString()) ?? {}; } catch {} // non-JSON bodies forwarded as raw bytes, model=null

  if (DUMP && req.method === 'POST' && pathname === '/v1/messages' && dumped < 3) {
    mkdirSync(DUMP, { recursive: true });
    writeFileSync(`${DUMP}/body-${++dumped}.json`, decode(body)); // body only, never headers
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const headers: Record<string, any> = { host: UP_HOST, ...(hasBody && { 'content-length': body.length }) };
  for (const [k, v] of Object.entries(req.headers)) if (!SKIP_REQ.has(k)) headers[k] = v;

  const isMsg = req.method === 'POST' && pathname === '/v1/messages';
  const key = sessionKey(parsed), model = typeof parsed.model === 'string' ? parsed.model : null;
  const est = Math.round(body.length / 4);
  let fp: Record<string, any> = {};
  if (isMsg) {
    try { fp = fingerprint(parsed, decode(body).length); } catch {}
    const ua = String(req.headers['user-agent'] ?? '');
    fp.ua_kind = /claude-desktop/i.test(ua) ? 'desktop' : 'cli';
    const shape = ua.replace(/[0-9a-f]{8,}/gi, 'H').replace(/\d+/g, 'N');
    if (!uaShapes.has(shape) && uaShapes.size < 20) { uaShapes.add(shape); console.log('user-agent shape:', shape); }
  }
  const log = (account_id: string, status: number, request_id: string | null, ratelimit_json: string, retry_of: number | null) => {
    const row = {
      ts: start, request_id, session_key: key, account_id, method: req.method!, path: req.url!, model,
      status, latency_ms: Date.now() - start, stream: parsed.stream === true ? 1 : 0, retry_of, ratelimit_json, ...fp,
    };
    console.log(new Date(start).toISOString(), row.method, row.path, status, row.latency_ms, request_id, model, account_id);
    try { const id = logRequest(row); joined(request_id); return id; } catch (e: any) { console.error('ledger insert failed:', e.message); return null; }
  };

  let c = await choose(key, !isMsg);
  if (!c) {
    log('none', 503, null, '{}', null);
    return json(res, 503, { error: { type: 'router_no_healthy_account', message: 'every account is disabled, cooling or needs login' } });
  }
  const pinned = isMsg ? pinOf(key) : undefined;
  let from = pinned && pinned !== c.a.id ? pinned : null;
  let reason = from ? `unhealthy: ${statusOf(getAccount(from))}` : null;

  const send = async ({ a, tok }: { a: Account; tok: string | null }) => {
    const h = { ...headers };
    if (tok) { h.authorization = `Bearer ${tok}`; delete h['x-api-key']; }
    let up: any;
    if (isMsg && faults[a.id] > 0) {
      faults[a.id]--; console.warn(`fault429 injected for ${a.id} (${faults[a.id]} left)`);
      up = Object.assign(Readable.from([Buffer.from('{"type":"error","error":{"type":"rate_limit_error","message":"injected by agent-router fault429"}}')]),
        { statusCode: 429, headers: { 'retry-after': '60', 'request-id': `fault_${Date.now()}`, 'content-type': 'application/json' } });
    } else up = await dial({ method: req.method, path: req.url, headers: h }, hasBody ? body : undefined);
    const r: Record<string, string> = {};
    for (const [k, v] of Object.entries(up.headers)) if (k.startsWith('anthropic-ratelimit-')) r[k] = String(v);
    const s = JSON.stringify(r);
    db.prepare(`update accounts set last_status = ?, last_seen = ?, last_ratelimit_json = case when ? = '{}' then last_ratelimit_json else ? end where id = ?`)
      .run(up.statusCode!, Date.now(), s, s, a.id);
    return { up, rl: s, rid: (up.headers['request-id'] as string) ?? null, why: isMsg && forced(up.statusCode!, a) ? cool(a, up) : null };
  };

  let status = 502, requestId: string | null = null, ratelimit = '{}', retryOf: number | null = null;
  try {
    let r = await send(c);
    // Forced switch: nothing has been written to the client yet, so replay the buffered body once elsewhere.
    const next = r.why ? await choose(key, false, [c.a.id]) : undefined;
    if (next) {
      r.up.resume(); // drain so the keep-alive socket is reused
      retryOf = log(c.a.id, r.up.statusCode!, r.rid, r.rl, null);
      if (!from) { from = c.a.id; reason = r.why; }
      c = next;
      r = await send(c);
    }
    ({ up: { statusCode: status = 502 }, rid: requestId, rl: ratelimit } = r);
    if (isMsg && key) { // persist the pin before the client sees the response
      db.prepare(`insert into sessions (session_key, account_id, created_ts, last_ts, request_count, forced_switches, last_model) values (:key, :acct, :ts, :ts, 1, :sw, :model) on conflict (session_key) do update set
        account_id = :acct, last_ts = :ts, request_count = request_count + 1, forced_switches = forced_switches + :sw, last_model = coalesce(:model, last_model)`)
        .run({ key, acct: c.a.id, ts: start, sw: from ? 1 : 0, model });
      if (from) migrate(start, key, from, c.a.id, est, requestId, reason);
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(r.up.headers)) if (!SKIP_RES.has(k)) out[k] = v;
    res.writeHead(status, out);
    await pipeline(r.up, res);
  } catch (e: any) {
    if (!res.headersSent) json(res, 502, { error: { type: 'router_upstream_error', message: e.message } });
    else res.destroy();
  }

  log(c.a.id, status, requestId, ratelimit, retryOf);
}

const accountsView = () => {
  const today = new Date().setHours(0, 0, 0, 0);
  return listAccounts().map((a) => {
    const r = rl(a);
    return { ...a, status: statusOf(a), util_5h: num(r[`${RL}5h-utilization`]), util_7d: num(r[`${RL}7d-utilization`]),
      reset_5h: num(r[`${RL}5h-reset`]), reset_7d: num(r[`${RL}7d-reset`]), token_expires_at: expiresAt(a.id),
      pinned_sessions: one('select count(*) n from sessions where account_id = ?', a.id).n,
      requests_today: one(`select count(*) n from requests where account_id = ? and ts >= ? and (path = '/v1/messages' or path like '/v1/messages?%')`, a.id, today).n };
  });
};

async function api(req: IncomingMessage, res: ServerResponse, path: string, body: Buffer) {
  const url = new URL(req.url!, 'http://x');
  const [, , what = '', id, action] = path.split('/').map(decodeURIComponent);
  const m = req.method, now = Date.now();
  let input: any = {};
  try { input = JSON.parse(body.toString() || '{}'); } catch {}
  if (m === 'GET' && (what === '' || what === 'ui'))
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(`${import.meta.dirname}/ui.html`));
  if (m === 'GET' && what === 'health')
    return json(res, 200, { ok: true, transparent: tlsOn, launchd: /agent-router/.test(process.env.XPC_SERVICE_NAME ?? ''), upstream: { host: UP_HOST, port: UP_PORT, ip: await upstreamIp().catch(() => null) }, uptime: process.uptime(), claude_bin: CLAUDE_BIN,
      ...one('select (select count(*) from accounts) accounts, (select count(*) from sessions where account_id is not null) sessions, (select count(*) from requests) requests, (select count(*) from migrations) migrations') });
  if (m === 'GET' && what === 'stats') return json(res, 200, all('select * from requests order by id desc limit 100'));
  if (m === 'GET' && what === 'settings') return json(res, 200, settings());
  if (m === 'PUT' && what === 'settings') {
    const enums: Record<string, string[]> = { policy: ['sticky_least_utilized', 'prefer_home_until_80', 'manual'] };
    for (const [k, v] of Object.entries(input ?? {})) {
      const d = DEFAULTS[k], ok = !(k in DEFAULTS) ? false : k.endsWith('_pct') ? typeof v === 'number' && v >= 0 && v <= 1
        : enums[k] ? enums[k].includes(v as string) : d === null ? v === null || typeof v === 'string'
        : k === 'context_rules' ? Array.isArray(v) : typeof d !== 'object' ? typeof v === typeof d : typeof v === 'object' && v !== null && !Array.isArray(v);
      if (!ok) return json(res, 400, { error: { type: 'invalid_setting', key: k } });
    }
    for (const [k, v] of Object.entries(input)) putSetting(k, v);
    return json(res, 200, settings());
  }
  if (m === 'GET' && what === 'overview') {
    const ok = listAccounts().filter(healthy), n = newSession(ok);
    return json(res, 200, { ...consoleApi('overview', url.searchParams, accountsView()), policy_line: n.a ? `new sessions start on ${n.a.id} — ${n.why}` : n.why });
  }
  if (m === 'GET' && ['cache', 'cost', 'insights', 'sessions'].includes(what) && !id) return json(res, 200, consoleApi(what, url.searchParams));
  if (m === 'GET' && what === 'sessions' && action === 'timeline') return json(res, 200, timeline(id));
  if (m === 'GET' && what === 'sessions' && action === 'advice') return json(res, 200, advice(id));
  if (m === 'GET' && what === 'advice') return json(res, 200, advice());
  if (m === 'POST' && what === 'sessions' && action === 'handoff') {
    const r = await handoff(id);
    return !r ? json(res, 404, { error: { type: 'no_transcript' } }) : r.text ? json(res, 200, r) : json(res, 502, { error: { type: 'advisor_failed' } });
  }
  if (m === 'GET' && what === 'migrations') return json(res, 200, all('select * from migrations order by ts desc limit 100'));
  if (m === 'GET' && what === 'accounts') return json(res, 200, accountsView());

  if (m === 'POST' && what === 'accounts' && !id) {
    const nid = String(input.id ?? '');
    if (!/^[\w.-]{1,64}$/.test(nid)) return json(res, 400, { error: { type: 'invalid_id' } });
    if (getAccount(nid)) return json(res, 409, { error: { type: 'exists' } });
    const dir = resolve(input.config_dir ?? `${homedir()}/.agent-router/accounts/${nid}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // needs_login until a `check` finds credentials, so pick() never tries an account nobody logged into
    db.prepare(`insert into accounts (id, kind, config_dir, needs_login) values (?, 'oauth', ?, 1)`).run(nid, dir);
    return json(res, 201, { id: nid, config_dir: dir, login_cmd: `CLAUDE_CONFIG_DIR=${/^[\w./-]+$/.test(dir) ? dir : `'${dir}'`} claude auth login` });
  }
  if (m === 'POST' && what === 'accounts' && action) {
    const a = getAccount(id);
    if (!a) return json(res, 404, { error: { type: 'not_found' } });
    if (['disable', 'enable', 'pause', 'resume'].includes(action)) setAcct(id, { disabled: action === 'disable' || action === 'pause' ? 1 : 0 });
    else if (action === 'clear-cooldown') setAcct(id, { cooling_until: null, cooling_reason: null });
    else if (action === 'fault429') { faults[id] = Math.max(0, Number(input?.count ?? 1)); console.warn(`fault429 armed: ${id} × ${faults[id]}`); return json(res, 200, { ok: true, pending: faults[id] }); }
    else if (action === 'remove') {
      if (a.kind === 'home') return json(res, 400, { error: { type: 'cannot_remove_home' } });
      db.prepare('delete from accounts where id = ?').run(id);
      forget(id);
    } else if (action === 'check') {
      if (a.kind === 'home') return json(res, 200, { ok: true, expires_at: null, needs_login: false });
      forget(id);
      try {
        const o = await token(a);
        setAcct(id, { needs_login: 0 });
        return json(res, 200, { ok: true, expires_at: o.expiresAt, needs_login: false });
      } catch (e: any) {
        return json(res, 200, { ok: false, expires_at: null, needs_login: !!getAccount(id)?.needs_login, error: e.message });
      }
    } else return json(res, 404, { error: { type: 'not_found' } });
    return json(res, 200, { ok: true });
  }
  if (m === 'POST' && what === 'sessions' && action === 'pin') {
    if (!getAccount(input.account_id)) return json(res, 404, { error: { type: 'account_not_found' } });
    const cur = pinOf(id);
    db.prepare(`insert into sessions (session_key, account_id, created_ts, last_ts) values (?, ?, ?, ?)
      on conflict (session_key) do update set account_id = excluded.account_id`).run(id, input.account_id, now, now);
    if (cur !== input.account_id) migrate(now, id, cur ?? null, input.account_id, null, null, 'manual');
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: { type: 'not_found' } });
}

const server = createServer(handler).listen(PORT, '127.0.0.1', () =>
  console.log(`agent-router listening on http://127.0.0.1:${(server.address() as any).port} -> ${UP_HOST}:${UP_PORT}`));

// Transparent mode: /etc/hosts sends api.anthropic.com here. macOS lets non-root bind <1024 only on the wildcard
// address (127.0.0.1:443 is EACCES), so listen on `::` (dual-stack) and drop every non-loopback peer before TLS.
let cert, tlsOn = false;
try { cert = { cert: readFileSync(`${TLS_DIR}/api.anthropic.com.pem`), key: readFileSync(`${TLS_DIR}/api.anthropic.com-key.pem`) }; } catch {}
if (!cert) console.log('transparent mode off (no certs in TLS_DIR)');
else createTls(cert, handler)
  .on('connection', (s) => { if (!/^(::ffff:)?127\.|^::1$/.test(s.remoteAddress ?? '')) s.destroy(); })
  .on('error', (e: any) => console.error(`transparent mode off (:${TLS_PORT} ${e.code})`))
  .listen(TLS_PORT, '::', () => { tlsOn = true; console.log(`transparent mode on https://api.anthropic.com:${TLS_PORT} (loopback only)`); });
startTailer();
