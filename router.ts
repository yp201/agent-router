import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTls, request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { Resolver } from 'node:dns/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync, inflateSync, brotliDecompressSync, createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { db, logRequest, settings, putSetting, DEFAULTS, now, clock } from './ledger.ts';
import { startTailer, joined } from './tailer.ts';
import { consoleApi, util, timeline, advice, budgetStatus, budgetAmt, fmtUsd, warmth, limText, warmPlan, warmQuote, warmMem, BY_USER } from './console.ts';
import { CLAUDE_BIN, handoff, notify, title } from './advisor.ts';
import { brainApi, startBrain } from './brain.ts';
import { type Account, listAccounts, getAccount, setAcct, healthy, token, forget, expiresAt } from './accounts.ts';

const { UPSTREAM_IP, UPSTREAM_CA, TLS_DIR = `${homedir()}/.agent-router/ca` } = process.env;
const UP_HOST = process.env.UPSTREAM_HOST ?? 'api.anthropic.com', UP_PORT = Number(process.env.UPSTREAM_PORT ?? 443);
const UP_TRUST = UPSTREAM_CA ? [...rootCertificates, readFileSync(UPSTREAM_CA, 'utf8')] : undefined;
const PORT = Number(process.env.PORT ?? 4001), TLS_PORT = Number(process.env.TLS_PORT ?? 443);
const DUMP = process.env.DUMP_BODIES_DIR;
// host/content-length recomputed; x-agent-router-source is ours (stored in requests.source, never sent upstream); the rest are hop-by-hop
const SKIP_REQ = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect', 'te', 'trailer', 'proxy-connection', 'x-agent-router-source']);
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

// `more` with a content-type: `body` is that text, as is (the brain's trace.md); without one it is JSON, plus any other headers
const json = (res: ServerResponse, status: number, body: unknown, more?: Record<string, string>) =>
  res.writeHead(status, { 'content-type': 'application/json', ...more }).end(more?.['content-type'] ? (body as string) : JSON.stringify(body));
const all = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];
const one = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
const migrate = (...r: any[]) => db.prepare('insert into migrations (ts, session_key, from_account, to_account, est_cost_tokens, request_id, reason) values (?, ?, ?, ?, ?, ?, ?)').run(...r);

const h16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const texts = (c: any): string[] => typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text)) : [];
// Fingerprints of a /v1/messages request: hashes, counts and two short enums; no body text is kept. From tools_loaded on, these are
// the things the Claude Code docs name as the prompt-cache key (console.ts why() reads them); field names observed in NOTES.md "Cost insights".
function fingerprint(p: any, bytes: number, hdr: IncomingMessage['headers']) {
  const defs: any[] = Array.isArray(p.tools) ? p.tools : [];
  // `defer_loading: true` = a tool-search deferred definition: listed in `tools` but not part of the prompt prefix, so one appearing
  // mid-session leaves the cache intact (observed). The hash, the names and the size therefore cover the loaded definitions only.
  const loaded = defs.filter((t) => t?.defer_loading !== true), tools = loaded.map((t: any) => String(t?.name ?? t?.type ?? ''));
  // the CLI's first system block is a per-request billing header, not part of the cached prefix
  const sys = texts(p.system).filter((t) => !t.startsWith('x-anthropic-billing-header'));
  const first = texts(p.messages?.find?.((m: any) => m?.role === 'user')?.content);
  const typed = first.filter((t) => !t.trimStart().startsWith('<system-reminder>')).join('\n') || first.join('\n');
  const tools_hash = h16(tools.join('\n')), beta = String(hdr['anthropic-beta'] ?? ''), enumOf = (v: any) => (v == null || v === '' ? null : String(v).slice(0, 24));
  const images = (c: any): number => (Array.isArray(c) ? c.reduce((n, b) => n + (b?.type === 'image' ? 1 : b?.type === 'tool_result' ? images(b.content) : 0), 0) : 0);
  // per MCP server ('' = built-in tools): definitions loaded / deferred and their JSON size; mcp__<server>__<tool> names the server
  const servers: Record<string, { loaded: number; deferred: number; def_tokens: number }> = {};
  for (const t of defs) { const x = (servers[/^mcp__(.+?)__/.exec(String(t?.name ?? ''))?.[1] ?? ''] ??= { loaded: 0, deferred: 0, def_tokens: 0 });
    x[t?.defer_loading === true ? 'deferred' : 'loaded']++; x.def_tokens += Math.round(JSON.stringify(t).length / 4); }
  return {
    system_hash: h16(sys.join('\n')), tools_hash, tools_count: defs.length, msg_count: Array.isArray(p.messages) ? p.messages.length : null,
    first_user_hash: typed ? h16(typed) : null, first_user_tok: Math.round(typed.length / 4), context_est: Math.round(bytes / 4),
    tool_names_json: one('select 1 from requests where tools_hash = ? and tool_names_json is not null', tools_hash) ? null : JSON.stringify(tools),
    tools_loaded: loaded.length, tools_deferred: defs.length - loaded.length, tools_tok: loaded.length ? Math.round(JSON.stringify(loaded).length / 4) : 0,
    effort: enumOf(p.output_config?.effort ?? p.thinking?.budget_tokens), speed: enumOf(p.speed), // fast mode = speed 'fast'
    beta_hash: beta ? h16(beta.split(',').map((x) => x.trim()).sort().join(',')) : null,
    image_count: Array.isArray(p.messages) ? p.messages.reduce((n: number, m: any) => n + images(m?.content), 0) : null,
    cli_version: /claude-cli\/(\d+(?:\.\d+)*)/.exec(String(hdr['user-agent'] ?? ''))?.[1] ?? null,
    tool_servers_json: defs.length ? JSON.stringify(servers) : null, // handle() stores it only when a thread's tool list changed
  };
}
const toolSeen = new Map<string, string>(); // thread -> the tool_servers_json last stored for it (memory: stored once more per thread after a restart)
const uaShapes = new Set<string>(); // log each user-agent *shape* once (digits and hex masked), never the value
const text = (c: any): string => typeof c === 'string' ? c : Array.isArray(c) ? text(c.find((b: any) => b?.type === 'text')?.text) : '';
function sessionKey(p: any): string | null {
  try { const id = JSON.parse(p.metadata.user_id).session_id; if (id) return String(id); } catch {}
  const s = text(p.system) + text(p.messages?.find?.((m: any) => m?.role === 'user')?.content);
  return s ? createHash('sha256').update(s).digest('hex').slice(0, 16) : null;
}

