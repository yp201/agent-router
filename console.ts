// Read-only views for the console UI: pure SQL + JS over the ledger (plus tool-result sizes from transcripts for carrying cost).
// Nothing here writes, and nothing here calls a model: every number is arithmetic.
import { statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { db, settings, now } from './ledger.ts';
import { windowOf, title, carrying, claudeHome } from './advisor.ts';

const all = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];
const one = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
export const MSG = (t = '') => `(${t}path = '/v1/messages' or ${t}path like '/v1/messages?%')`;
const RL = 'anthropic-ratelimit-unified-';
// a window whose reset has passed reads 0 utilization (headers are only refreshed by the next response)
export const util = (json: string | null, w: '5h' | '7d', k = 'utilization'): number | null => {
  try {
    const r = JSON.parse(json ?? '{}'), v = r[`${RL}${w}-${k}`], reset = Number(r[`${RL}${w}-reset`]);
    return v == null ? null : k === 'utilization' && reset * 1000 < Date.now() ? 0 : Number(v);
  } catch { return null; }
};
const today = () => new Date().setHours(0, 0, 0, 0);
const sum = (rows: any[], f: (r: any) => number) => rows.reduce((a, r) => a + (f(r) || 0), 0);
// ponytail: window accounting weights are unpublished; cache reads counted at their 0.1x price, everything else 1x.
const W = (r: any) => (r.in_tok ?? 0) + (r.cache_create ?? 0) + (r.out_tok ?? 0) + (r.cache_read ?? 0) / 10;
// ---- dollars at list price: THE unit for cost, budgets and insights (docs/COST-INSIGHTS.md) ----
// $/MTok [input, 5m cache write, 1h cache write, cache read, output], from https://platform.claude.com/docs/en/about-claude/pricing
// Matched by substring of the model id, first hit wins (so opus-5-5 stands before opus-5). settings.rate_card overrides per model.
export const PRICES_AS_OF = '2026-10-01';
export const PRICES: Record<string, number[]> = {
  'fable-5-1': [10, 12.5, 20, 0.25, 50], 'opus-5-5': [4, 5, 8, 0.2, 20], 'opus-5': [5, 6.25, 10, 0.5, 25],
  'sonnet-5-5': [2, 2.5, 4, 0.2, 10], 'sonnet-5': [2, 2.5, 4, 0.2, 10], 'haiku-4-5': [1, 1.25, 2, 0.1, 5],
};
type Rate = { key: string; input: number; write_5m: number; write_1h: number; read: number; output: number };
export function rates(model: string | null, rc: Record<string, any> = settings().rate_card ?? {}): Rate | null {
  const m = model ?? '', k = Object.keys(PRICES).find((x) => m.includes(x)), o = Object.keys(rc).find((x) => m.includes(x));
  if (!m || (!k && !o)) return null; // unknown model: no price, never a guess
  const [input, write_5m, write_1h, read, output] = k ? PRICES[k] : [0, 0, 0, 0, 0];
  return { key: k ?? o!, input, write_5m, write_1h, read, output, ...(o && rc[o]) };
}
// Dollars for one requests row, or for token sums of one model (SUMS). A cache write without the 1h/5m split is priced at the 5m rate.
// Fast mode on Opus 5.5 (body `speed: "fast"`) doubles input and output. null = unpriced model.
export function cost(r: any, rc?: Record<string, any>): number | null {
  const p = rates(r.model, rc);
  if (!p) return null;
  const split = r.cache_1h != null || r.cache_5m != null, f = r.speed === 'fast' && p.key === 'opus-5-5' ? 2 : 1;
  return (f * (r.in_tok ?? 0) * p.input + f * (r.out_tok ?? 0) * p.output + (r.cache_read ?? 0) * p.read
    + (split ? (r.cache_5m ?? 0) * p.write_5m + (r.cache_1h ?? 0) * p.write_1h : (r.cache_create ?? 0) * p.write_5m)) / 1e6;
}
export const fmtUsd = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`);
// token sums that cost() prices exactly; use with `group by model, speed`
const SUMS = (t = '') => `sum(${t}in_tok) in_tok, sum(${t}out_tok) out_tok, sum(${t}cache_read) cache_read, sum(coalesce(${t}cache_1h, 0)) cache_1h,
  sum(iif(${t}cache_1h is null and ${t}cache_5m is null, ${t}cache_create, ${t}cache_5m)) cache_5m, count(*) n`;
// Spend of the requests matching `where`: dollars over priced models; requests on unpriced models are counted, never summed.
export function spendOf(where: string, ...a: any[]) {
  const rc = settings().rate_card ?? {};
  let usd = 0, unpriced = 0, n = 0;
  for (const r of all(`select model, speed, ${SUMS()} from requests where ${where} group by 1, 2`, ...a)) { const c = cost(r, rc); n += r.n; if (c == null) unpriced += r.n; else usd += c; }
  return { usd, unpriced, n };
}
const ctx = (r: any) => (r.cache_create != null ? (r.in_tok ?? 0) + (r.cache_read ?? 0) + r.cache_create : r.context_est);

// ---- limits as the unit (docs/COST-INSIGHTS.md "Limits as the unit") ----
// On a subscription the scarce thing is the 5-hour and weekly window. Every response carries the account's utilization, so the exchange
// rate is measured from the router's own traffic: per account and window, over the last 14 days, the account's requests are grouped by
// the window's reset value; in a group usd = cost() of every request after the first reading, moved = last - first utilization in
// percentage points. usd_per_pct = sum(usd) / sum(moved) over the groups that moved at least 3 points on more than $0.
// confidence 'ok' needs $20 and 10 points; it is 'low' below that, and when the latest window moved more than 3x as far per dollar as
// the account's own median (the account is being used somewhere the router does not see).
// ponytail: recomputed (one indexed scan of 14 days, JSON read by SQLite) whenever a request was logged since the last call; keep
// running sums per account and reset if that scan ever shows up in a profile.
const WINS = ['5h', '7d'] as const;
let limMemo: { key: string; by: Map<string, any> } | null = null;
export function limits(): Map<string, any> {
  const rc = settings().rate_card ?? {}, key = `${one('select max(id) m from requests').m}|${JSON.stringify(rc)}`;
  if (limMemo?.key === key) return limMemo.by;
  const g = (k: string) => `json_extract(ratelimit_json, '$."${RL}${k}"')`, acc = new Map<string, any>();
  for (const r of all(`select account_id a, model, speed, in_tok, out_tok, cache_read, cache_create, cache_1h, cache_5m,
      ${g('5h-reset')} r5h, ${g('5h-utilization')} u5h, ${g('7d-reset')} r7d, ${g('7d-utilization')} u7d
    from requests where ts >= ? and ratelimit_json like '%utilization%' order by ts, id`, now() - 14 * 864e5)) {
    const usd = cost(r, rc) ?? 0, a = acc.get(r.a) ?? { requests: 0, '5h': new Map(), '7d': new Map() };
    acc.set(r.a, a); a.requests++;
    for (const w of WINS) {
      const reset = r[`r${w}`], u = Number(r[`u${w}`]), x = a[w].get(reset);
      if (reset == null || r[`u${w}`] == null) continue;
      if (x) { x.usd += usd; x.last = u; } else a[w].set(reset, { reset: Number(reset), usd: 0, first: u, last: u });
    }
  }
  const est = (groups: Map<any, any>) => {
    const gs = [...groups.values()].map((x) => ({ ...x, moved: Math.round((x.last - x.first) * 1e4) / 100 })).sort((x, y) => y.reset - x.reset);
    const q = gs.filter((x) => x.moved >= 3 && x.usd > 0), usd = sum(q, (x) => x.usd), moved = sum(q, (x) => x.moved);
    if (!q.length) return null;
    const per = q.map((x) => x.moved / x.usd).sort((x, y) => x - y), med = (per[(per.length - 1) >> 1] + per[per.length >> 1]) / 2;
    const outside = gs[0].moved >= 3 && gs[0].moved / Math.max(gs[0].usd, 1e-9) > 3 * med, thin = usd < 20 || moved < 10;
    return { usd_per_pct: usd / moved, usd, moved, windows: q.length, confidence: outside || thin ? 'low' : 'ok',
      reason: outside ? 'used outside the router' : thin ? 'not enough traffic through the router yet' : null };
  };
  const by = new Map<string, any>();
  for (const [id, a] of acc) { const e = { requests: a.requests, '5h': est(a['5h']), '7d': est(a['7d']) };
    by.set(id, { ...e, confidence: WINS.every((w) => e[w]?.confidence === 'ok') ? 'ok' : 'low', reason: e['5h']?.reason ?? e['7d']?.reason ?? (e['5h'] && e['7d'] ? null : 'not enough traffic through the router yet') }); }
  limMemo = { key, by };
  return by;
}
// What `usd` at list price is in percentage points of that account's windows; null until the estimator has a value for the account.
export function asLimits(usd: number | null | undefined, account_id: string | null | undefined): { pct_5h: number | null; pct_7d: number | null; confidence: 'ok' | 'low' } | null {
  const e = usd == null || account_id == null ? null : limits().get(account_id);
  if (!e || (!e['5h'] && !e['7d'])) return null;
  return { pct_5h: e['5h'] ? usd! / e['5h'].usd_per_pct : null, pct_7d: e['7d'] ? usd! / e['7d'].usd_per_pct : null, confidence: e.confidence };
}
export const fmtPct = (x: number) => (x < 0.1 ? '<0.1%' : `${x < 10 ? x.toFixed(1) : Math.round(x)}%`);
// The phrase that follows a dollar figure: "≈ 1.2% of your 5-hour window · 0.3% of your week", "(rough)" when low confidence, '' when unknown.
export function limText(usd: number | null | undefined, account_id: string | null | undefined) {
  const l = usd ? asLimits(usd, account_id) : null;
  return !l ? '' : `≈ ${[l.pct_5h != null && `${fmtPct(l.pct_5h)} of your 5-hour window`, l.pct_7d != null && `${fmtPct(l.pct_7d)} of your week`].filter(Boolean).join(' · ')}${l.confidence === 'low' ? ' (rough)' : ''}`;
}
// the account that paid most of `rows` (a figure spanning accounts is converted at that account's rate)
const payer = (rows: any[], f: (r: any) => number = (r) => r.usd) => {
  const m = new Map<string, number>();
  for (const r of rows) if (r.account_id) m.set(r.account_id, (m.get(r.account_id) ?? 0) + (f(r) || 0));
  return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};
// GET /router/limits
function limitsView() {
  const L = limits();
  return all(`select id, last_ratelimit_json j from accounts order by kind = 'home' desc, id`).map((a) => { const e = L.get(a.id), w = (k: '5h' | '7d') => e?.[k]?.usd_per_pct ?? null;
    return { account: a.id, usd_per_pct_5h: w('5h'), usd_per_pct_7d: w('7d'), window_usd_5h: w('5h') && w('5h') * 100, window_usd_7d: w('7d') && w('7d') * 100,
      basis: { requests: e?.requests ?? 0, ...Object.fromEntries(WINS.flatMap((k) => [[`windows_${k}`, e?.[k]?.windows ?? 0], [`usd_${k}`, e?.[k]?.usd ?? 0], [`moved_${k}`, e?.[k]?.moved ?? 0]])) },
      confidence: e && (e['5h'] || e['7d']) ? e.confidence : null, reason: e ? e.reason : 'not enough traffic through the router yet',
      util_5h: util(a.j, '5h'), util_7d: util(a.j, '7d'), reset_5h: util(a.j, '5h', 'reset'), reset_7d: util(a.j, '7d', 'reset') }; });
}

// ---- A1: why a turn re-wrote its prefix. kind -> [avoidable, the one-line fix]. The cache key per the Claude Code prompt-caching doc:
// model, effort (some models), fast mode, the loaded tool set, the system prompt, images; compaction and clearing rebuild by design.
const CAUSES: Record<string, [boolean, string | null]> = {
  account: [false, 'Expected: the prompt cache is per account. Keep the session where it is (Sessions → route to), or raise proactive_switch_pct.'],
  model: [true, 'Pick the model before the first message (`claude --model …`, or `/model` in a fresh session). For cheaper side work use a subagent with `model:` instead of switching.'],
  fast: [true, 'Turn fast mode on at the start of a session (`/fast`), not in the middle of one.'],
  effort: [true, 'Set effort once at the start (`/effort`, or `effortLevel` in settings.json): on this model a change re-writes the conversation.'],
  tools: [true, 'Keep the loaded tool set fixed for the session: connect or disconnect MCP servers between sessions, and set `ENABLE_TOOL_SEARCH=true` so MCP tools are deferred instead of loaded.'],
  system: [false, 'Something that is part of the system prompt changed (output style, `--append-system-prompt`, a plugin or skill listing). Change those between sessions.'],
  images: [false, 'Expected: images that leave the context change the prefix after them.'],
  rebuild: [false, null],
  expired: [false, 'Reply before the lifetime ends (the going-cold notification warns ahead), or `/clear` first when the old context is no longer needed.'],
  cli: [false, 'Expected once after a CLI upgrade.'],
  unexplained: [false, null],
};
// The one list of models on which a change of effort keeps the cache (Claude Code prompt-caching doc); on every other model it re-writes.
const EFFORT_KEEPS_CACHE = ['opus-5-5', 'sonnet-5-5', 'fable-5-1'];
const short = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
// lifetime of the cache a turn wrote: from its usage split; a turn that wrote nothing counts as 1h on the main thread, 5m in a subagent
const ttlOf = (r: any) => ((r.cache_1h || r.cache_5m ? (r.cache_1h ?? 0) >= (r.cache_5m ?? 0) : !r.agent_id) ? 3600_000 : 300_000);
// p = the previous request of the same thread. First match wins.
function why(p: any, r: any): [string, string] {
  const n = (x: any) => x.tools_loaded ?? x.tools_count, ttl = ttlOf(r), less = (k: string) => p[k] != null && r[k] != null && r[k] < p[k];
  if (r.switched) return ['account', 'account switch'];
  if (p.model && r.model && p.model !== r.model) return ['model', `model changed (${short(p.model)} → ${short(r.model)})`];
  if (r.speed === 'fast' && p.speed !== 'fast') return ['fast', 'fast mode turned on'];
  if (p.effort && r.effort && p.effort !== r.effort && !EFFORT_KEEPS_CACHE.some((m) => r.model?.includes(m))) return ['effort', `effort changed (${p.effort} → ${r.effort})`];
  // compared within one fingerprint generation only: before tools_loaded existed the hash also covered deferred definitions
  if (p.tools_hash && r.tools_hash && p.tools_hash !== r.tools_hash && (p.tools_loaded == null) === (r.tools_loaded == null)) return ['tools', `tool set changed (${n(p)} → ${n(r)} loaded tools)`];
  if (p.system_hash && r.system_hash && p.system_hash !== r.system_hash) return ['system', 'system prompt changed'];
  if (less('image_count')) return ['images', `images removed (${p.image_count} → ${r.image_count})`];
  if (less('msg_count')) return ['rebuild', 'compaction or tool-result clearing (expected rebuild)'];
  if (r.ts - p.ts > ttl) return ['expired', `cache lifetime expired (${ttl === 3600_000 ? '1h' : '5m'} cache, idle ${Math.round((r.ts - p.ts) / 60_000)} min)`];
  // the request got smaller while the message count did not drop: the client cleared tool results or thinking out of the history
  if (less('context_est')) return ['rebuild', 'compaction or tool-result clearing (expected rebuild)'];
  if (p.cli_version && r.cli_version && p.cli_version !== r.cli_version) return ['cli', `CLI upgraded (${p.cli_version} → ${r.cli_version})`];
  return ['unexplained', 'unexplained'];
}

// /v1/messages rows (2xx/3xx) since `since`, each annotated with `i` (turn in session), `usd`, `gap` and `prev_ctx` (time since, and
// context of, the previous request of its thread), `switched`, and `burst`.
// The router's own advisor/brain calls (requests.source) are not turns of anyone's session and are left out.
function turns(since: number, session?: string | null) {
  const rc = settings().rate_card ?? {};
  const rows = all(`select r.id, r.ts, r.request_id, r.session_key, r.account_id, r.model, r.latency_ms, r.status, r.agent_id, r.tools_hash, r.tools_count,
      r.system_hash, r.first_user_hash, r.msg_count, r.context_est, r.cache_read, r.cache_create, r.in_tok, r.out_tok, r.cache_1h, r.cache_5m,
      r.tools_loaded, r.tools_tok, r.effort, r.speed, r.image_count, r.cli_version,
      exists (select 1 from migrations m where r.request_id is not null and m.request_id = r.request_id) migrated
    from requests r where ${MSG()} and status < 400 and session_key is not null and source is null and ts >= ? ${session ? 'and session_key = ?' : ''} order by ts`,
    ...(session ? [since, session] : [since]));
  const by = new Map<string, any[]>();
  for (const r of rows) { const k = r.session_key ?? '-'; if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
  for (const rs of by.values()) {
    // "previous request" = previous one in the same thread: a session also carries subagent and side-request threads,
    // each with its own first user message and prefix. Old rows without fingerprints fall back to model.
    const last = new Map<string, any>();
    rs.forEach((r, i) => {
      r.i = i + 1; r.usd = cost(r, rc);
      const k = r.first_user_hash ?? r.model, p = last.get(k);
      last.set(k, r);
      r.gap = p ? r.ts - p.ts : null; r.prev_ctx = p ? ctx(p) ?? null : null;
      r.switched = !!(r.migrated || (p && p.account_id !== r.account_id));
      if (r.cache_create == null || r.cache_create <= 8_000) return;
      // a thread's first turn is a cold start: labelled on the turn, never counted as a burst
      if (!p) return void (r.cold = { kind: 'first', cause: 'first turn, cold cache', avoidable: false, delta: r.cache_create, usd: null, fix: null, gap_s: null });
      // burst = wrote well over what this turn added, so old context was re-written. ctx(): joined usage, else the byte estimate
      if (r.cache_create <= 2 * Math.max(0, ctx(r) - (ctx(p) ?? 0))) return;
      const [kind, cause] = why(p, r), w = rates(r.model, rc), ttl = ttlOf(r) === 3600_000 ? '1h' : '5m';
      // what the re-write cost: its tokens at this model's write price for the lifetime it used
      const usd = !w ? null : (r.cache_1h != null || r.cache_5m != null ? (r.cache_5m ?? 0) * w.write_5m + (r.cache_1h ?? 0) * w.write_1h
        : r.cache_create * (ttl === '1h' ? w.write_1h : w.write_5m)) / 1e6;
      const fix = kind === 'expired' && ttl === '5m' ? 'This thread is on the 5-minute lifetime. Cost → cache lifetime fit shows whether `subagentPromptCacheTtl` (or `promptCacheTtl`) set to `1h` would pay off.' : CAUSES[kind][1];
      r.burst = { kind, cause, avoidable: CAUSES[kind][0], delta: r.cache_create, usd, fix, gap_s: Math.round((r.ts - p.ts) / 1000), ttl };
    });
  }
  return rows;
}

// Tokens a full 5h window holds for this account, extrapolated from what the ledger saw in the current window.
// ponytail: naive (weighted tokens / utilization); null until the account is >2% into a window with joined rows.
function cap5h(accountId: string) {
  const a = one('select last_ratelimit_json j from accounts where id = ?', accountId);
  const u = util(a?.j, '5h'), reset = util(a?.j, '5h', 'reset');
  if (!u || u < 0.02 || !reset) return null;
  const used = sum(all(`select in_tok, out_tok, cache_read, cache_create from requests where account_id = ? and ts >= ? and cache_create is not null`,
    accountId, reset * 1000 - 5 * 3600_000), W);
  return used > 0 ? used / u : null;
}

const hitRate = (j: any[]) => {
  const d = sum(j, (r) => r.cache_read + r.cache_create + r.in_tok);
  return d ? sum(j, (r) => r.cache_read) / d : null;
};

function overview(accounts: any[]) {
  const t0 = today(), now = Date.now();
  const rows = turns(t0), j = rows.filter((r) => r.cache_create != null);
  const sw = all('select reason from migrations where ts >= ?', t0);
  const live = all(`select r.ts, r.account_id, r.session_key, r.model, r.status, r.latency_ms, r.cache_read, r.cache_create,
      (select json_object('from', m.from_account, 'to', m.to_account, 'reason', m.reason) from migrations m where m.session_key = r.session_key
        and (m.request_id = r.request_id or (m.request_id is null and m.ts <= r.ts and m.ts > coalesce(
          (select max(p.ts) from requests p where p.session_key = r.session_key and p.ts < r.ts and ${MSG('p.')}), 0)))
        order by m.ts desc limit 1) migration
    from requests r where ${MSG('r.')} order by r.ts desc limit 30`);
  const ok = accounts.filter((a) => a.status === 'ok' || a.status === 'unknown');
  const resets = accounts.map((a) => a.reset_5h * 1000 - now).filter((x) => x > 0);
  return {
    requests_today: one(`select count(*) n from requests where ${MSG()} and ts >= ?`, t0).n,
    sources: Object.fromEntries(all(`select ua_kind k, count(distinct session_key) n from requests where ${MSG()} and ts >= ? and ua_kind is not null group by 1`, t0).map((r) => [r.k, r.n])),
    live_sessions: one('select count(*) n from sessions where last_ts >= ?', now - 3600_000).n,
    cache_hit_rate: hitRate(j),
    per_turn: { cache_read_avg: j.length ? Math.round(sum(j, (r) => r.cache_read) / j.length) : null, cache_create_avg: j.length ? Math.round(sum(j, (r) => r.cache_create) / j.length) : null },
    switches: {
      manual: sw.filter((m) => m.reason === 'manual').length,
      ratelimited: sw.filter((m) => /^(429|529)/.test(m.reason ?? '')).length,
      forced: sw.filter((m) => m.reason !== 'manual' && !/^(429|529)/.test(m.reason ?? '')).length,
    },
    headroom_5h_pct: ok.length ? sum(ok, (a) => 1 - (a.util_5h ?? 0)) : null,
    reset_in_s: resets.length ? Math.round(Math.min(...resets) / 1000) : null,
    accounts, budgets: budgets().map(({ name, pct, state }) => ({ name, pct, state })),
    live: live.map((r) => ({ ts: r.ts, account: r.account_id, session_key: r.session_key, model: r.model, status: r.status, latency_ms: r.latency_ms,
      cache: r.cache_create == null ? '—' : r.cache_create > r.cache_read ? 'write' : 'hit', cache_create: r.cache_create,
      migration: r.migration ? JSON.parse(r.migration) : null })),
  };
}

const parse = (a: any) => a && { ...a, breakdown: JSON.parse(a.breakdown_json ?? 'null'), breakdown_json: undefined };
export const advice = (sk?: string) => (sk ? all('select * from advice where session_key = ? order by id desc', sk)
  : all(`select a.*, s.title from advice a left join sessions s using (session_key) where a.id in (select max(id) from advice where level != 'handoff' group by session_key) order by a.id desc`)).map(parse);

// A2: where each session's main-thread cache stands, from its last main turn since `since`. Main thread = no subagent id and a tool
// list (the desktop's side requests send none). cold_at = that turn (or the last keep-warm ping that got a 2xx after it) + the lifetime of
// the session's last cache write; rebuild_usd = the cached context at the model's write price for that lifetime; read_usd = the same
// context read from a warm cache (what a message, or a ping, costs). thread = the key router.ts keeps that conversation's last request under.
export function warmth(since: number) {
  const main = `x.agent_id is null and x.tools_count > 0 and x.cache_create is not null and x.status < 400 and x.source is null and ${MSG('x.')}`, rc = settings().rate_card ?? {};
  return all(`select r.session_key sk, r.ts, r.model, r.first_user_hash fuh, r.in_tok + r.cache_read + r.cache_create ctx,
      (select x.cache_1h > 0 from requests x where x.session_key = r.session_key and ${main} and coalesce(x.cache_1h, 0) + coalesce(x.cache_5m, 0) > 0 order by x.ts desc limit 1) h1,
      (select max(p.ts) from requests p where p.session_key = r.session_key and p.source = 'warm' and p.status < 300 and p.ts > r.ts) wts
    from requests r where r.id in (select max(x.id) from requests x where ${main} and x.session_key is not null and x.ts >= ? group by x.session_key)`, since).map((r) => {
    const p = rates(r.model, rc), ttl_1h = r.h1 === 1;
    return { sk: r.sk as string, ts: r.ts as number, ctx: r.ctx as number, ttl_1h, model: r.model as string | null, thread: `${r.sk}\0${r.fuh ?? r.model}`,
      cold_at: r.h1 == null ? null : Math.max(r.ts, r.wts ?? 0) + (ttl_1h ? 3600_000 : 300_000),
      rebuild_usd: p && r.h1 != null ? r.ctx * (ttl_1h ? p.write_1h : p.write_5m) / 1e6 : null, read_usd: p ? r.ctx * p.read / 1e6 : null };
  });
}

function sessions() {
  const st = settings(), warm = new Map(warmth(now() - 864e5).map((w) => [w.sk, w]));
  return all(`select s.*, (select coalesce(r.in_tok + r.cache_read + r.cache_create, r.context_est) from requests r
        where r.session_key = s.session_key and r.context_est is not null order by r.ts desc limit 1) context_est,
      (select actual_cost_tokens from migrations m where m.session_key = s.session_key and actual_cost_tokens is not null order by ts desc limit 1) last_switch_cost_actual,
      (select ua_kind from requests r where r.session_key = s.session_key and ua_kind is not null order by r.ts desc limit 1) source
    from sessions s where account_id is not null and not exists (select 1 from requests r where r.session_key = s.session_key and r.source is not null and r.source != 'warm')
    order by last_ts desc limit 100`) // transcript-only rows (a title, never routed) have no pin; source = the router's own advisor/brain calls ('warm' = a ping for a real session)
    .map((s) => {
      // context meter: the main thread's last joined turn (the context that auto-compacts), same basis as the advisor
      const m = one(`select in_tok + cache_read + cache_create ctx, model from requests where session_key = ? and agent_id is null
        and cache_create is not null order by ts desc limit 1`, s.session_key);
      return { ...s, title: s.title ?? s.session_key.slice(0, 8), project: s.cwd?.split('/').pop() ?? null,
      switch_cost_est: s.context_est == null ? null : Math.round(s.context_est * 1.25),
      context_main: m?.ctx ?? null, context_pct: m ? m.ctx / windowOf(m.model, m.ctx) : null, warn_pct: st.context_warn_pct, urgent_pct: st.context_urgent_pct,
      cold_at: warm.get(s.session_key)?.cold_at ?? null, rebuild_usd: warm.get(s.session_key)?.rebuild_usd ?? null,
      rebuild_limits: limText(warm.get(s.session_key)?.rebuild_usd, s.account_id), warm: st.warm_enabled && warm.has(s.session_key) ? warmPlan(warm.get(s.session_key)!, st) : null,
      advice: parse(one(`select * from advice where session_key = ? and level != 'handoff' order by id desc limit 1`, s.session_key)),
      handoff: one(`select text, ts from advice where session_key = ? and level = 'handoff' order by id desc limit 1`, s.session_key) ?? null,
      agents: all(`select a.agent_id, coalesce(a.name, a.agent_id) name, count(r.id) requests, sum(r.cache_read) cache_read, sum(r.cache_create) cache_create, a.last_ts
        from agents a left join requests r on r.agent_id = a.agent_id where a.session_key = ? group by a.agent_id order by a.first_ts`, s.session_key) };
    });
}

// ---- keep warm (docs/COST-INSIGHTS.md "Keep-warm scheduler") ----
// router.ts holds the kept requests in memory; this module only ever learns which threads it has, never a request.
export const warmMem = { has: (_thread: string) => false, stats: () => ({ entries: 0, bytes: 0 }) };
export const BY_USER = 'stopped by you';
const RESUME = 'warming resumes when the session next sends a request';
// End (epoch ms) of a rule's local-time window if `t` is inside it, else null. from > to is a window across midnight; `days` name the
// weekday the window starts on.
export function ruleEnd(r: any, t: number): number | null {
  const d = new Date(t), m = d.getHours() * 60 + d.getMinutes(), [f, e] = [r.from, r.to].map((x: string) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3)));
  const at = (plus: number) => { const x = new Date(t); x.setDate(x.getDate() + plus); return x.setHours(0, e, 0, 0); };
  if (f <= e) return r.days.includes(d.getDay()) && m >= f && m < e ? at(0) : null;
  return m >= f && r.days.includes(d.getDay()) ? at(1) : m < e && r.days.includes((d.getDay() + 6) % 7) ? at(0) : null;
}
// What the scheduler does with one session right now: a function of the ledger, the settings and what the router holds, so the tick,
// the Sessions row and GET /router/warm all read the same answer. by = what covers the session (a one-off, a rule, "after you stop");
// until = when that cover ends (never past warm_max_hours after the session's last request); stop = why no ping is being sent
// (null = it is pinged); next = when the next ping is due; pings / usd = pings sent since the session's last real request.
export function warmPlan(w: ReturnType<typeof warmth>[number], st = settings(), t = now()) {
  const row = one('select * from warm_sessions where session_key = ?', w.sk), s = one('select account_id a, cwd from sessions where session_key = ?', w.sk);
  const a = s?.a ? one('select * from accounts where id = ?', s.a) : null, proj = s?.cwd?.split('/').pop() ?? null, h = 3600_000;
  const p = one(`select count(*) n, (select status from requests where session_key = ?1 and source = 'warm' and ts > ?2 order by id desc limit 1) last
    from requests where session_key = ?1 and source = 'warm' and ts > ?2`, w.sk, w.ts);
  const blocked = row?.reason === BY_USER && row.created_ts >= w.ts, big = (w.rebuild_usd ?? 0) >= st.warm_min_usd;
  const rule = big ? (st.warm_rules as any[]).map((r) => ({ name: r.name, end: r.scope === 'all' || r.match === proj ? ruleEnd(r, t) : null })).find((x) => x.end) : null;
  const [by, end] = blocked ? [null, null] : row?.until_ts > t ? ['one-off', row.until_ts as number] : rule ? [`rule ‘${rule.name}’`, rule.end!]
    : big && t < w.ts + st.warm_after_stop_hours * h ? ['after you stop', w.ts + st.warm_after_stop_hours * h] : [null, null];
  const cap = w.ts + Math.min(24, st.warm_max_hours) * h, until = by ? Math.min(end!, cap) : null;
  const ttl = w.ttl_1h ? h : 300_000, lead = Math.min(st.warm_lead_min * 60_000, ttl / 2);
  const u = (['5h', '7d'] as const).map((k) => ({ k, v: util(a?.last_ratelimit_json, k) ?? 0 })).sort((x, y) => y.v - x.v)[0];
  const stop = blocked ? BY_USER
    : !by ? (p.n || row?.until_ts > w.ts ? 'the keep-warm duration or rule window ended' : null)
    : p.last >= 300 ? `${p.last === 401 && a?.kind === 'home' ? 'the desktop app’s login expired' : `a ping failed (HTTP ${p.last})`}; ${RESUME}`
    : t >= cap ? `it was kept warm for the maximum of ${st.warm_max_hours} h after its last request`
    : !w.ttl_1h && !st.warm_allow_5m ? 'it is on the 5-minute cache lifetime, where a ping never pays back'
    : w.cold_at == null || w.cold_at <= t ? `its cache is already cold; ${RESUME}`
    : !warmMem.has(w.thread) ? `its last request is not in memory (router restart or eviction); ${RESUME}`
    : !a || a.disabled || a.needs_login || a.cooling_until > Date.now() ? `account ${s?.a ?? '—'} is ${!a ? 'removed' : a.disabled ? 'disabled' : a.needs_login ? 'waiting for a login' : 'cooling'}`
    : u.v >= st.warn_pct ? `${s.a} is at ${Math.round(u.v * 100)}% of its ${u.k === '5h' ? '5-hour' : 'weekly'} window (warn threshold ${Math.round(st.warn_pct * 100)}%)`
    : spendOf(`source = 'warm' and ts >= ?`, new Date(t).setHours(0, 0, 0, 0)).usd >= st.warm_daily_usd ? `today’s keep-warm budget of ${fmtUsd(st.warm_daily_usd)} is spent`
    : null;
  return { by, until, stop, next: by && !stop && w.cold_at! - lead < until! ? Math.max(t, w.cold_at! - lead) : null, pings: p.n as number,
    usd: p.n ? spendOf(`session_key = ? and source = 'warm' and ts > ?`, w.sk, w.ts).usd : 0, account: (s?.a ?? null) as string | null };
}
// GET /router/sessions/:key/warm?hours= — what keeping this session warm would cost, shown before it is switched on. A ping is one
// cache read of the context; pings come every (lifetime - lead); the break-even is how many pings one rebuild pays for.
export function warmQuote(sk: string, hours: number, st = settings(), t = now()) {
  const w = warmth(t - 25 * 3600_000).find((x) => x.sk === sk);
  if (!w || w.cold_at == null || !w.read_usd || !w.rebuild_usd) return null;
  const account = one('select account_id a from sessions where session_key = ?', sk)?.a ?? null, hrs = Math.min(hours > 0 ? hours : st.warm_max_hours, st.warm_max_hours, 24);
  const ttl = w.ttl_1h ? 3600_000 : 300_000, lead = Math.min(st.warm_lead_min * 60_000, ttl / 2), step = ttl - lead, until = t + hrs * 3600_000, first = Math.max(t, w.cold_at - lead);
  const pings = until > first ? Math.ceil((until - first) / step) : 0, n = w.rebuild_usd / w.read_usd, L = (x: number) => limText(x, account), line = (x: number) => `${fmtUsd(x)}${L(x) ? ` (${L(x)})` : ''}`;
  return { session_key: sk, title: title(sk), account, hours: hrs, until_ts: until, context: w.ctx, lifetime: w.ttl_1h ? '1h' : '5m', ping_usd: w.read_usd, rebuild_usd: w.rebuild_usd, pings, total_usd: pings * w.read_usd,
    ping_limits: L(w.read_usd), rebuild_limits: L(w.rebuild_usd), total_limits: L(pings * w.read_usd), breakeven_pings: n, breakeven_hours: n * step / 3600_000,
    text: [`Keep ‘${title(sk)}’ warm for ${hrs} h?`, '', `One ping (a cache read of ${kt(w.ctx)} tokens): ${line(w.read_usd)}`, `A rebuild once it has gone cold: ${line(w.rebuild_usd)}`,
      `Pings needed: ${pings} — ${line(pings * w.read_usd)} in total`, `Break-even: a rebuild costs as much as ${Math.round(n)} pings ≈ ${Math.round(n * step / 3600_000)} hours of keeping it warm.`,
      ...(w.ttl_1h ? [] : ['This session is on the 5-minute cache lifetime: it is not pinged.']), '', 'Pings are requests the router sends on its own with your login; they count toward your limits.'].join('\n') };
}
// GET /router/warm
function warmView() {
  const st = settings(), t = now();
  return { enabled: st.warm_enabled as boolean, settings: Object.fromEntries(Object.entries(st).filter(([k]) => k.startsWith('warm_'))),
    spent_today_usd: spendOf(`source = 'warm' and ts >= ?`, new Date(t).setHours(0, 0, 0, 0)).usd, memory: warmMem.stats(),
    sessions: !st.warm_enabled ? [] : warmth(t - 25 * 3600_000).map((w) => ({ session_key: w.sk, title: title(w.sk), cold_at: w.cold_at, ping_usd: w.read_usd, rebuild_usd: w.rebuild_usd, ...warmPlan(w, st, t) })).filter((x) => x.by || x.stop),
    pings: all(`select ts, session_key, account_id, model, speed, status, in_tok, out_tok, cache_read, cache_create, cache_1h, cache_5m from requests where source = 'warm' order by id desc limit 20`)
      .map((r) => ({ ts: r.ts, session_key: r.session_key, title: title(r.session_key), account: r.account_id, status: r.status, cache_read: r.cache_read, cache_create: r.cache_create, usd: cost(r) })) };
}

// ---- tool loading advisor (docs/COST-INSIGHTS.md "Tool loading advisor") ----
// An MCP tool is named mcp__<server>__<tool>; '' = the client's built-in tools (listed for information, not configurable).
export const serverOf = (name: string) => /^mcp__(.+?)__/.exec(name)?.[1] ?? '';
const tilde = (p: string) => (p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);
// Where a server is defined, in the files the user owns: ~/.claude.json (local scope under projects[cwd], user scope at the top) and the
// project's .mcp.json, in Claude Code's order of precedence. Only the names under `mcpServers` are read: never a command, an env value
// or a header. Tool names carry the server name with everything outside [A-Za-z0-9_-] turned into '_'.
function mcpOwned(cwds: string[]) {
  const out = new Map<string, { name: string; file: string; at: string; scope: string }>(), f = `${claudeHome()}.json`;
  const add = (file: string, scope: string, at: (n: string) => string, servers: any) => { for (const n of Object.keys(servers && typeof servers === 'object' ? servers : {})) {
    const k = n.replace(/[^a-zA-Z0-9_-]/g, '_'); if (!out.has(k)) out.set(k, { name: n, file: tilde(file), at: at(n), scope }); } };
  const read = (file: string) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } }, j = read(f);
  for (const c of cwds) add(f, 'local', (n) => `projects["${c}"].mcpServers["${n}"]`, j.projects?.[c]?.mcpServers);
  for (const c of cwds) add(`${c}/.mcp.json`, 'project', (n) => `mcpServers["${n}"]`, read(`${c}/.mcp.json`).mcpServers);
  add(f, 'user', (n) => `mcpServers["${n}"]`, j.mcpServers);
  return out;
}
const TOOL_LABEL: Record<string, string> = { always_load: 'Always load', leave_deferred: 'Leave deferred', disable: 'Disable', loaded: 'Loaded upfront', builtin: 'Built-in' };
// GET /router/tools?days=30&project= — per server, in one project or overall (window: `days`):
//   always load     called in at least half of the scope's sessions (4 or more) and deferred now, and the search round trips that would be
//                   avoided cost more than carrying its definitions: benefit = ToolSearch calls that led to a call of the server's tools ×
//                   that session's average per-request cache-read cost; cost = its definition tokens × the scope's turns × the read price
//   disable         not called in the window (a deferred server still costs its tool names in every request, a loaded one its definitions:
//                   dollars = definition tokens × the turns of the sessions whose recorded tool list had it loaded × the read price)
//   leave deferred  everything else that is deferred; loaded = loaded upfront and used
// and for the scope: tool search off, when its newest tool list has no tool-search tool (the ENABLE_TOOL_SEARCH fix).
// "Now" = the newest tool list recorded for a main conversation in the scope (requests.tool_servers_json, kept from this version on).
// ponytail: a ToolSearch call is credited to the first MCP call that follows it in the same thread within 5 requests (the ledger has no
// user-turn boundaries and never sees the query); read the search query from the transcript if that ever credits the wrong server.
export function toolsView(q: URLSearchParams) {
  const days = Math.max(1, Number(q.get('days')) || 30), since = now() - days * 864e5, pq = q.get('project'), project = pq && pq !== 'all' ? pq : null, rc = settings().rate_card ?? {};
  const cwd = new Map<string, string | null>(all('select session_key k, cwd from sessions').map((x) => [x.k, x.cwd]));
  const projOf = (sk: string) => cwd.get(sk)?.split('/').pop() ?? null, inScope = (sk: string) => !project || projOf(sk) === project;
  const every = turns(since), rows = every.filter((r) => inScope(r.session_key)), turnOf = new Map(rows.map((r) => [r.id, r])), sess = new Map<string, { n: number; read: number; tok: number }>();
  let perTok = 0; // dollars one definition token costs when every turn of the scope re-reads it (per session: tok)
  for (const r of rows) { const p = (rates(r.model, rc)?.read ?? 0) / 1e6, x = sess.get(r.session_key) ?? { n: 0, read: 0, tok: 0 }; perTok += p; x.n++; x.tok += p; x.read += (r.cache_read ?? 0) * p; sess.set(r.session_key, x); }
  const S = new Map<string, any>(), T = new Map<string, any>();
  const srv = (k: string) => S.get(k) ?? S.set(k, { server: k, calls: 0, sessions: new Set<string>(), projects: new Set<string>(), last_used: null, searches: 0, benefit_usd: 0, loaded: null, deferred: null, def_tokens: null }).get(k);
  const states = new Map<string, any>(); // session -> its newest recorded tool list; the newest of all is "now"
  let state: any = null;
  for (const r of all(`select session_key sk, tools_hash h, tool_servers_json j from requests where tool_servers_json is not null and ts >= ? and source is null and agent_id is null order by ts desc`, since))
    if (inScope(r.sk) && !states.has(r.sk)) { states.set(r.sk, JSON.parse(r.j)); state ??= r; }
  for (const [k, v] of Object.entries(state ? states.get(state.sk) : {})) Object.assign(srv(k), v);
  const names = state && one('select tool_names_json j from requests where tools_hash = ? and tool_names_json is not null', state.h)?.j, searchOff = names ? !/tool.?search/i.test(names) : false;
  const pend = new Map<string, number[]>(), searched = new Set<string>();
  let searches = 0;
  for (const c of all(`select t.name, r.id, r.session_key sk, r.ts, r.agent_id ag from tool_uses t join requests r on r.request_id = t.request_id where r.ts >= ? order by r.ts, r.id`, since)) {
    const r = turnOf.get(c.id), k = serverOf(c.name), th = `${c.sk}\0${c.ag ?? ''}`;
    if (!r) continue; // another project, or not a counted turn
    for (const x of [srv(k), T.get(c.name) ?? T.set(c.name, { name: c.name, server: k, calls: 0, sessions: new Set<string>(), last_used: null }).get(c.name)]) { x.calls++; x.sessions.add(c.sk); x.last_used = c.ts; }
    if (projOf(c.sk)) srv(k).projects.add(projOf(c.sk));
    if (c.name === 'ToolSearch') { searches++; searched.add(c.sk); pend.set(th, [...(pend.get(th) ?? []), r.i]); }
    else if (k && pend.get(th)?.length) { const n = pend.get(th)!.filter((i) => r.i - i <= 5).length, se = sess.get(c.sk)!; srv(k).searches += n; srv(k).benefit_usd += n * se.read / se.n; pend.set(th, []); }
  }
  const own = mcpOwned([...new Set(rows.map((r) => cwd.get(r.session_key)).filter(Boolean) as string[])]), n = sess.size, account = payer(rows);
  for (const k of own.keys()) srv(k); // defined in a file the user owns but never seen in a request or a call
  const servers = [...S.values()].map((x) => {
    const o = own.get(x.server), origin = !x.server ? 'builtin' : o ? o.scope : /^plugin_/.test(x.server) ? 'plugin' : /^claude_ai_|^[0-9a-f]{8}-[0-9a-f]{4}-/.test(x.server) ? 'connector' : 'app';
    const from = ({ plugin: 'a plugin', connector: 'a claude.ai connector', app: 'the app, or a config this router does not read' } as Record<string, string>)[origin], share = n ? x.sessions.size / n : 0;
    const cost_usd = x.def_tokens == null ? null : x.def_tokens * perTok, deferred = x.deferred > 0 && !x.loaded, often = n >= 4 && share >= 0.5;
    // what its definitions really cost: only the turns of sessions whose recorded tool list had it loaded (older sessions have no record: a floor)
    const held = [...states].filter(([sk, j]) => j[x.server]?.loaded > 0 && sess.has(sk)), held_usd = sum(held, ([sk, j]) => j[x.server].def_tokens * sess.get(sk)!.tok);
    const cls = !x.server ? 'builtin' : !x.calls ? 'disable' : deferred && !searchOff && often && x.benefit_usd > cost_usd! ? 'always_load' : x.loaded ? 'loaded' : 'leave_deferred';
    const usd = cls === 'always_load' ? x.benefit_usd - cost_usd! : cls === 'disable' ? held_usd : 0;
    const used = `called ${plural(x.calls, 'time')} in ${x.sessions.size} of ${plural(n, 'session')} (${Math.round(share * 100)}%)`, carry = `${kt(x.def_tokens ?? 0)} tokens of definitions × ${plural(rows.length, 'turn')} × the read price = ${fmtUsd(cost_usd)}`;
    const carried = `${kt(x.def_tokens ?? 0)} tokens of definitions × the ${plural(sum(held, ([sk]) => sess.get(sk)!.n), 'turn')} that carried them × the read price = ${fmtUsd(held_usd)}`;
    const trips = `${plural(x.searches, 'search round trip')} × the session's average prefix read = ${fmtUsd(x.benefit_usd)}`;
    return { server: x.server || '(built-in tools)', class: cls, label: TOOL_LABEL[cls], origin, loaded: x.loaded, deferred: x.deferred, def_tokens: x.def_tokens, calls: x.calls, sessions: x.sessions.size, share,
      projects: [...x.projects].sort(), last_used: x.last_used, searches: x.searches, benefit_usd: x.benefit_usd, cost_usd, usd, limits: limText(usd, account), where: o ? { file: o.file, at: o.at, scope: o.scope } : null,
      evidence: cls === 'always_load' ? [used, trips, carry]
        : cls === 'disable' ? [`not called in ${days} days`, x.loaded ? `loaded upfront: ${carried}` : x.deferred ? `deferred: it still costs its ${plural(x.deferred, 'tool name')} in the deferred list of every request` : 'its load state is recorded from the next request on']
        : cls === 'builtin' ? [used, `${x.loaded ?? '—'} loaded · ${x.deferred ?? '—'} deferred`, 'not configurable']
        : [used, ...(x.loaded == null ? ['its load state is recorded from the next request on'] : x.loaded ? [searchOff ? 'loaded upfront because tool search is off' : 'loaded upfront', carried]
          : [trips, carry, often ? 'the round trips cost less than carrying the definitions' : 'used in fewer than half of the sessions (or fewer than 4 sessions)'])],
      change: cls === 'always_load' ? (o ? `Add \`"alwaysLoad": true\` to ${o.at} in ${o.file} (applies from the next session).` : `Informational: this server comes from ${from}, where \`alwaysLoad\` cannot be set.`)
        : cls === 'disable' ? (o ? `\`claude mcp remove "${o.name}" -s ${o.scope}\` (defined in ${o.file}), or switch it off in \`/mcp\`.` : `Switch it off in \`/mcp\`: it comes from ${from}, so \`claude mcp remove\` does not apply.`) : null };
  }).sort((a, b) => Number(a.class === 'builtin') - Number(b.class === 'builtin') || b.usd - a.usd || b.calls - a.calls);
  return { days, project: project ?? 'all', projects: [...new Set(every.map((r) => projOf(r.session_key)).filter(Boolean))].sort(), sessions: n, turns: rows.length, account,
    tool_search: { on: names ? !searchOff : null, calls: searches, sessions: searched.size, class: searchOff ? 'tool_search_off' : null, fix: searchOff ? SEARCH_FIX : null }, servers,
    tools: [...T.values()].sort((a, b) => b.calls - a.calls).slice(0, 15).map((x) => ({ name: x.name, server: x.server || null, calls: x.calls, sessions: x.sessions.size, last_used: x.last_used })) };
}

