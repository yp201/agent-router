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
for (const c of ['config_dir text', 'cooling_reason text', 'last_status integer', 'last_ratelimit_json text', 'last_seen integer', 'needs_login integer default 0'])
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
const FP = ['system_hash', 'tools_hash', 'tools_count', 'msg_count', 'first_user_hash', 'first_user_tok', 'context_est', 'tool_names_json', 'ua_kind'];
for (const c of ['model_from_transcript', ...FP]) addCol('requests', `${c} ${/count|tok|est/.test(c) ? 'integer' : 'text'}`);
db.exec(`insert or ignore into accounts (id, kind) values ('home', 'home')`);

const cols = ['ts', 'request_id', 'session_key', 'account_id', 'method', 'path', 'model', 'status', 'latency_ms', 'stream', 'retry_of', 'ratelimit_json', ...FP];
const ins = db.prepare(`insert into requests (${cols}) values (${cols.map((c) => `:${c}`)})`);
export const logRequest = (row: Record<string, string | number | null>) =>
  Number(ins.run(Object.fromEntries(cols.map((c) => [c, row[c] ?? null]))).lastInsertRowid);

// Settings: JSON per key, defaults here. Unknown keys are rejected by the PUT handler.
export const DEFAULTS: Record<string, any> = {
  warn_pct: 0.8, route_cutoff_pct: 0.9, weekly_reserve_pct: 0.2,
  policy: 'sticky_least_utilized', // | 'prefer_home_until_80' | 'manual'
  rate_card: {},                   // { [model]: { input, output, cache_read, cache_write } } in $/Mtok
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
};
export const settings = (): Record<string, any> => ({
  ...DEFAULTS,
  ...Object.fromEntries((db.prepare('select key, value from settings').all() as any[]).map((r) => [r.key, JSON.parse(r.value)])),
});
export const putSetting = (k: string, v: unknown) =>
  db.prepare('insert into settings values (?, ?) on conflict (key) do update set value = excluded.value').run(k, JSON.stringify(v));
