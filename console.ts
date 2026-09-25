// Read-only views for the console UI: pure SQL + JS over the ledger. Nothing here writes.
import { db, settings } from './ledger.ts';

const all = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];
const one = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
const MSG = (t = '') => `(${t}path = '/v1/messages' or ${t}path like '/v1/messages?%')`;
const RL = 'anthropic-ratelimit-unified-';
export const util = (json: string | null, w: '5h' | '7d', k = 'utilization'): number | null => {
  try { const v = JSON.parse(json ?? '{}')[`${RL}${w}-${k}`]; return v == null ? null : Number(v); } catch { return null; }
};
const today = () => new Date().setHours(0, 0, 0, 0);
const sum = (rows: any[], f: (r: any) => number) => rows.reduce((a, r) => a + (f(r) || 0), 0);
// ponytail: window accounting weights are unpublished; cache reads counted at their 0.1x price, everything else 1x.
const W = (r: any) => (r.in_tok ?? 0) + (r.cache_create ?? 0) + (r.out_tok ?? 0) + (r.cache_read ?? 0) / 10;
const ctx = (r: any) => (r.cache_create != null ? (r.in_tok ?? 0) + (r.cache_read ?? 0) + r.cache_create : r.context_est);

const FIX: Record<string, string> = {
  'account switch': 'Expected: the prompt cache is per account, so a switch re-writes the whole context.',
  'MCP tool list': 'Pin tool order, or disable MCP servers you don\'t use in this project.',
  'system prompt changed': 'Batch CLAUDE.md / instruction edits, or make them at the start of a new session.',
  'idle > 1h': 'Send one cheap turn before 60 minutes to keep the 1h cache warm.',
};