function cache(q: URLSearchParams) {
  const days = Math.max(1, Number(q.get('days')) || 7), s = q.get('session');
  const session = s && s !== 'all' ? s : null;
  const rows = turns(Date.now() - days * 864e5, session), j = rows.filter((r) => r.cache_create != null);
  const bursts = rows.filter((r) => r.burst).map((r) => ({ i: r.i, ts: r.ts, session_key: r.session_key, account: r.account_id, ...r.burst, limits: limText(r.burst.usd, r.account_id) }));
  const avoid = bursts.filter((b) => b.avoidable), saved = sum(avoid, (b) => b.delta);
  const kinds = new Map<string, { kind: string; count: number; tokens: number; usd: number }>();
  for (const b of bursts) { const k = kinds.get(b.kind) ?? { kind: b.kind, count: 0, tokens: 0, usd: 0 }; k.count++; k.tokens += b.delta; k.usd += b.usd ?? 0; kinds.set(b.kind, k); }
  const cap = cap5h(session ? rows.at(-1)?.account_id ?? 'home' : 'home');
  return {
    session: session ?? 'all', days, hit_rate: hitRate(j),
    reads: sum(j, (r) => r.cache_read), writes: sum(j, (r) => r.cache_create), turns_joined: j.length,
    reads_per_turn: j.length ? Math.round(sum(j, (r) => r.cache_read) / j.length) : null, last_write: j.at(-1)?.cache_create ?? null,
    avoidable: { count: avoid.length, total: bursts.length, usd: sum(avoid, (b) => b.usd) }, bursts_usd: sum(bursts, (b) => b.usd),
    by_cause: [...kinds.values()].sort((a, b) => b.usd - a.usd), prices_as_of: PRICES_AS_OF,
    turns: (session ? rows : j).slice(-200).map((r) => ({ i: r.i, ts: r.ts, session_key: r.session_key, cache_read: r.cache_read, cache_create: r.cache_create, in_tok: r.in_tok, burst: r.burst ?? r.cold ?? null })),
    bursts: bursts.reverse(),
    savings_if_avoided_tokens: saved, savings_pct_of_5h: cap ? saved / cap : null,
  };
}