const rl = (a: Account) => { try { return JSON.parse(a.last_ratelimit_json ?? '{}'); } catch { return {}; } };
const num = (v: any) => (v == null ? null : Number(v));
const at = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
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
// Proactive switch: the session's pinned account is past proactive_switch_pct on either window and a healthy account has
// proactive_min_gain more headroom -> move before sending (no failed request, no cooldown). One move per session per 10 min.
const uOf = (a: Account) => Math.max(util(a.last_ratelimit_json, '5h') ?? 0, util(a.last_ratelimit_json, '7d') ?? 0);
function proactive(a: Account, key: string) {
  const st = settings(), u = uOf(a);
  if (st.policy === 'manual' || u < st.proactive_switch_pct) return;
  if (one(`select 1 from migrations where session_key = ? and reason like 'proactive%' and ts > ?`, key, Date.now() - 10 * 60_000)) return;
  const b = listAccounts().filter((x) => x.id !== a.id && healthy(x) && uOf(x) <= u - st.proactive_min_gain).sort((x, y) => uOf(x) - uOf(y))[0];
  const w = (util(a.last_ratelimit_json, '7d') ?? 0) > (util(a.last_ratelimit_json, '5h') ?? 0) ? '7d' : '5h', p = Math.round(u * 100);
  return b && { b, why: `proactive: ${a.id} at ${p}%`, note: `${a.id} is at ${p}% of its ${w} window — moved ‘${title(key)}’ to ${b.id}` };
}
// First time an account's window crosses warn_pct: one notification per window (keyed by its reset, persisted so restarts don't repeat).
function warnCheck(id: string, j: string) {
  const warn = settings().warn_pct;
  const hit = (['5h', '7d'] as const).map((w) => ({ w, u: util(j, w) ?? 0, reset: util(j, w, 'reset') ?? 0 }))
    .filter((x) => x.u >= warn && db.prepare(`update accounts set warned_${x.w} = ? where id = ? and warned_${x.w} is not ?`).run(x.reset, id, x.reset).changes)
    .sort((x, y) => y.u - x.u)[0];
  if (hit) notify(`${id} at ${Math.round(hit.u * 100)}% of its ${hit.w} window${hit.reset ? `, resets ${at(hit.reset * 1000)}` : ''}`);
}

// ---- budgets (settings.budgets): status and the unit (dollars at list price, console.ts cost()) live in console.ts ----
const okBudget = (b: any) => !!b && typeof b === 'object' && typeof b.id === 'string' && /^[\w-]{1,64}$/.test(b.id) && typeof b.name === 'string' && !!b.name.trim() && b.name.length <= 80
  && ['all', 'project', 'account', 'session'].includes(b.scope) && ['day', 'week', 'session'].includes(b.period)
  && (b.scope === 'all' ? b.match == null : b.scope === 'session' ? b.period === 'session' && (b.match == null || typeof b.match === 'string') : typeof b.match === 'string' && b.match !== '')
  && Number.isFinite(b.limit) && b.limit > 0 && ['notify', 'stop'].includes(b.action) && (b.unit == null || ['usd', 'pct_7d', 'pct_5h'].includes(b.unit))
  && Array.isArray(b.thresholds) && b.thresholds.every((x: any) => typeof x === 'number' && x > 0 && x <= 1);
