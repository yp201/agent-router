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
  -- request fingerprints (P3), /v1/messages only; hashes = sha256 hex[:16], never body text
  system_hash text, tools_hash text, tools_count integer, msg_count integer,
  first_user_hash text,               -- first user message minus <system-reminder> blocks (thread id + preamble detection)
  first_user_tok integer,             -- its length / 4
  context_est integer,                -- decoded body bytes / 4
  tool_names_json text,               -- tool names only (no schemas), stored the first time a tools_hash is seen
  ua_kind text,                       -- 'desktop' | 'cli' from the inbound user-agent
  agent_id text                       -- subagent that made it (from <session>/subagents/agent-<id>.jsonl); null = the session itself
);
create table if not exists migrations (
  ts integer, session_key text, from_account text, to_account text,
  est_cost_tokens integer,            -- ESTIMATE: request body bytes / 4; P3 replaces with transcript cache_creation
  request_id text,
  reason text                         -- '429 five_hour' | 'unhealthy: cooling' | 'manual' ...
);
create index if not exists requests_session_ts on requests(session_key, ts);
create table if not exists agents (agent_id text primary key, session_key text, name text, first_ts integer, last_ts integer); -- subagents
create table if not exists tool_uses (id text primary key, request_id text, name text); -- tool_use blocks from transcripts
create table if not exists tail_offsets (path text primary key, offset integer);   -- tailer resume points
create table if not exists settings (key text primary key, value text);             -- JSON values; defaults in ledger.ts
create index if not exists requests_ts on requests(ts);