// 5h: linear burn over the last 60 min of this account's utilization samples, extended to the window reset.
// 7d: an hour of burn stretched over days projects 300%+, so use the window's average rate so far instead.
// ponytail: straight lines; upgrade to a per-hour-of-week profile when there's a few weeks of ledger.
function project(accountId: string, w: '5h' | '7d', now = Date.now()) {
  if (w === '7d') {
    const j = one('select last_ratelimit_json j from accounts where id = ?', accountId)?.j, u = util(j, w), reset = util(j, w, 'reset');
    const elapsed = 7 * 864e5 - (reset! * 1000 - now);
    return u != null && reset && elapsed > 3600_000 ? u * (7 * 864e5) / elapsed : null;
  }
  const s = all(`select ts, ratelimit_json j from requests where account_id = ? and ts >= ? and ratelimit_json like '%${w}-utilization%' order by ts`, accountId, now - 3600_000)
    .map((r) => ({ ts: r.ts, u: util(r.j, w), reset: util(r.j, w, 'reset') })).filter((x) => x.u != null);
  const a = s[0], b = s.at(-1);
  if (!a || !b || b.ts - a.ts < 5 * 60_000 || !b.reset) return null;
  return b.u! + Math.max(0, (b.u! - a.u!) / (b.ts - a.ts)) * Math.max(0, b.reset * 1000 - now);
}