const okRule = (r: any) => !!r && typeof r === 'object' && typeof r.id === 'string' && /^[\w-]{1,64}$/.test(r.id) && typeof r.name === 'string' && !!r.name.trim() && r.name.length <= 80
  && Array.isArray(r.days) && r.days.every((d: any) => Number.isInteger(d) && d >= 0 && d <= 6) && [r.from, r.to].every((x) => typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x))
  && (r.scope === 'all' ? r.match == null : r.scope === 'project' && typeof r.match === 'string' && r.match !== ''); // settings.warm_rules
const okBudgets = (v: any) => Array.isArray(v) && v.every(okBudget) && new Set(v.map((b) => b.id)).size === v.length;
// Budgets a request counts against, with their status. project = basename of the session's cwd (known once the tailer has seen its
// transcript); a per-session budget (period 'session') is measured for this request's session.
function budgetsFor(key: string | null, acct: string, action?: string) {
  const bs = (settings().budgets as any[]).filter((b) => (!action || b.action === action) && (key || b.period !== 'session'));
  const proj = bs.some((b) => b.scope === 'project') && key ? one('select cwd from sessions where session_key = ?', key)?.cwd?.split('/').pop() : null;
  return bs.filter((b) => b.scope === 'all' || (b.scope === 'account' ? b.match === acct : b.scope === 'project' ? b.match === proj : !b.match || b.match === key))
    .map((b) => budgetStatus(b, key));
}
// After each /v1/messages: the first time a budget crosses a threshold in its current period -> one notification, recorded in budget_events.
function budgetCheck(key: string | null, acct: string) {
  for (const b of budgetsFor(key, acct)) {
    const hit = [...b.thresholds].sort((x: number, y: number) => y - x).filter((th: number) => b.spent >= th * b.limit
      && db.prepare(`insert into budget_events (budget_id, period_key, threshold, ts) select ?, ?, ?, ? where not exists
        (select 1 from budget_events where budget_id = ? and period_key = ? and threshold = ? and ts >= ?)`).run(b.id, b.period_key, th, now(), b.id, b.period_key, th, b.period_start).changes);
    if (hit.length) notify(`Budget ‘${b.name}’ at ${Math.floor(b.pct * 100)}% — ${budgetAmt(b)}${b.action === 'stop' && b.state === 'over' ? ' — requests are now stopped' : ''}`);
  }
}
const stopMsg = (b: any) => `agent-router budget ‘${b.name}’ is spent: ${budgetAmt(b)}${b.unit === 'usd' ? ' at list price' : ''} ${
  b.period === 'day' ? `today. It resets ${at(b.period_end)}` : b.period === 'week' ? 'in the last 7 days. The window is rolling: spend frees up as it ages past 7 days'
  : 'in this session. A per-session cap does not reset: start a new session'}. Raise or remove it at http://localhost:${PORT}/router/#cost`;

// Going cold (docs/COST-INSIGHTS.md A2): every 60 s. A main conversation on the 1h cache whose cached context is at least
// cold_min_context tokens, and whose rebuild would cost at least cold_min_usd, gets one notification cold_lead_min minutes before
// that cache's lifetime ends. Nothing is sent upstream. Once per idle period: `warned` holds the turn a session was last warned for.
// ponytail: in memory, so a restart inside the lead window can repeat one warning.
const warned = new Map<string, number>();
function coldTick() {
  const st = settings(), t = now();
  if (!st.cold_warn) return;
  for (const w of warmth(t - 3600_000)) {
    const left = w.cold_at! - t;
    if (!w.ttl_1h || w.ctx < st.cold_min_context || !(w.rebuild_usd! >= st.cold_min_usd) || warned.get(w.sk) === w.ts || left <= 0 || left > st.cold_lead_min * 60_000) continue;
    const plan = st.warm_enabled ? warmPlan(w, st, t) : null, lim = limText(w.rebuild_usd, pinOf(w.sk));
    if (plan?.by && !plan.stop) continue; // it is being kept warm: a ping goes out instead of a warning
    warned.set(w.sk, w.ts);
    notify(`‘${title(w.sk)}’ goes cold in ${Math.max(1, Math.round(left / 60_000))} min — a message now costs about ${fmtUsd(w.read_usd)}, after that the next turn costs about ${fmtUsd(w.rebuild_usd)}${
      lim ? ` (${lim})` : ''}${plan ? ` — keep-warm is on but does not cover this session${plan.stop ? `: ${plan.stop}` : ''}` : ''}`);
  }
}
setInterval(() => { try { coldTick(); } catch (e: any) { console.error('cold check failed:', e.message); } }, Number(process.env.COLD_TICK_MS) || 60_000).unref();