// /v1/messages rows (2xx/3xx) since `since`, each annotated with `i` (turn in session), `switched`, and `burst`.
function turns(since: number, session?: string | null) {
  const rows = all(`select r.id, r.ts, r.request_id, r.session_key, r.account_id, r.model, r.latency_ms, r.tools_hash, r.tools_count,
      r.system_hash, r.first_user_hash, r.msg_count, r.context_est, r.cache_read, r.cache_create, r.in_tok, r.out_tok,
      exists (select 1 from migrations m where r.request_id is not null and m.request_id = r.request_id) migrated
    from requests r where ${MSG()} and status < 400 and session_key is not null and ts >= ? ${session ? 'and session_key = ?' : ''} order by ts`,
    ...(session ? [since, session] : [since]));
  const by = new Map<string, any[]>();
  for (const r of rows) { const k = r.session_key ?? '-'; if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
  for (const rs of by.values()) {
    // "previous request" = previous one in the same thread: a session also carries subagent and side-request threads,
    // each with its own first user message and prefix. Old rows without fingerprints fall back to model.
    const last = new Map<string, any>();
    rs.forEach((r, i) => {
      r.i = i + 1;
      const k = r.first_user_hash ?? r.model, p = last.get(k);
      last.set(k, r);
      r.switched = !!(r.migrated || (p && p.account_id !== r.account_id));
      if (r.cache_create == null || r.cache_create <= 8_000) return;
      // a thread's first turn is a cold start: labelled on the turn, never counted as a burst
      if (!p) return void (r.cold = { cause: 'first turn, cold cache', avoidable: false, delta: r.cache_create, fix: null, gap_s: null });
      // burst = wrote well over what this turn added, so old context was re-written. ctx(): joined usage, else the byte estimate
      if (r.cache_create <= 2 * Math.max(0, ctx(r) - (ctx(p) ?? 0))) return;
      const cause = r.switched ? 'account switch'
        : p.tools_hash && r.tools_hash && p.tools_hash !== r.tools_hash ? `MCP tool list changed (${p.tools_count} → ${r.tools_count} tools)`
        : p.system_hash && r.system_hash && p.system_hash !== r.system_hash ? 'system prompt changed'
        : r.ts - p.ts > 3600_000 ? 'idle > 1h, cache TTL expired'
        : 'unknown: prefix re-written without a fingerprint change';
      const fix = Object.entries(FIX).find(([k]) => cause.startsWith(k))?.[1] ?? null;
      r.burst = { cause, avoidable: /tool list|system prompt/.test(cause), delta: r.cache_create, fix, gap_s: Math.round((r.ts - p.ts) / 1000) };
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
    accounts,
    live: live.map((r) => ({ ts: r.ts, account: r.account_id, session_key: r.session_key, model: r.model, status: r.status, latency_ms: r.latency_ms,
      cache: r.cache_create == null ? '—' : r.cache_create > r.cache_read ? 'write' : 'hit', cache_create: r.cache_create,
      migration: r.migration ? JSON.parse(r.migration) : null })),
  };
}

function sessions() {
  return all(`select s.*, (select coalesce(r.in_tok + r.cache_read + r.cache_create, r.context_est) from requests r
        where r.session_key = s.session_key and r.context_est is not null order by r.ts desc limit 1) context_est,
      (select ua_kind from requests r where r.session_key = s.session_key and ua_kind is not null order by r.ts desc limit 1) source
    from sessions s where account_id is not null order by last_ts desc limit 100`) // transcript-only rows (a title, never routed) have no pin
    .map((s) => ({ ...s, title: s.title ?? s.session_key.slice(0, 8), project: s.cwd?.split('/').pop() ?? null,
      switch_cost_est: s.context_est == null ? null : Math.round(s.context_est * 1.25),
      agents: all(`select a.agent_id, coalesce(a.name, a.agent_id) name, count(r.id) requests, sum(r.cache_read) cache_read, sum(r.cache_create) cache_create, a.last_ts
        from agents a left join requests r on r.agent_id = a.agent_id where a.session_key = ? group by a.agent_id order by a.first_ts`, s.session_key) }));
}

function cache(q: URLSearchParams) {
  const days = Math.max(1, Number(q.get('days')) || 7), s = q.get('session');
  const session = s && s !== 'all' ? s : null;
  const rows = turns(Date.now() - days * 864e5, session), j = rows.filter((r) => r.cache_create != null);
  const bursts = rows.filter((r) => r.burst).map((r) => ({ i: r.i, ts: r.ts, session_key: r.session_key, account: r.account_id, ...r.burst }));
  const avoid = bursts.filter((b) => b.avoidable), saved = sum(avoid, (b) => b.delta);
  const cap = cap5h(session ? rows.at(-1)?.account_id ?? 'home' : 'home');
  return {
    session: session ?? 'all', days, hit_rate: hitRate(j),
    reads: sum(j, (r) => r.cache_read), writes: sum(j, (r) => r.cache_create), turns_joined: j.length,
    reads_per_turn: j.length ? Math.round(sum(j, (r) => r.cache_read) / j.length) : null, last_write: j.at(-1)?.cache_create ?? null,
    avoidable: { count: avoid.length, total: bursts.length },
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

function cost() {
  const st = settings(), rc = st.rate_card ?? {};
  const accts = all('select id, last_ratelimit_json j from accounts order by kind = \'home\' desc, id');
  const windows = Object.fromEntries((['5h', '7d'] as const).map((w) => [w, accts.map((a) => ({
    account: a.id, util: util(a.j, w), reset: util(a.j, w, 'reset'), projected_at_reset: project(a.id, w) }))]));
  const price = (r: any) => {
    const k = Object.keys(rc).find((m) => r.model?.startsWith(m)), c = k && rc[k];
    return c ? ((r.in_tok ?? 0) * (c.input ?? 0) + (r.out_tok ?? 0) * (c.output ?? 0) + (r.cache_read ?? 0) * (c.cache_read ?? 0) + (r.cache_create ?? 0) * (c.cache_write ?? 0)) / 1e6 : null;
  };
  const rows = turns(today()), oneShot = (r: any) => r.msg_count != null && r.msg_count <= 1 && !r.tools_count;
  const total = sum(rows.filter((r) => r.cache_create != null), W);
  const by = new Map<string, any[]>();
  for (const r of rows) if (!oneShot(r)) { const k = r.session_key ?? '-'; if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
  const per_session = [...by].map(([session_key, rs]) => {
    const j = rs.filter((r) => r.cache_create != null), ps = j.map(price);
    return { session_key, turns: rs.length, joined: j.length, cache_read: sum(j, (r) => r.cache_read), cache_create: sum(j, (r) => r.cache_create),
      out_tok: sum(j, (r) => r.out_tok), switch_overhead: sum(j.filter((r) => r.switched), (r) => r.cache_create),
      share: total ? sum(j, W) / total : null, dollars: j.length && ps.every((p) => p != null) ? sum(ps, (p) => p) : null };
  }).sort((a, b) => (b.share ?? 0) - (a.share ?? 0));
  const os = rows.filter(oneShot);
  const d = per_session.map((s) => s.dollars);
  return { windows, per_session, one_shots: { count: os.length, out_tok: sum(os, (r) => r.out_tok), share: total ? sum(os.filter((r) => r.cache_create != null), W) / total : null },
    settings: st, dollars: d.length && d.every((x) => x != null) ? sum(d, (x) => x) : null };
}

function insights() {
  const since = Date.now() - 7 * 864e5, rows = turns(since), bursts = rows.filter((r) => r.burst);
  const loaded = new Set<string>();
  for (const r of all(`select tool_names_json j from requests where tool_names_json is not null and tools_hash in
      (select distinct tools_hash from requests where ts >= ? and tools_hash is not null)`, since)) for (const n of JSON.parse(r.j)) loaded.add(n);
  const used = new Set(all('select distinct name from tool_uses').map((r) => r.name));
  const big = new Map<string, { session_key: string; max_context_est: number; turns_over_120k: number }>();
  for (const r of rows) {
    const c = ctx(r) ?? 0, b = big.get(r.session_key) ?? { session_key: r.session_key, max_context_est: 0, turns_over_120k: 0 };
    b.max_context_est = Math.max(b.max_context_est, c); b.turns_over_120k += c > 120_000 ? 1 : 0; big.set(r.session_key, b);
  }
  const hours = new Map<number, number>();
  for (const b of bursts) { const h = new Date(b.ts).getHours(); hours.set(h, (hours.get(h) ?? 0) + 1); }
  const avoid = bursts.filter((r) => r.burst.avoidable);
  return {
    window: { days: 7, turns: rows.length, sessions: new Set(rows.map((r) => r.session_key)).size },
    // tools_count > 0: real agent turns only; the desktop's title/suggestion side requests use fixed prompts
    recurring_preambles: all(`select first_user_hash, count(distinct r.session_key) sessions, count(distinct s.cwd) projects, max(first_user_tok) est_tokens
      from requests r left join sessions s on s.session_key = r.session_key where r.ts >= ? and first_user_hash is not null and tools_count > 0
      group by 1 having sessions >= 3 order by sessions desc limit 10`, since),
    unused_tools: { loaded: loaded.size, used: [...loaded].filter((n) => used.has(n)).length, never_used: [...loaded].filter((n) => !used.has(n)).sort() },
    big_context_sessions: [...big.values()].filter((b) => b.max_context_est > 120_000).sort((a, b) => b.max_context_est - a.max_context_est).slice(0, 10),
    burst_hours: [...hours].map(([hour, count]) => ({ hour, count })).sort((a, b) => b.count - a.count),
    totals: { tokens_saved_est: sum(avoid, (r) => r.burst.delta), bursts_avoidable: avoid.length, bursts: bursts.length },
  };
}

export function consoleApi(what: string, q: URLSearchParams, accounts?: any[]): any {
  if (what === 'overview') return overview(accounts ?? []);
  if (what === 'sessions') return sessions();
  if (what === 'cache') return cache(q);
  if (what === 'cost') return cost();
  if (what === 'insights') return insights();
}