// ---- A3: cache-lifetime fit ----
// Replays each bucket's real gaps (time since the previous request of the same thread) under a 5m and a 1h cache lifetime.
// Assumptions, per turn, when the lifetime differs from the one the turn really used:
//   gap <= 5 min                      both lifetimes hold: reads stay reads, the turn's writes are repriced
//   5 < gap <= 60 min                 under 5m the cache is gone: the whole prefix (read + write) is written again at the 5m rate;
//                                     under 1h it would still be there: what the turn re-wrote of the previous context becomes a read
//   gap > 60 min, or a first turn     cold either way: only the write price changes
// A turn already on the lifetime in question keeps its actual cost; input and output never change. A switch is recommended only when
// it saves at least 5% and $1 over the window.
// ponytail: a 5m turn that re-wrote for another reason (model switch, compaction) inside the 5–60 min band is credited as a read under 1h.
export function ttlFit(rows: any[], days: number, rc: Record<string, any> = settings().rate_card ?? {}) {
  return ([['main', 'promptCacheTtl'], ['subagents', 'subagentPromptCacheTtl']] as const).map(([bucket, setting]) => {
    const rs = rows.filter((r) => r.cache_create != null && r.usd != null && (bucket === 'main') === !r.agent_id);
    const current = sum(rs, (r) => r.cache_1h) >= sum(rs, (r) => r.cache_5m) ? '1h' : '5m', other = current === '1h' ? '5m' : '1h';
    const usd: Record<string, number> = { '5m': 0, '1h': 0 };
    let band = 0;
    for (const r of rs) {
      const p = rates(r.model, rc)!, R = r.cache_read ?? 0, tot = R + (r.cache_create ?? 0), mid = r.gap != null && r.gap > 300_000 && r.gap <= 3600_000;
      const mine = r.cache_1h || r.cache_5m ? ((r.cache_1h ?? 0) >= (r.cache_5m ?? 0) ? '1h' : '5m') : current;
      const io = r.usd - cost({ ...r, in_tok: 0, out_tok: 0 }, rc)!;
      band += mid ? 1 : 0;
      for (const t of ['5m', '1h']) {
        if (t === mine) { usd[t] += r.usd; continue; }
        const read = !mid ? R : t === '5m' ? 0 : Math.max(R, Math.min(tot, r.prev_ctx ?? 0));
        usd[t] += io + (read * p.read + (tot - read) * (t === '1h' ? p.write_1h : p.write_5m)) / 1e6;
      }
    }
    const actual = sum(rs, (r) => r.usd), saving = actual - usd[other], pct = actual ? saving / actual : 0, pc = `${Math.round(Math.abs(pct) * 100)}%`;
    const go = saving >= 1 && pct >= 0.05;
    return { bucket, setting, current, turns: rs.length, turns_5_60: band, actual_usd: actual, usd_5m: usd['5m'], usd_1h: usd['1h'], saving_usd: saving, saving_pct: pct, switch_to: go ? other : null,
      recommend: !rs.length ? 'No joined turns in this window.'
        : go ? `Set \`${setting}\` to \`${other}\`: about ${fmtUsd(saving)} less over these ${days} days (${pc}).`
        : saving < 0 ? `Keep the current lifetime (${current}): ${other} would have cost ${fmtUsd(-saving)} more (+${pc}).`
        : `Keep the current lifetime (${current}): ${other} would save ${fmtUsd(saving)} (${pc}), under the $1 and 5% bar.` };
  });
}