// Usage from the response stream: a tee of the bytes the client gets (never delayed or altered), decoded and parsed for `usage`.
// SSE: message_start.message.usage, then message_delta.usage (later fields win); only the current partial line is held.
// Non-stream JSON: top-level `usage`, body buffered up to 2 MB. Only numbers are kept. Any failure -> no usage on that row,
// logged once (never the content), response untouched.
// `first` (a keep-warm ping): the upstream socket is destroyed as soon as message_start's usage is read (any body byte when not SSE).
const USAGE_CAP = 2 << 20;
let usageWarned = false;
function tapUsage(up: IncomingMessage, first = false) {
  const sse = String(up.headers['content-type']).includes('text/event-stream'), enc = String(up.headers['content-encoding'] ?? '').toLowerCase();
  const z = enc === 'gzip' ? createGunzip() : enc === 'deflate' ? createInflate() : enc === 'br' ? createBrotliDecompress() : null;
  const dec = new StringDecoder('utf8'), n = (v: any) => (typeof v === 'number' ? v : null);
  let buf = '', u: any = null, dead = false, fin = false;
  const feed = (c: Buffer | null) => { // null = end of body
    if (dead) return;
    try {
      buf += c ? dec.write(c) : dec.end();
      if (buf.length > USAGE_CAP) return void ([dead, buf] = [true, '']);
      if (!sse) { if (!c && up.complete) u = JSON.parse(buf).usage; else if (first) up.destroy(); return; }
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const l of lines) {
        if (!l.startsWith('data:') || !l.includes('"usage"')) continue;
        const d = JSON.parse(l.slice(5));
        u = { ...u, ...(d.type === 'message_start' ? d.message?.usage : d.type === 'message_delta' ? d.usage : null) };
      }
      if (first && u) up.destroy();
    } catch {
      [dead, buf] = [true, ''];
      if (!usageWarned) { usageWarned = true; console.error('usage: could not parse a response stream; that row has no stream usage (logged once)'); }
    }
  };
  return new Promise<Record<string, string | number | null>>((ok) => {
    const done = () => {
      if (fin) return;
      fin = true; feed(null);
      ok(dead || !u || typeof u !== 'object' ? {} : { in_tok: n(u.input_tokens), out_tok: n(u.output_tokens), cache_read: n(u.cache_read_input_tokens), cache_create: n(u.cache_creation_input_tokens),
        cache_1h: n(u.cache_creation?.ephemeral_1h_input_tokens), cache_5m: n(u.cache_creation?.ephemeral_5m_input_tokens), usage_src: 'stream' });
    };
    if (!z) return void up.on('data', feed).on('end', done).on('close', done);
    z.on('data', feed).on('end', done).on('error', done); // a cut-off body: keep what was read
    up.on('data', (c) => z.write(c)).on('end', () => z.end()).on('close', () => z.end());
  });
}

