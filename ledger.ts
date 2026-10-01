import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';

// State lives in ~/.agent-router/; a ledger from before that (next to the source) is moved there once.
const dir = import.meta.dirname, path = process.env.LEDGER_PATH ?? `${homedir()}/.agent-router/ledger.sqlite`;
if (!process.env.LEDGER_PATH) {
  mkdirSync(`${homedir()}/.agent-router`, { recursive: true, mode: 0o700 });
  const old = `${dir}/ledger.sqlite`;
  if (existsSync(old) && !existsSync(path)) {
    const o = new DatabaseSync(old); o.exec('pragma wal_checkpoint(TRUNCATE)'); o.close();
    // ponytail: rename, so same volume only (checkout under ~); any -wal/-shm left moves with it, nothing is dropped
    for (const x of ['', '-wal', '-shm']) if (existsSync(old + x)) renameSync(old + x, path + x);
    console.log(`ledger moved: ${old} -> ${path}`);
  }
}
export const db = new DatabaseSync(path);
db.exec('pragma journal_mode = wal; pragma busy_timeout = 2000'); // UI/tests read while the router writes
db.exec(readFileSync(`${dir}/schema.sql`, 'utf8'));
// `create if not exists` skips tables older ledgers already have; add their missing columns
const addCol = (t: string, c: string) => {
  try { db.exec(`alter table ${t} add column ${c}`); return true; } catch (e: any) { if (!/duplicate column/.test(e.message)) throw e; }
};
for (const c of ['config_dir text', 'cooling_reason text', 'last_status integer', 'last_ratelimit_json text', 'last_seen integer', 'needs_login integer default 0',
  'warned_5h integer', 'warned_7d integer']) // warned_*: reset (epoch s) of the window last notified past warn_pct
  addCol('accounts', c);
addCol('migrations', 'reason text');
const added = addCol('migrations', 'actual_cost_tokens integer'); addCol('migrations', 'actual_request_id text');
// actual switch cost: the first /v1/messages request after the migration (forced replays name it in request_id); filled on its usage join
export const fillActual = db.prepare(`update migrations set actual_cost_tokens = :cc, actual_request_id = :rid
  where session_key = :sk and actual_cost_tokens is null and (request_id = :rid or request_id is null and ts <= :ts and :rid =
    (select request_id from requests r where r.session_key = :sk and (path = '/v1/messages' or path like '/v1/messages?%') and status < 400 and r.ts >= migrations.ts order by r.ts limit 1))`);
if (added) // one-time backfill from joins already in the ledger
  for (const r of db.prepare(`select request_id rid, session_key sk, ts, cache_create cc from requests where cache_create is not null
    and session_key in (select session_key from migrations) order by ts`).all()) fillActual.run(r as any);
addCol('sessions', 'cwd text');
if (addCol('sessions', 'title text')) db.exec('delete from tail_offsets'); // re-read the last 7 days once for titles/subagents; joins are idempotent
addCol('requests', 'agent_id text');
db.exec('create index if not exists requests_agent on requests(agent_id)');
const FP = ['system_hash', 'tools_hash', 'tools_count', 'msg_count', 'first_user_hash', 'first_user_tok', 'context_est', 'tool_names_json', 'ua_kind',
  'tools_loaded', 'tools_deferred', 'tools_tok', 'effort', 'speed', 'beta_hash', 'image_count', 'cli_version', 'tool_servers_json']; // cache-key fingerprint (NOTES.md "Cost insights")
for (const c of ['model_from_transcript', ...FP]) addCol('requests', `${c} ${/count|tok|est|loaded|deferred/.test(c) ? 'integer' : 'text'}`);
if (addCol('requests', 'usage_src text')) db.exec(`update requests set usage_src = 'transcript' where cache_create is not null`); // all usage so far came from the tailer
addCol('requests', 'source text');
addCol('tool_uses', 'arg text');
addCol('brain_sessions', 'trivial integer'); // 1 = a probe one-shot the brain keeps no note for; null = a note from before that test, judged on the next capture pass
addCol('brain_sessions', 'scan_usd real'); addCol('brain_sessions', 'extract_usd real');
db.exec('create index if not exists tool_uses_arg on tool_uses(arg)');
db.exec(`insert or ignore into accounts (id, kind) values ('home', 'home')`);
// Clock: Date.now() plus a skew only the DRILLS hook `POST /router/clock {skew_ms}` sets (tests roll a budget period with it).
export const clock = { skew: 0 };
export const now = () => Date.now() + clock.skew;