// ---- B1/B2: the same tokens at another model's list price. The arithmetic is exact; whether the cheaper model would have done the
// work as well is not known, so B1 is labelled unverified. ----
const NEWER: Record<string, string> = { 'opus-5': 'opus-5-5', 'sonnet-5': 'sonnet-5-5' }; // B2a: same family, newer; a finding only when also cheaper
const STEP_DOWN: Record<string, string> = { 'fable-5-1': 'opus-5-5', 'opus-5-5': 'sonnet-5-5', 'sonnet-5-5': 'haiku-4-5', 'sonnet-5': 'haiku-4-5' }; // the B1 finding per model
// B2b: tools that only read; the last three are bookkeeping. A subagent run that called nothing else is a "simple subagent task".
const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'ToolSearch', 'TodoWrite', 'SubagentHandback']);
const SEARCH_FIX = 'Add "ENABLE_TOOL_SEARCH": "true" beside ANTHROPIC_BASE_URL in the "env" block of ~/.claude/settings.json (a custom base URL turns tool search off).';
const MANY_TOOLS = 20; // A7: with tool search on, the CLI keeps about a dozen definitions loaded (11 observed)
const nice = (k: string) => k.replace(/^([a-z])([a-z]+)-(\d+)(?:-(\d+))?$/, (_, a, b, x, y) => `${a.toUpperCase()}${b} ${x}${y ? `.${y}` : ''}`);
const kt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
// token sums of turns() rows, shaped like SUMS
const sums = (rs: any[]) => ({ in_tok: sum(rs, (r) => r.in_tok), out_tok: sum(rs, (r) => r.out_tok), cache_read: sum(rs, (r) => r.cache_read), cache_1h: sum(rs, (r) => r.cache_1h),
  cache_5m: sum(rs, (r) => (r.cache_1h == null && r.cache_5m == null ? r.cache_create : r.cache_5m)) });