// ---- keep warm (docs/COST-INSIGHTS.md "Keep-warm scheduler"; opt-in, settings.warm_enabled) ----
// The last request of each large main conversation, exactly as it went upstream: the raw body bytes and the header set (authorization
// included), keyed by thread (session key + first-user hash, the burst code's thread identity). Memory only: never serialised, never
// logged, gone when the router exits. At most KEEP_MAX entries and KEEP_BYTES in total; the oldest goes first.
type Kept = { sk: string; body: Buffer; path: string; headers: Record<string, any>; account_id: string; model: string | null; ts: number };
const kept = new Map<string, Kept>(), KEEP_MAX = 20, KEEP_BYTES = 64 << 20;
const keptBytes = () => [...kept.values()].reduce((n, k) => n + k.body.length, 0);
function keep(thread: string, k: Kept | null) {
  kept.delete(thread);
  if (k) kept.set(thread, k);
  for (const id of kept.keys()) { if (kept.size <= KEEP_MAX && keptBytes() <= KEEP_BYTES) break; kept.delete(id); }
}
Object.assign(warmMem, { has: (thread: string) => kept.has(thread), stats: () => ({ entries: kept.size, bytes: keptBytes() }) });
// A ping: the kept request again, unchanged, through the same dial. Not through handle(): no pin, cooldown, migration, budget stop or
// transcript join is touched, and a failure only stops that session's warming (console.ts warmPlan reads the logged status). The upstream
// socket is destroyed as soon as message_start's usage has been read. Logged as a requests row with source 'warm'.
const pinging = new Set<string>();
async function ping(k: Kept) {
  const t0 = now();
  let status = 502, rid: string | null = null, rlj = '{}', usage: Record<string, any> = {};
  pinging.add(k.sk);
  try {
    const up = await dial({ method: 'POST', path: k.path, headers: k.headers }, k.body);
    up.on('error', () => {});
    [status, rid] = [up.statusCode!, (up.headers['request-id'] as string) ?? null];
    rlj = JSON.stringify(Object.fromEntries(Object.entries(up.headers).filter(([h]) => h.startsWith('anthropic-ratelimit-')).map(([h, v]) => [h, String(v)])));
    if (status >= 300) up.destroy();
    else {
      if (rlj !== '{}') db.prepare('update accounts set last_ratelimit_json = ? where id = ?').run(rlj, k.account_id); // utilization only: no status, no cooldown
      usage = await tapUsage(up, true);
    }
  } catch (e: any) { console.error('warm ping failed:', e.message); }
  pinging.delete(k.sk);
  console.log(new Date(t0).toISOString(), 'warm ping', status, rid, k.model, k.account_id);
  try { logRequest({ ts: t0, request_id: rid, session_key: k.sk, account_id: k.account_id, method: 'POST', path: k.path, model: k.model, status, latency_ms: now() - t0, stream: 1,
    retry_of: null, ratelimit_json: rlj, source: 'warm', ...usage }); } catch (e: any) { console.error('ledger insert failed:', e.message); }
  return status;
}
// Every 30 s: ping each covered session whose cache lifetime ends within warm_lead_min (warmPlan decides, and says why not). A stop is
// logged once and, for a one-off, recorded in warm_sessions.reason. Turning the feature off drops every held request.
const stopped = new Map<string, string | null>();
function warmTick() {
  const st = settings(), t = now();
  if (!st.warm_enabled) return void kept.clear();
  for (const w of warmth(t - 25 * 3600_000)) {
    const p = warmPlan(w, st, t), k = kept.get(w.thread);
    if ((p.by || p.stop) && stopped.get(w.sk) !== p.stop) {
      stopped.set(w.sk, p.stop);
      db.prepare('update warm_sessions set reason = ? where session_key = ? and until_ts > 0').run(p.stop, w.sk);
      if (p.stop) console.log(`warm: ‘${title(w.sk)}’ is not being pinged — ${p.stop}`);
    }
    if (p.next != null && p.next <= t && k && k.account_id === p.account && !pinging.has(w.sk)) ping(k).catch((e) => console.error('warm ping failed:', e.message));
  }
}
setInterval(() => { try { warmTick(); } catch (e: any) { console.error('warm tick failed:', e.message); } }, Number(process.env.WARM_TICK_MS) || 30_000).unref();

// pick + token; an oauth account whose token can't be loaded is skipped for this request
async function choose(key: string | null, nonMsg: boolean, exclude: string[] = []) {
  for (let a; (a = pick(key, exclude, nonMsg)); exclude.push(a.id)) {
    if (a.kind !== 'oauth') return { a, tok: null };
    try { return { a, tok: (await token(a)).accessToken }; } catch {}
  }
}