const USAGE = ['in_tok', 'out_tok', 'cache_read', 'cache_create', 'cache_1h', 'cache_5m', 'usage_src']; // from the response stream, at log time
const cols = ['ts', 'request_id', 'session_key', 'account_id', 'method', 'path', 'model', 'status', 'latency_ms', 'stream', 'retry_of', 'ratelimit_json', 'source', ...FP, ...USAGE];
const ins = db.prepare(`insert into requests (${cols}) values (${cols.map((c) => `:${c}`)})`);
export const logRequest = (row: Record<string, string | number | null>) =>
  Number(ins.run(Object.fromEntries(cols.map((c) => [c, row[c] ?? null]))).lastInsertRowid);

// Settings: JSON per key, defaults here. Unknown keys are rejected by the PUT handler.
export const DEFAULTS: Record<string, any> = {
  warn_pct: 0.8, route_cutoff_pct: 0.9, weekly_reserve_pct: 0.2,
  proactive_switch_pct: 0.95, proactive_min_gain: 0.2, notify: true, // move a pinned session off an account this full, to one this much emptier
  policy: 'sticky_least_utilized', // | 'prefer_home_until_80' | 'manual'
  rate_card: {},                   // { [model id substring]: { input, write_5m, write_1h, read, output } } in $/MTok: overrides console.ts PRICES per model
  context_rules: [
    { id: 'handoff-100k', text: 'Warn at 100k context, suggest a handoff summary', enabled: true, state: 'proposed' },
    { id: 'keep-warm', text: 'Keep sessions warm: nudge before the 1h cache lapses', enabled: true, state: 'proposed' },
    { id: 'mcp-allowlist', text: 'Per-project MCP allowlist from observed usage', enabled: false, state: 'proposed' },
    { id: 'preamble-skills', text: 'Promote repeated preambles to skills automatically', enabled: false, state: 'proposed' },
  ],
  openvikings_endpoint: null,
  // context advisor: window per model prefix (longest wins; a model containing [1m] defaults to 1M), thresholds, the Haiku subprocess
  context_windows: { default: 200000 }, context_warn_pct: 0.7, context_urgent_pct: 0.85,
  advisor_model: 'haiku', advisor_enabled: true, claude_bin: null,
  // [{ id, name, scope: 'all'|'project'|'account'|'session', match, period: 'day'|'week'|'session', limit (USD at list price), action: 'notify'|'stop', thresholds }]
  budgets: [],
  // going cold (router.ts coldTick): warn cold_lead_min minutes before a 1h-cached main conversation of at least cold_min_context tokens,
  // whose rebuild would cost at least cold_min_usd, loses its cache
  cold_warn: true, cold_min_context: 100000, cold_min_usd: 1, cold_lead_min: 5,
  // brain (docs/BRAIN.md): off until enabled; brain_dir null = ~/agent-router-brain; distilling spends at most brain_daily_usd a day
  // (a stored brain_daily_units from before dollars is ignored)
  brain_enabled: false, brain_dir: null, brain_distill: 'manual', brain_daily_usd: 1, // brain_distill: 'manual' | 'on_idle'
  classifier: 'auto', brain_classifier_model: 'haiku', brain_writer_model: 'sonnet', brain_confidence: 0.7, // classifier: 'auto' | 'jev' | 'model'
  // keep warm (router.ts warmTick, console.ts warmPlan): off until enabled. While on, the last main-thread request of sessions with at least
  // warm_min_context cached tokens is held in memory and replayed warm_lead_min minutes before its 1h cache lapses, for sessions with a
  // one-off (warm_sessions), a matching rule or warm_after_stop_hours > 0; rules and after-stop only cover a rebuild of warm_min_usd or more.
  // warm_rules: [{ id, name, days: [0-6], from: 'HH:MM', to: 'HH:MM', scope: 'all'|'project', match }] in local time.
  // warm_allow_5m: also ping 5-minute caches (never pays back; for the proof run in NOTES.md "Keep warm").
  warm_enabled: false, warm_min_context: 100000, warm_min_usd: 1, warm_max_hours: 8, warm_daily_usd: 2, warm_lead_min: 5, warm_after_stop_hours: 0,
  warm_rules: [], warm_allow_5m: false,
};
export const settings = (): Record<string, any> => ({
  ...DEFAULTS,
  ...Object.fromEntries((db.prepare('select key, value from settings').all() as any[]).map((r) => [r.key, JSON.parse(r.value)])),
});
export const putSetting = (k: string, v: unknown) =>
  db.prepare('insert into settings values (?, ?) on conflict (key) do update set value = excluded.value').run(k, JSON.stringify(v));