function whatIf(rows: any[], rc: Record<string, any>) {
  const by = new Map<string, any[]>();
  for (const r of rows) if (r.usd != null) { const k = rates(r.model, rc)!.key; if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
  return [...by].map(([from, rs]) => ({ from, turns: rs.length, usd: sum(rs, (r) => r.usd) as number, account: payer(rs), limits: limText(sum(rs, (r) => r.usd), payer(rs)),
    on: Object.fromEntries(Object.keys(PRICES).filter((k) => k !== from).map((k) => [k, cost({ ...sums(rs), model: k }, rc)])) as Record<string, number> })).sort((a, b) => b.usd - a.usd);
}
// "Switch now" for one session: the one-time re-write of its current context at the target model's write price, and how many turns of
// the session's recent mix (its last 20 main turns) it takes to earn that back. null break-even = the target costs more per turn.
function switchNow(rows: any[], rc: Record<string, any>) {
  const main = rows.filter((r) => !r.agent_id && r.cache_create != null && r.usd != null && r.tools_count > 0).slice(-20), cur = main.at(-1);
  if (!cur) return null;
  const from = rates(cur.model, rc)!.key, t = sums(main), n = main.length, per = sum(main, (r) => r.usd) / n, context = ctx(cur), h1 = ttlOf(cur) === 3600_000;
  return { from, context, per_turn_usd: per, turns_sampled: n, to: Object.keys(PRICES).filter((k) => k !== from).map((k) => {
    const w = rates(k, rc)!, rewrite = context * (h1 ? w.write_1h : w.write_5m) / 1e6, then = cost({ ...t, model: k }, rc)! / n;
    return { model: k, rewrite_usd: rewrite, limits: limText(rewrite, cur.account_id), per_turn_usd: then, breakeven_turns: per > then ? Math.ceil(rewrite / (per - then)) : null };
  }) };
}

function costView(q: URLSearchParams) {
  const st = settings(), rc = st.rate_card ?? {}, days = Math.max(1, Number(q.get('days')) || 7), sk = q.get('session');
  const session = sk && sk !== 'all' ? sk : null;
  const accts = all('select id, last_ratelimit_json j from accounts order by kind = \'home\' desc, id');
  const windows = Object.fromEntries((['5h', '7d'] as const).map((w) => [w, accts.map((a) => ({
    account: a.id, util: util(a.j, w), reset: util(a.j, w, 'reset'), projected_at_reset: project(a.id, w) }))]));
  const rows = turns(today()), oneShot = (r: any) => r.msg_count != null && r.msg_count <= 1 && !r.tools_count;
  const total = sum(rows.filter((r) => r.cache_create != null), W);
  const by = new Map<string, any[]>();
  for (const r of rows) if (!oneShot(r)) { const k = r.session_key ?? '-'; if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
  const per_session = [...by].map(([session_key, rs]) => {
    const j = rs.filter((r) => r.cache_create != null);
    return { session_key, turns: rs.length, joined: j.length, usd: sum(rs, (r) => r.usd), limits: limText(sum(rs, (r) => r.usd), payer(rs)), unpriced: rs.filter((r) => r.usd == null).length, cache_read: sum(j, (r) => r.cache_read),
      cache_create: sum(j, (r) => r.cache_create), out_tok: sum(j, (r) => r.out_tok), switch_overhead: sum(j.filter((r) => r.switched), (r) => r.cache_create), share: total ? sum(j, W) / total : null };
  }).sort((a, b) => (b.share ?? 0) - (a.share ?? 0));
  const os = rows.filter(oneShot), wide = turns(Date.now() - days * 864e5), scope = session ? wide.filter((r) => r.session_key === session) : wide;
  return { windows, per_session, one_shots: { count: os.length, out_tok: sum(os, (r) => r.out_tok), share: total ? sum(os.filter((r) => r.cache_create != null), W) / total : null },
    settings: st, usd: sum(rows, (r) => r.usd), limits: limText(sum(rows, (r) => r.usd), payer(rows)), exchange: limitsView(), unpriced: rows.filter((r) => r.usd == null).length, prices_as_of: PRICES_AS_OF, prices: PRICES, days,
    ttl_fit: ttlFit(wide, days, rc),
    model_whatif: { session: session ?? 'all', label: 'saving if quality holds — unverified', usd: sum(scope, (r) => r.usd), unpriced: scope.filter((r) => r.usd == null).length,
      rows: whatIf(scope, rc), switch_now: session ? switchNow(scope, rc) : null } };
}

// A4: one session's costliest tool results (advisor.ts carrying()), from its newest main transcript. Sizes and targets only.
// Re-scanned when the file has grown, at most once a minute.
const carryCache = new Map<string, { size: number; at: number; items: any[] }>();
async function carried(sk: string): Promise<any[]> {
  const path = one(`select jsonl_path p from requests where session_key = ? and agent_id is null and jsonl_path is not null order by ts desc limit 1`, sk)?.p;
  let size: number;
  try { size = statSync(path).size; } catch { return []; }
  const c = carryCache.get(path), rc = settings().rate_card ?? {};
  if (c && (c.size === size || Date.now() - c.at < 60_000)) return c.items;
  const items = await carrying(path, (m) => rates(m, rc)?.read ?? null);
  carryCache.set(path, { size, at: Date.now(), items });
  return items;
}

// Findings: every one is a dollar figure at list price with its evidence and the exact setting or command. quality: 'none' = no
// quality change, 'unverified' = saving if quality holds, 'docs-recommended' = what the Claude Code costs doc suggests.
async function insights(q: URLSearchParams) {
  const days = Math.max(1, Number(q.get('days')) || 7), since = Date.now() - days * 864e5, rows = turns(since), bursts = rows.filter((r) => r.burst), rc = settings().rate_card ?? {};
  // unused tools: loaded definitions only. Rows from before tools_loaded also hashed deferred ones; they are used only while nothing newer exists.
  const fresh = !!one('select 1 from requests where ts >= ? and tools_loaded is not null limit 1', since), loaded = new Set<string>();
  for (const r of all(`select tool_names_json j from requests where tool_names_json is not null and tools_hash in
      (select distinct tools_hash from requests where ts >= ? and tools_hash is not null and (tools_loaded is not null or ?))`, since, fresh ? 0 : 1)) for (const n of JSON.parse(r.j)) loaded.add(n);
  const used = new Set(all('select distinct name from tool_uses').map((r) => r.name));
  const big = new Map<string, { session_key: string; max_context_est: number; turns_over_120k: number }>();
  for (const r of rows) {
    const c = ctx(r) ?? 0, b = big.get(r.session_key) ?? { session_key: r.session_key, max_context_est: 0, turns_over_120k: 0 };
    b.max_context_est = Math.max(b.max_context_est, c); b.turns_over_120k += c > 120_000 ? 1 : 0; big.set(r.session_key, b);
  }
  const hours = new Map<number, number>();
  for (const b of bursts) { const h = new Date(b.ts).getHours(); hours.set(h, (hours.get(h) ?? 0) + 1); }
  const avoid = bursts.filter((r) => r.burst.avoidable), F: any[] = [];

  // A1: avoidable re-writes, and main conversations that went cold (5m lifetimes are judged by A3), per session and cause
  const A1: Record<string, string> = { model: 'Model switched mid-session', fast: 'Fast mode turned on mid-session', effort: 'Effort changed mid-session',
    tools: 'Loaded tool set changed mid-session', expired: 'Cache went cold' };
  const g = new Map<string, any[]>();
  for (const r of bursts) if (r.burst.kind in A1 && (r.burst.kind !== 'expired' || r.burst.ttl === '1h')) { const k = `${r.burst.kind}:${r.session_key}`; if (!g.has(k)) g.set(k, []); g.get(k)!.push(r); }
  for (const [k, rs] of g) { const b = rs.at(-1).burst, sk = rs[0].session_key;
    F.push({ id: `a1:${k}`, tier: 'A', title: `${A1[b.kind]} ${rs.length === 1 ? 'once' : `${rs.length} times`} in ‘${title(sk)}’`, usd: sum(rs, (r) => r.burst.usd),
      evidence: [`${kt(sum(rs, (r) => r.burst.delta))} tokens re-written`, b.cause], fix: b.fix, quality: 'none', session_key: sk, account: payer(rs, (r) => r.burst.usd) }); }
  // A3: a lifetime that would have been cheaper
  for (const f of ttlFit(rows, days, rc)) if (f.switch_to) F.push({ id: `a3:${f.bucket}`, tier: 'A', title: `A ${f.switch_to} cache lifetime fits ${f.bucket === 'main' ? 'the main conversation' : 'subagents'} better`,
    usd: f.saving_usd, evidence: [`${f.turns_5_60} of ${plural(f.turns, 'turn')} came 5–60 min after the one before`, `${fmtUsd(f.actual_usd)} at ${f.current} → ${fmtUsd(f.actual_usd - f.saving_usd)} at ${f.switch_to}`],
    fix: `"${f.setting}": "${f.switch_to}" in ~/.claude/settings.json`, quality: 'none', account: payer(rows.filter((r) => (f.bucket === 'main') === !r.agent_id)) });
  // A4: the ten costliest tool results to carry. ponytail: looks at the 20 sessions that read the most cache in the window, whole transcript
  const heavy = all(`select session_key sk from requests where ts >= ? and agent_id is null and jsonl_path is not null and source is null group by 1 order by sum(cache_read) desc limit 20`, since);
  const carry = (await Promise.all(heavy.map(async ({ sk }) => (await carried(sk)).map((c) => ({ ...c, session_key: sk }))))).flat().sort((a, b) => b.usd - a.usd).slice(0, 10);
  carry.forEach((c, i) => F.push({ id: `a4:${i}:${c.session_key}`, tier: 'A', title: `${c.tool}${c.target && c.target !== c.tool ? ` ${c.target}` : ''}: one result re-read on ${plural(c.turns, 'turn')} in ‘${title(c.session_key)}’`,
    usd: c.usd, evidence: [`${kt(c.tokens)} tokens`, `carried for ${plural(c.turns, 'turn')}`], fix: c.suggestion, quality: 'none', session_key: c.session_key,
    account: one('select account_id a from sessions where session_key = ?', c.session_key)?.a }));
  // A7: many loaded definitions and no tool-search tool (what a custom ANTHROPIC_BASE_URL does to the terminal CLI)
  const search = new Map<string, boolean>(all('select tools_hash h, tool_names_json j from requests where tool_names_json is not null').map((r) => [r.h, /tool.?search/i.test(r.j)]));
  const nt = (r: any) => r.tools_loaded ?? r.tools_count ?? 0, gw = rows.filter((r) => nt(r) >= MANY_TOOLS && search.get(r.tools_hash) === false);
  if (gw.length) { const sized = gw.filter((r) => r.tools_tok && r.usd != null), n = new Set(gw.map((r) => r.session_key)).size;
    F.push({ id: 'a7', tier: 'A', title: `Tool search is off in ${plural(n, 'session')}: up to ${Math.max(...gw.map(nt))} tool definitions load on every request`,
      usd: sized.length ? sum(sized, (r) => r.tools_tok * rates(r.model, rc)!.read / 1e6) : null,
      evidence: [`${plural(gw.length, 'request')} with no tool-search tool`, sized.length ? `about ${kt(Math.max(...sized.map((r) => r.tools_tok)))} tokens of definitions re-read per request (upper bound: about a dozen core tools stay loaded)`
        : 'definition sizes are recorded from this version on'],
      fix: SEARCH_FIX, quality: 'none', account: payer(gw) }); }
  // B2a / B1: the same tokens on a newer sibling, and one step down
  for (const w of whatIf(rows, rc)) {
    const to = NEWER[w.from], down = STEP_DOWN[w.from];
    if (to && w.on[to] < w.usd) F.push({ id: `b2:${w.from}`, tier: 'B', title: `${nice(w.from)} → ${nice(to)}: same family, newer and cheaper`, usd: w.usd - w.on[to],
      evidence: [plural(w.turns, 'turn'), `${fmtUsd(w.usd)} → ${fmtUsd(w.on[to])} for the same tokens`, 'no quality change expected'],
      fix: `Start new sessions with \`claude --model claude-${to}\`, or set "model": "claude-${to}" in settings.json.`, quality: 'none', account: w.account });
    if (down && w.on[down] < w.usd) F.push({ id: `b1:${w.from}`, tier: 'B', title: `The same tokens on ${nice(down)} instead of ${nice(w.from)}`, usd: w.usd - w.on[down],
      evidence: [plural(w.turns, 'turn'), `${fmtUsd(w.usd)} → ${fmtUsd(w.on[down])} (−${Math.round((1 - w.on[down] / w.usd) * 100)}%)`, 'saving if quality holds — unverified'],
      fix: `Start suitable sessions with \`claude --model claude-${down}\`. A switch mid-session re-writes the cache first: Cost → model what-if shows the break-even.`, quality: 'unverified', account: w.account });
  }
  // B2b: subagent runs that only read, on a model above Haiku
  const usedBy = new Map<string, Set<string>>();
  for (const r of all(`select r.agent_id a, t.name from tool_uses t join requests r on r.request_id = t.request_id where r.agent_id is not null and r.ts >= ? group by 1, 2`, since)) {
    if (!usedBy.has(r.a)) usedBy.set(r.a, new Set()); usedBy.get(r.a)!.add(r.name); }
  const ro = rows.filter((r) => r.agent_id && r.usd != null && rates(r.model, rc)!.key !== 'haiku-4-5' && usedBy.has(r.agent_id) && [...usedBy.get(r.agent_id)!].every((t) => READ_ONLY.has(t)));
  if (ro.length) { const ids = [...new Set(ro.map((r) => r.agent_id as string))], usd = sum(ro, (r) => r.usd), haiku = sum(ro, (r) => cost({ ...r, model: 'haiku-4-5' }, rc)!);
    F.push({ id: 'b2:haiku-subagents', tier: 'B', title: `${plural(ids.length, 'read-only subagent run')} on a larger model than the docs suggest`, usd: usd - haiku,
      evidence: [`${fmtUsd(usd)} → ${fmtUsd(haiku)} on Haiku 4.5`, `tools called: ${[...new Set(ids.flatMap((a) => [...usedBy.get(a)!]))].sort().join(', ')}`,
        ...ids.slice(0, 3).map((a) => String(one('select coalesce(name, agent_id) n from agents where agent_id = ?', a)?.n ?? a).slice(0, 60))],
      fix: 'Put `model: haiku` in the subagent definition (.claude/agents/<name>.md), or pass model "haiku" on the Agent call, for read-only exploration. The Claude Code costs doc recommends Haiku for simple subagent tasks.',
      quality: 'docs-recommended', account: payer(ro) }); }
  // the tool loading advisor's top recommendation that carries dollars (30 days, every project)
  const tv = toolsView(new URLSearchParams()), top = tv.servers.find((x: any) => x.usd > 0 && x.class !== 'builtin');
  if (top) F.push({ id: `tools:${top.server}`, tier: 'A', title: `${top.label}: MCP server ‘${top.server}’`, usd: top.usd, evidence: top.evidence, fix: top.change, quality: 'none', account: tv.account });
  for (const f of F) f.limits = limText(f.usd, f.account);
  F.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  const tier = (t: string) => sum(F.filter((f) => f.tier === t), (f) => f.usd);
  return {
    window: { days, turns: rows.length, sessions: new Set(rows.map((r) => r.session_key)).size }, prices_as_of: PRICES_AS_OF,
    findings: F, usd: sum(rows, (r) => r.usd), unpriced_requests: rows.filter((r) => r.usd == null).length,
    // tools_count > 0: real agent turns only; the desktop's title/suggestion side requests use fixed prompts
    recurring_preambles: all(`select first_user_hash, count(distinct r.session_key) sessions, count(distinct s.cwd) projects, max(first_user_tok) est_tokens
      from requests r left join sessions s on s.session_key = r.session_key where r.ts >= ? and first_user_hash is not null and tools_count > 0
      group by 1 having sessions >= 3 order by sessions desc limit 10`, since),
    unused_tools: { loaded: loaded.size, used: [...loaded].filter((n) => used.has(n)).length, never_used: [...loaded].filter((n) => !used.has(n)).sort(), approx: !fresh },
    big_context_sessions: [...big.values()].filter((b) => b.max_context_est > 120_000).sort((a, b) => b.max_context_est - a.max_context_est).slice(0, 10),
    burst_hours: [...hours].map(([hour, count]) => ({ hour, count })).sort((a, b) => b.count - a.count),
    totals: { tokens_saved_est: sum(avoid, (r) => r.burst.delta), bursts_avoidable: avoid.length, bursts: bursts.length, usd_a: tier('A'), usd_b: tier('B') },
  };
}

// One budget's spend in its current period, in dollars at list price: cost() over /v1/messages rows (status < 400) with the scope
// filter, summed per session, model and speed. Requests on unpriced models are counted in `unpriced`, never in `spent`.
// day = since local midnight; week = rolling last 7×24 h; session = per session, whole life: `sk` names the session (a request's),
// without it the view shows the biggest session active in the last 24 h.
// unit 'pct_7d' | 'pct_5h': the limit is percentage points of one account's window (scope 'account', or 'all' with a single account);
// the dollars are converted through asLimits(). Until the estimator has a value for that account the budget is 'waiting' and never fires.
// ponytail: a SUM over the window per budget, per request and per poll (uses requests_ts / requests_session_ts); keep a running
// total per budget and period if the ledger gets large.
export function budgetStatus(b: any, sk?: string | null) {
  const t = now(), day = new Date(t).setHours(0, 0, 0, 0), per = b.period === 'session', rc = settings().rate_card ?? {};
  const start = per ? 0 : b.period === 'day' ? day : t - 7 * 864e5;
  const w = [`${MSG('r.')} and r.status < 400 and r.ts >= ?`], a: any[] = [start];
  if (b.scope === 'project') { w.push(`r.session_key in (select session_key from sessions where substr(cwd, -length(?) - 1) = '/' || ?)`); a.push(b.match, b.match); }
  if (b.scope === 'account') { w.push('r.account_id = ?'); a.push(b.match); }
  if (b.scope === 'session' && b.match) { w.push('r.session_key = ?'); a.push(b.match); }
  if (per && sk) { w.push('r.session_key = ?'); a.push(sk); }
  else if (per) { w.push('r.session_key in (select session_key from sessions where last_ts >= ?)'); a.push(t - 864e5); }
  const rows = all(`select r.session_key sk, r.account_id, r.model, r.speed, ${SUMS('r.')} from requests r where ${w.join(' and ')} group by 1, 2, 3, 4`, ...a);
  const by = new Map<string | null, number>();
  for (const r of rows) { r.usd = cost(r, rc); if (r.usd != null) by.set(r.sk, (by.get(r.sk) ?? 0) + r.usd); }
  const top = [...by].sort((x, y) => y[1] - x[1]).slice(0, 3);
  const mine = per ? rows.filter((r) => r.sk === (sk ?? top[0]?.[0])) : rows, usd = sum(mine, (r) => r.usd), unit = b.unit ?? 'usd', ids = all('select id from accounts');
  const account = b.scope === 'account' ? b.match : unit === 'usd' ? payer(mine) : ids.length === 1 ? ids[0].id : null;
  const spent = unit === 'usd' ? usd : asLimits(usd, account)?.[unit as 'pct_7d' | 'pct_5h'] ?? null, pct = spent == null ? 0 : spent / b.limit;
  return { ...b, unit, account, spent, spent_usd: usd, limits: limText(usd, account), pct, state: spent == null ? 'waiting' : pct >= 1 ? 'over' : pct >= 0.8 ? 'warn' : 'ok', period_start: start, unpriced: sum(mine.filter((r) => r.usd == null), (r) => r.n),
    period_end: b.period === 'day' ? new Date(day).setDate(new Date(day).getDate() + 1) : null,
    period_key: per ? sk ?? top[0]?.[0] ?? null : b.period === 'day' ? new Date(day).toLocaleDateString('sv') : 'rolling-7d',
    top: top.map(([k, usd]) => ({ label: k ? title(k) : '—', usd })) };
}
const budgets = () => (settings().budgets as any[]).map((b) => budgetStatus(b));
// "$1.65 of $2.00", or for a budget in % of a window "4.1% of 5% of home's week ($19.40 at list price)"; a waiting one has no amount yet
export const budgetAmt = (b: any) => b.unit === 'usd' ? `${fmtUsd(b.spent)} of ${fmtUsd(b.limit)}`
  : `${b.spent == null ? 'waiting for data' : fmtPct(b.spent)} of ${b.limit}% of ${b.account ?? 'the account'}'s ${b.unit === 'pct_7d' ? 'week' : '5-hour window'} (${fmtUsd(b.spent_usd)} at list price)`;

// One session's /v1/messages turns in order, with account, joined usage, burst and the migration each turn paid for, plus the five
// tool results that cost the most to carry.
export async function timeline(key: string) {
  const rows = turns(0, key), names = new Map(all('select agent_id, name from agents where session_key = ?', key).map((a) => [a.agent_id, a.name]));
  for (const m of all('select * from migrations where session_key = ? order by ts', key)) {
    const t = rows.find((r) => (m.request_id ? r.request_id === m.request_id : r.ts >= m.ts)); // manual pins: the first turn after
    if (t) t.migration = { from: m.from_account, to: m.to_account, reason: m.reason, est: m.est_cost_tokens, actual: m.actual_cost_tokens };
  }
  return { session_key: key, title: one('select title from sessions where session_key = ?', key)?.title ?? key.slice(0, 8), carrying: (await carried(key)).slice(0, 5),
    turns: rows.map((r) => ({ i: r.i, ts: r.ts, request_id: r.request_id, account_id: r.account_id, model: r.model, agent_id: r.agent_id,
      agent_name: r.agent_id ? names.get(r.agent_id) ?? r.agent_id : null, in_tok: r.in_tok, cache_read: r.cache_read, cache_create: r.cache_create, out_tok: r.out_tok,
      context_total: r.cache_create == null ? null : (r.in_tok ?? 0) + (r.cache_read ?? 0) + r.cache_create, latency_ms: r.latency_ms, status: r.status,
      burst: r.burst ? { cause: r.burst.cause, avoidable: r.burst.avoidable } : null, migration: r.migration ?? null })) };
}

// 'insights' returns a promise (it sizes transcripts); the rest are synchronous
export function consoleApi(what: string, q: URLSearchParams, accounts?: any[]): any {
  if (what === 'overview') return overview(accounts ?? []);
  if (what === 'sessions') return sessions();
  if (what === 'cache') return cache(q);
  if (what === 'cost') return costView(q);
  if (what === 'insights') return insights(q);
  if (what === 'budgets') return budgets();
  if (what === 'limits') return limitsView();
  if (what === 'tools') return toolsView(q);
  if (what === 'warm') return warmView();
}