// Live drills (only with DRILLS=1, else 404): POST /router/accounts/:id/fault429 {count} → the next N /v1/messages on that account are
// treated as an upstream 429 (retry-after 60) without dialing, so cooldown + replay run against the real API elsewhere.
// POST /router/accounts/:id/fake-util {util_5h?, util_7d?, reset_in_s?} writes synthetic ratelimit headers; the next real response overwrites them.
const DRILLS = process.env.DRILLS === '1';
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
  const start = now();
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
  const est = Math.round(body.length / 4), src = String(req.headers['x-agent-router-source'] ?? '');
  let fp: Record<string, any> = {}, th = ''; // th = the thread: session + first user message, as the burst code tells threads apart
  if (isMsg) {
    try { fp = fingerprint(parsed, decode(body).length, req.headers); } catch {}
    th = `${key}\0${fp.first_user_hash ?? model}`;
    if (fp.tool_servers_json && toolSeen.get(th) === fp.tool_servers_json) fp.tool_servers_json = null;
    else if (fp.tool_servers_json) { if (toolSeen.size > 2000) toolSeen.clear(); toolSeen.set(th, fp.tool_servers_json); }
    const ua = String(req.headers['user-agent'] ?? '');
    fp.ua_kind = /claude-desktop/i.test(ua) ? 'desktop' : 'cli';
    const shape = ua.replace(/[0-9a-f]{8,}/gi, 'H').replace(/\d+/g, 'N');
    if (!uaShapes.has(shape) && uaShapes.size < 20) { uaShapes.add(shape); console.log('user-agent shape:', shape); }
  }
  const log = (account_id: string, status: number, request_id: string | null, ratelimit_json: string, retry_of: number | null, usage: Record<string, any> = {}) => {
    const row = {
      ts: start, request_id, session_key: key, account_id, method: req.method!, path: req.url!, model,
      status, latency_ms: now() - start, stream: parsed.stream === true ? 1 : 0, retry_of, ratelimit_json, source: /^[\w-]{1,32}$/.test(src) ? src : null, ...fp, ...usage,
    };
    console.log(new Date(start).toISOString(), row.method, row.path, status, row.latency_ms, request_id, model, account_id);
    try { const id = logRequest(row); joined(request_id); return id; } catch (e: any) { console.error('ledger insert failed:', e.message); return null; }
  };

  let c = await choose(key, !isMsg);
  if (!c) {
    log('none', 503, null, '{}', null);
    return json(res, 503, { error: { type: 'router_no_healthy_account', message: 'every account is disabled, cooling or needs login' } });
  }
  // Budget stop: a matching `stop` budget at >= 100% answers here, without dialing. 400 invalid_request_error is what Claude Code
  // shows once and does not retry (NOTES.md "Budgets"). Fails open: a budget bug must never take the proxy down.
  if (isMsg) try {
    const over = budgetsFor(key, c.a.id, 'stop').find((b) => b.state === 'over');
    if (over) {
      log(c.a.id, 400, null, '{}', null);
      return res.writeHead(400, { 'content-type': 'application/json', 'x-should-retry': 'false' })
        .end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: stopMsg(over) } }));
    }
  } catch (e: any) { console.error('budget stop check failed:', e.message); }
  const pinned = isMsg ? pinOf(key) : undefined;
  let from = pinned && pinned !== c.a.id ? pinned : null;
  let reason = from ? `unhealthy: ${statusOf(getAccount(from))}` : null;
  let note = from && `${from} is ${statusOf(getAccount(from))} — moved ‘${title(key!)}’ to ${c.a.id}`;
  const p = key && pinned === c.a.id ? proactive(c.a, key) : undefined;
  if (p) try { c = { a: p.b, tok: p.b.kind === 'oauth' ? (await token(p.b)).accessToken : null }; [from, reason, note] = [pinned!, p.why, p.note]; } catch {}

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
    if (s !== '{}') warnCheck(a.id, s);
    return { up, h, rl: s, rid: (up.headers['request-id'] as string) ?? null, why: isMsg && forced(up.statusCode!, a) ? cool(a, up) : null };
  };

  let status = 502, requestId: string | null = null, ratelimit = '{}', retryOf: number | null = null, usage: Promise<Record<string, any>> | undefined;
  try {
    let r = await send(c);
    // Forced switch: nothing has been written to the client yet, so replay the buffered body once elsewhere.
    const next = r.why ? await choose(key, false, [c.a.id]) : undefined;
    if (next) {
      r.up.resume(); // drain so the keep-alive socket is reused
      retryOf = log(c.a.id, r.up.statusCode!, r.rid, r.rl, null);
      if (!from) {
        [from, reason] = [c.a.id, r.why];
        note = `${from} ${/^401/.test(r.why!) ? 'needs login' : 'rate-limited'} — replayed ‘${title(key!)}’ on ${next.a.id}, ${from} cools for ${Math.round((getAccount(from)!.cooling_until! - Date.now()) / 1000)} s`;
      }
      c = next;
      r = await send(c);
    }
    ({ up: { statusCode: status = 502 }, rid: requestId, rl: ratelimit } = r);
    if (from === c.a.id) from = null; // a proactive target that 429'd replayed back on the pinned account: no move
    if (isMsg && key) { // persist the pin before the client sees the response
      db.prepare(`insert into sessions (session_key, account_id, created_ts, last_ts, request_count, forced_switches, last_model) values (:key, :acct, :ts, :ts, 1, :sw, :model) on conflict (session_key) do update set
        account_id = :acct, last_ts = :ts, request_count = request_count + 1, forced_switches = forced_switches + :sw, last_model = coalesce(:model, last_model)`)
        .run({ key, acct: c.a.id, ts: start, sw: from ? 1 : 0, model });
      if (from) { migrate(start, key, from, c.a.id, est, requestId, reason); notify(note!); }
    }
    // keep warm: hold this request while it is the last one of a large main conversation (streamed, has tools, not known to be a
    // subagent's thread, cached context >= warm_min_context: the thread's previous turn, else this body / 4); otherwise drop what was held
    if (isMsg && key && !src && status < 400) try {
      const st = settings(), main = st.warm_enabled && parsed.stream === true && fp.tools_count > 0;
      const prev = main ? one(`select cache_read + cache_create ctx, agent_id from requests where session_key = ? and first_user_hash is ? and source is null and status < 400
        and cache_create is not null order by ts desc limit 1`, key, fp.first_user_hash ?? null) : null;
      keep(th, main && !prev?.agent_id && (prev?.ctx ?? fp.context_est) >= st.warm_min_context ? { sk: key, body, path: req.url!, headers: r.h, account_id: c.a.id, model, ts: start } : null);
    } catch (e: any) { console.error('keep-warm hold failed:', e.message); }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(r.up.headers)) if (!SKIP_RES.has(k)) out[k] = v;
    res.writeHead(status, out);
    if (isMsg && status < 400) usage = tapUsage(r.up);
    await pipeline(r.up, res);
  } catch (e: any) {
    if (!res.headersSent) json(res, 502, { error: { type: 'router_upstream_error', message: e.message } });
    else res.destroy();
  }

  log(c.a.id, status, requestId, ratelimit, retryOf, await usage);
  if (isMsg && status < 400) try { budgetCheck(key, c.a.id); } catch (e: any) { console.error('budget check failed:', e.message); }
}

