create table if not exists accounts (
  id                  text primary key,     -- short label, e.g. "home", "acct-b"
  kind                text not null,        -- 'home' (inbound bearer passthrough) | 'oauth' (CLI credential store in config_dir)
  config_dir          text,                 -- CLAUDE_CONFIG_DIR the human ran `claude auth login` with; NEVER the token itself
  disabled            integer default 0,
  cooling_until       integer,              -- epoch ms
  cooling_reason      text,
  last_status         integer,
  last_ratelimit_json text,                 -- anthropic-ratelimit-* from the last response served by this account
  last_seen           integer,              -- epoch ms
  needs_login         integer default 0,
  note                text
);
create table if not exists sessions (
  session_key     text primary key,         -- metadata.user_id.session_id, else sha256(system[0] + first user text)[:16]
  account_id      text,                     -- the pin
  created_ts      integer, last_ts integer,
  request_count   integer default 0,
  forced_switches integer default 0,
  last_model      text,
  cwd             text,                     -- from the transcript (P3)
  title           text                      -- transcript custom-title, else first typed prompt (60 chars)
);
create table if not exists requests (
  id             integer primary key,
  ts             integer not null,
  request_id     text unique,         -- upstream `request-id` header (join key)
  session_key    text,
  account_id     text not null,
  method         text, path text,
  model          text,
  status         integer,
  latency_ms     integer,
  stream         integer,
  retry_of       integer,             -- requests.id of the failed attempt this request replayed
  ratelimit_json text,                -- all anthropic-ratelimit-* headers, verbatim
  jsonl_path     text, session_id text, api_block_index integer,
  in_tok integer, out_tok integer, cache_read integer, cache_create integer,
  cache_1h integer, cache_5m integer, thinking_tok integer, model_from_transcript text,
  usage_src text,                     -- 'stream' (read from the proxied response) | 'transcript' (filled by the tailer)
  -- request fingerprints (P3), /v1/messages only; hashes = sha256 hex[:16], never body text
  system_hash text, tools_hash text, tools_count integer, msg_count integer, -- tools_hash: names of the loaded (not defer_loading) tools
  tools_loaded integer, tools_deferred integer, tools_tok integer, -- definitions in the prefix / marked defer_loading / loaded definitions' JSON bytes / 4
  effort text, speed text, beta_hash text,  -- output_config.effort (else thinking.budget_tokens); body `speed`; hash of the sorted anthropic-beta list
  image_count integer, cli_version text,    -- image blocks in messages; claude-cli/<version> from the user-agent
  first_user_hash text,               -- first user message minus <system-reminder> blocks (thread id + preamble detection)
  first_user_tok integer,             -- its length / 4
  context_est integer,                -- decoded body bytes / 4
  tool_names_json text,               -- tool names only (no schemas), stored the first time a tools_hash is seen
  ua_kind text,                       -- 'desktop' | 'cli' from the inbound user-agent
  agent_id text,                      -- subagent that made it (from <session>/subagents/agent-<id>.jsonl); null = the session itself
  source text                         -- inbound x-agent-router-source ('brain' | 'advisor'): the router's own model calls; null = a client
);
create table if not exists migrations (
  ts integer, session_key text, from_account text, to_account text,
  est_cost_tokens integer,            -- ESTIMATE: request body bytes / 4; P3 replaces with transcript cache_creation
  request_id text,
  reason text,                        -- '429 five_hour' | 'unhealthy: cooling' | 'manual' ...
  actual_cost_tokens integer,         -- cache_create of the first /v1/messages request after the switch (from the transcript)
  actual_request_id text
);
create index if not exists requests_session_ts on requests(session_key, ts);
create table if not exists agents (agent_id text primary key, session_key text, name text, first_ts integer, last_ts integer); -- subagents
create table if not exists tool_uses (id text primary key, request_id text, name text, arg text); -- tool_use blocks from transcripts; arg = skill name, Skill tool only
create table if not exists tail_offsets (path text primary key, offset integer);   -- tailer resume points
-- context advisor: one row per session per level ('warn' | 'urgent'), plus 'handoff' summaries; names/targets/sizes only, never tool output
create table if not exists advice (id integer primary key, session_key text, ts integer, level text, pct real, context_total integer, window integer,
  breakdown_json text, text text, model text, request_id text);
create table if not exists settings (key text primary key, value text);             -- JSON values; defaults in ledger.ts
create index if not exists requests_ts on requests(ts);
-- budgets (settings.budgets): one row the first time a budget crosses a threshold in a period; dedupes notifications, doubles as history
create table if not exists budget_events (budget_id text, period_key text, threshold real, ts integer);
-- brain (brain.ts): what was captured / gated / distilled per session, and every skill candidate it knows
create table if not exists brain_sessions (session_key text primary key, last_captured_ts integer, note_path text, gate_json text, gate_backend text,
  gated_ts integer, distilled_ts integer, skill_candidate text, queued integer default 0, trivial integer,
  scan_usd real, extract_usd real); -- what the classifier / writer call for this session cost (brain-tagged spend while it ran); null = not measured
create table if not exists brain_skills (name text primary key, status text, -- 'candidate' | 'promoted' | 'rejected'
  source text, source_session text, created_ts integer, promoted_ts integer);