const accountsView = () => {
  const today = new Date().setHours(0, 0, 0, 0);
  return listAccounts().map((a) => {
    const r = rl(a);
    return { ...a, status: statusOf(a), util_5h: util(a.last_ratelimit_json, '5h'), util_7d: util(a.last_ratelimit_json, '7d'),
      reset_5h: num(r[`${RL}5h-reset`]), reset_7d: num(r[`${RL}7d-reset`]), token_expires_at: expiresAt(a.id),
      pinned_sessions: one('select count(*) n from sessions where account_id = ?', a.id).n,
      requests_today: one(`select count(*) n from requests where account_id = ? and ts >= ? and (path = '/v1/messages' or path like '/v1/messages?%')`, a.id, today).n };
  });
};

// the console page as served, and its build: a short hash of ui.html's bytes. The page remembers the build it was served with (the __BUILD__ placeholder) and
// reloads itself when /router/health reports another one, so a restart with a new ui.html never leaves a stale console open.
const page = () => { const raw = readFileSync(`${import.meta.dirname}/ui.html`, 'utf8'), build = h16(raw).slice(0, 8); return { build, html: raw.replace('__BUILD__', build) }; };
async function api(req: IncomingMessage, res: ServerResponse, path: string, body: Buffer) {
  const url = new URL(req.url!, 'http://x');
  const [, , what = '', id, action] = path.split('/').map(decodeURIComponent);
  const m = req.method, now = Date.now();
  let input: any = {};
  try { input = JSON.parse(body.toString() || '{}'); } catch {}
  if (m === 'GET' && (what === '' || what === 'ui'))
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page().html);
  if (m === 'GET' && what === 'health')
    return json(res, 200, { ok: true, build: page().build, transparent: tlsOn, launchd: /agent-router/.test(process.env.XPC_SERVICE_NAME ?? ''), upstream: { host: UP_HOST, port: UP_PORT, ip: await upstreamIp().catch(() => null) }, uptime: process.uptime(), claude_bin: CLAUDE_BIN,
      ...one('select (select count(*) from accounts) accounts, (select count(*) from sessions where account_id is not null) sessions, (select count(*) from requests) requests, (select count(*) from migrations) migrations') });
  if (m === 'GET' && what === 'stats') return json(res, 200, all('select * from requests order by id desc limit 100'));
  if (m === 'GET' && what === 'settings') return json(res, 200, settings());
  if (m === 'PUT' && what === 'settings') {
    const enums: Record<string, string[]> = { policy: ['sticky_least_utilized', 'prefer_home_until_80', 'manual'], brain_distill: ['manual', 'on_idle'], classifier: ['auto', 'jev', 'model'] };
    for (const [k, v] of Object.entries(input ?? {})) {
      const d = DEFAULTS[k], ok = !(k in DEFAULTS) ? false : k.endsWith('_pct') || k === 'brain_confidence' ? typeof v === 'number' && v >= 0 && v <= 1
        : k === 'warm_rules' ? Array.isArray(v) && v.every(okRule) && new Set(v.map((r) => r.id)).size === v.length
        : k === 'warm_max_hours' ? typeof v === 'number' && v > 0 && v <= 24 : k.startsWith('warm_') && typeof d === 'number' ? typeof v === 'number' && v >= 0
        : enums[k] ? enums[k].includes(v as string) : k === 'brain_dir' ? v === null || (typeof v === 'string' && /^(~|\/)/.test(v)) : d === null ? v === null || typeof v === 'string'
        : k === 'context_rules' ? Array.isArray(v) : k === 'budgets' ? okBudgets(v) : typeof d !== 'object' ? typeof v === typeof d : typeof v === 'object' && v !== null && !Array.isArray(v);
      if (!ok) return json(res, 400, { error: { type: 'invalid_setting', key: k } });
      // a limit in % of a window is one account's window
      const bad = k === 'budgets' && (v as any[]).find((b) => (b.unit ?? 'usd') !== 'usd' && b.scope !== 'account' && !(b.scope === 'all' && listAccounts().length === 1));
      if (bad) return json(res, 400, { error: { type: 'invalid_setting', key: k, message: `budget ‘${bad.name}’: a limit in % of a window is measured against one account — use scope "account" (scope "all" only works while there is a single account)` } });
    }
    for (const [k, v] of Object.entries(input)) putSetting(k, v);
    return json(res, 200, settings());
  }
  if (m === 'GET' && what === 'overview') {
    const ok = listAccounts().filter(healthy), n = newSession(ok);
    return json(res, 200, { ...consoleApi('overview', url.searchParams, accountsView()), policy_line: n.a ? `new sessions start on ${n.a.id} — ${n.why}` : n.why });
  }
  if (m === 'GET' && ['cache', 'cost', 'insights', 'sessions', 'budgets', 'limits', 'tools', 'warm'].includes(what) && !id) return json(res, 200, await consoleApi(what, url.searchParams));
  // keep warm, one session: GET = the quote shown before it is switched on, POST {hours} = a one-off, DELETE = stop (also stops a rule's cover until its next request)
  if (what === 'sessions' && action === 'warm') {
    const st = settings(), t = now + clock.skew, set = db.prepare(`insert into warm_sessions (session_key, until_ts, created_ts, reason) values (?, ?, ?, ?)
      on conflict (session_key) do update set until_ts = excluded.until_ts, created_ts = excluded.created_ts, reason = excluded.reason`);
    if (m === 'GET') { const quote = warmQuote(id, Number(url.searchParams.get('hours'))); return quote ? json(res, 200, quote) : json(res, 404, { error: { type: 'no_warm_cache' } }); }
    if (m === 'DELETE') { set.run(id, 0, t, BY_USER); return json(res, 200, { ok: true }); }
    if (m === 'POST') {
      if (!st.warm_enabled) return json(res, 409, { error: { type: 'warm_disabled' } });
      if (!(Number(input.hours) > 0)) return json(res, 400, { error: { type: 'bad_hours' } });
      const until_ts = t + Math.min(Number(input.hours), st.warm_max_hours, 24) * 3600_000;
      set.run(id, until_ts, t, null);
      return json(res, 200, { ok: true, until_ts });
    }
  }
  if (DRILLS && m === 'POST' && what === 'sessions' && action === 'ping') { // drill: ping this session's held request now
    const k = [...kept.values()].find((x) => x.sk === id);
    return k ? json(res, 200, { ok: true, status: await ping(k) }) : json(res, 404, { error: { type: 'nothing_held' } });
  }
  if (m === 'GET' && what === 'sessions' && action === 'timeline') return json(res, 200, await timeline(id));
  if (m === 'GET' && what === 'sessions' && action === 'advice') return json(res, 200, advice(id));
  if (m === 'GET' && what === 'advice') return json(res, 200, advice());
  if (m === 'POST' && what === 'sessions' && action === 'handoff') {
    const r = await handoff(id);
    return !r ? json(res, 404, { error: { type: 'no_transcript' } }) : r.text ? json(res, 200, r) : json(res, 502, { error: { type: 'advisor_failed' } });
  }
  if (what === 'brain') return json(res, ...(await brainApi(m!, path.split('/').slice(3).map(decodeURIComponent), url.searchParams, input)));
  if (m === 'GET' && what === 'migrations') return json(res, 200, all('select * from migrations order by ts desc limit 100'));
  if (m === 'GET' && what === 'accounts') return json(res, 200, accountsView());
  if (DRILLS && m === 'POST' && what === 'clock') { clock.skew = Number(input.skew_ms) || 0; console.warn(`DRILL clock skew ${clock.skew} ms`); return json(res, 200, { ok: true, skew_ms: clock.skew }); }

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
    if (!a || (!DRILLS && /^(fault429|fake-util)$/.test(action))) return json(res, 404, { error: { type: 'not_found' } });
    if (['disable', 'enable', 'pause', 'resume'].includes(action)) setAcct(id, { disabled: action === 'disable' || action === 'pause' ? 1 : 0 });
    else if (action === 'clear-cooldown') setAcct(id, { cooling_until: null, cooling_reason: null });
    else if (action === 'fault429') { faults[id] = Math.max(0, Number(input?.count ?? 1)); console.warn(`DRILL fault429 armed: ${id} × ${faults[id]}`); return json(res, 200, { ok: true, pending: faults[id] }); }
    else if (action === 'fake-util') {
      const r = rl(a), reset = String(Math.round(now / 1000 + Number(input.reset_in_s ?? 3600)));
      for (const w of ['5h', '7d']) if (input[`util_${w}`] != null) Object.assign(r, { [`${RL}${w}-utilization`]: String(Number(input[`util_${w}`])), [`${RL}${w}-reset`]: reset });
      const j = JSON.stringify(Object.assign(r, { [`${RL}5h-status`]: 'allowed', [`${RL}status`]: 'allowed' }));
      setAcct(id, { last_ratelimit_json: j });
      console.warn(`DRILL fake-util ${id}: ${j} (synthetic until its next real response)`);
      warnCheck(id, j);
      return json(res, 200, { ok: true, ratelimit: r });
    }
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
startBrain();
