# agent-router — research notes (session paused, plan not yet written)

## Prior art
- **VictorMinemu/CC-Router** — round-robin across Claude Max accounts. Tokens in
  `~/.cc-router/accounts.json` (access/refresh/expiresAt, atomic write). Proxies
  `POST /v1/messages` + `POST /v1/responses` (Codex), `GET /v1/models`. Cooldown on
  429/529, "least loaded" pick. TS/Node. Desktop app intercepted via **mitmproxy**
  (i.e. `ANTHROPIC_BASE_URL` alone did not cover the desktop app for them).
- **ccflare / better-ccflare** — same idea + SQLite request log + web dashboard,
  multi-provider (OAuth, console key, Bedrock, Vertex). Many forks.
- **musistudio/claude-code-router** — model-level routing control plane, not account pooling.
- **shoemoney/aigate** — hooks-based, deliberately no proxy.

Gap none of them fill: **joining proxy traffic to the session transcript.**

## Local facts (verified on this machine, CC 2.1.275)
Session JSONL: `~/.claude/projects/<slug>/<session-uuid>.jsonl`
- Row types seen: `user`, `assistant`, `attachment`, `custom-title`, `last-prompt`,
  `agent-name`, `atis-latch`, `queue-operation`, `file-history-snapshot`.
- Every row: `uuid`, `parentUuid` (linked list), `sessionId`, `cwd`, `gitBranch`,
  `timestamp`, `version`, `isSidechain`.
- **`assistant` rows carry `requestId` (e.g. `req_011CfQ3...`) → same value as the
  API `request-id` response header. This is the free join key between proxy log and
  transcript. No body fingerprinting needed.**
- `assistant` rows also carry `apiBlockIndex` (which 5h usage block) and full
  `message.usage`: `cache_read_input_tokens`, `cache_creation_input_tokens`,
  `cache_creation.{ephemeral_1h,ephemeral_5m}_input_tokens`, `output_tokens_details.thinking_tokens`,
  `service_tier`. Cache-miss analytics come straight from the transcript.
- Resumed sessions keep the **old** `sessionId` on old rows; new rows get the new one,
  chained via `parentUuid`. Readers must not filter by sessionId.

## The design conclusion reached before stopping
1. **The transcript is account-agnostic.** Switching accounts mid-session needs *zero*
   JSONL surgery. The thing that actually breaks is the **prompt cache** — it's scoped
   per org, so a switch = cold cache = one full `cache_creation` of the whole context
   (~25k+ tokens at 1.25x) paid on the very next request.
2. Therefore **round-robin is the wrong algorithm for Claude Code.** Correct policy is
   **sticky/cache-affinity**: pin a session to one account, stay until it 429s, then
   migrate and retry the same request on the new account, logging the migration cost.
3. That reframes the project: it's not a load balancer, it's a **cache-affinity router
   with a session-joined ledger**. The ledger (SQLite, joined on `requestId`) is what
   later feeds the UI, the shared remote pool/quotas, and the cache-miss recommendations.

## Open items for next session
- **P0 spike (blocks everything):** does the desktop app's Code tab honour
  `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json`, or is mitmproxy needed like CC-Router?
- Don't guess rate-limit header names — log all `anthropic-ratelimit-*` response headers
  verbatim into a raw JSON column in phase 1, then derive quota from what's actually there.
- Phase plan (P0 spike → P1 transparent proxy + SQLite → P2 sticky routing + cooldown →
  P3 JSONL tailer join → P4 read-only dashboard → P5 remote pool/quotas → P6 recommendations)
  still to be written out as PLAN.md.

## Flag
Anthropic's stated position is that routing Pro/Max subscription credentials through a
harness that spoofs the official client is against ToS (multiple Max subs themselves are
not). Your own accounts, your own machine — your call, just noting it once.

## P0 result (2026-09-25)
- Terminal CLI: `settings.json → env.ANTHROPIC_BASE_URL` works; requests hit the router. ✅
- Desktop Code tab: does **not**. The desktop spawns the stock CLI with `CLAUDE_CODE_ENTRYPOINT=claude-desktop`,
  and in that mode the CLI ignores settings-env `ANTHROPIC_BASE_URL` but honours a *process-env* one (verified
  with `claude -p` both ways). The desktop bundle forwards only an allowlist of harmless env vars from
  settings.json (timeouts/limits/telemetry; fn `CQ` in app.asar); base URL + credential vars are excluded, and
  a guard withholds the OAuth bearer unless the base URL passes a first-party check
  (`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` is its companion flag). Managed settings
  (`/Library/Application Support/ClaudeCode/managed-settings.json`) are referenced in the bundle — untested.
- Real rate-limit headers: `anthropic-ratelimit-unified-{5h,7d}-{reset,status,utilization}` (utilization 0–1,
  reset = epoch s) plus `unified-{status,reset,representative-claim,fallback-percentage,overage-status,overage-disabled-reason}`.
- Request body `metadata.user_id` is a JSON *string* `{"device_id","account_uuid","session_id"}` →
  `session_key = session_id`; `account_uuid` = home account. System blocks use `cache_control: {type:"ephemeral", ttl:"1h"}`.
- Ledger join verified: my two haiku probes' `request-id`s match the `requestId` in their session JSONL.
- **Option A (managed settings) — dead.** With `/Library/Application Support/ClaudeCode/managed-settings.json`
  setting `env.ANTHROPIC_BASE_URL` + `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, and after a full app restart,
  every child still spawns with `ANTHROPIC_BASE_URL=https://api.anthropic.com` and no requests reach the router.
  The desktop sets the child's base URL itself; neither user nor managed settings-env change it.
- Observed: the desktop main process has *no* `ANTHROPIC_BASE_URL` in its own env, yet children get one → the
  desktop injects it. Untested whether an inherited process-env value (e.g. `launchctl setenv` before launch)
  survives that injection. That is option D, cheaper than C and not a MITM — try before C.

## P2 credential store (from `strings` on CLI 2.1.268, `~/.local/share/claude/versions/2.1.268`)
- Login subcommand is `claude auth login` (there is no top-level `claude login`; it would be taken as a prompt).
- Store on macOS: Keychain first, plaintext `<config_dir>/.credentials.json` (mode 600) as fallback. Router reads the file first, then Keychain.
- Keychain item: account = `$USER` (or `claude-code-user` if it has odd chars), service =
  `"Claude Code" + OAUTH_FILE_SUFFIX + "-credentials" + hashSuffix`. `OAUTH_FILE_SUFFIX` is `""` in prod.
  `hashSuffix` is `""` when `CLAUDE_CONFIG_DIR` is unset, else `"-" + sha256(CLAUDE_CONFIG_DIR.normalize("NFC")).hex[0:8]`,
  hashed over the **raw env string** (no realpath). So the router must use the exact string the human passed; `login_cmd`
  uses the absolute path stored in `accounts.config_dir`. Default dir → `Claude Code-credentials` (confirmed present, account = $USER).
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides the hashed dir if set.
- CLI writes Keychain via `security -i` with `add-generic-password -U -a … -s … -X <hex>` on stdin (secret never in argv); router does the same.
- Refresh: `POST https://platform.claude.com/v1/oauth/token`, **JSON** body (not form) `{grant_type:"refresh_token", refresh_token,
  client_id, scope}`; public client id `9d1c250a-e61b-44d9-88ed-5944d1962f5e`; default scopes
  `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`. Response `{access_token, refresh_token?, expires_in}`.
  Refresh tokens rotate, so the router re-reads the store before refreshing and serialises refreshes per account.
- Open question: untested whether the API cross-checks `metadata.user_id.account_uuid` against the token. The router leaves it
  unchanged (it's the home account's uuid). If migrated requests 4xx, rewrite it.
- New oauth accounts start `needs_login=1`; `POST /router/accounts/:id/check` clears it once creds are readable/refreshable.
- **P2 e2e (2026-09-25):** fresh CLI session auto-landed on `acct-b` (least utilized, unknown=0) → rotation at the
  session boundary works with real accounts. Both requests 200 with the *home* account's `metadata.user_id`
  passed through unchanged → **the API does not cross-check `account_uuid` against the bearer; no rewrite needed.**
  acct-b's real utilization then read 26%/54% (5h/7d) vs home 17%/4%, so the next new session goes to home.
- **Option D (`launchctl setenv` + relaunch) — dead, but informative.** After relaunch the child inherited
  `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` (so the desktop *does* pass inherited env through) yet
  `ANTHROPIC_BASE_URL` still came out as `https://api.anthropic.com` → the desktop force-overrides that one
  variable specifically. Consequence for C: `launchctl setenv NODE_EXTRA_CA_CERTS ~/.agent-router/ca/ca.pem`
  **will** reach the desktop child, so the Bun-binary trust-store risk has a known fix. Only B (wrapper) or
  C (transparent) can put the desktop behind the router; C is decided.

## P0.5 build (2026-09-25)
- Router dials upstream with `node:https` by IP (c-ares `resolve4`, ignores /etc/hosts, 5-min cache) with SNI + Host
  `api.anthropic.com`, and pipes the raw response (gzip/content-length/chunked untouched). `/router/health` shows `upstream.ip`.
- **:443 binding:** macOS lets a non-root process bind ports <1024 only on the wildcard address; `127.0.0.1:443` and
  `[::1]:443` are EACCES. So the TLS listener binds `[::]:443` (dual-stack) and destroys any non-loopback peer on
  `connection`, before TLS. Verified: a connection to the LAN IP is dropped (curl exit 35). macOS firewall is off here;
  if it gets turned on it may prompt once for `node`.
- Certs: `~/.agent-router/ca/{ca,api.anthropic.com}.pem` (+ `-key.pem`, 600). Plist: `~/Library/LaunchAgents/com.agent-router.plist`
  (node = real fnm path, not the per-shell `which node` symlink; re-run `setup.sh` after deleting the plist if node moves).
- Verified without touching /etc/hosts: `curl --cacert ~/.agent-router/ca/ca.pem --resolve api.anthropic.com:443:127.0.0.1
  https://api.anthropic.com/api/hello` → 200 via the router; a real `claude -p` through `:4001` → 200, ledger rows written.

**The human runs (printed by `./setup.sh`, in order):**
```
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.agent-router/ca/ca.pem
printf '127.0.0.1 api.anthropic.com\n::1 api.anthropic.com\n' | sudo tee -a /etc/hosts
launchctl setenv NODE_EXTRA_CA_CERTS ~/.agent-router/ca/ca.pem
pkill -f 'node router.ts'; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-router.plist
# Quit and reopen the Claude desktop app
```
`launchctl setenv` does not survive a reboot; re-run line 3 (then relaunch the desktop app) after restarting. Undo: `./uninstall.sh`.

**Verify:** open a new desktop Code tab, say "hi". Take the last `assistant` row's `requestId` from that tab's
`~/.claude/projects/<slug>/<session>.jsonl` and find it in `curl -s localhost:4001/router/stats` (same `request_id`).
If the tab errors with a certificate failure, the CLI isn't seeing `NODE_EXTRA_CA_CERTS`; check `launchctl getenv NODE_EXTRA_CA_CERTS`.
- **P0.5 installed (2026-09-25):** `agent-router.sh install` ran clean; after app relaunch, desktop-tab traffic
  (model claude-fable-5-1) flows through the router on :443. The CLI child had **no** `NODE_EXTRA_CA_CERTS` in its
  env and TLS still validated → the Bun-based CLI trusts the System keychain; the launchctl step is a harmless no-op.
- **Desktop end-to-end (2026-09-25):** the desktop CLI gzips request bodies (`content-encoding: gzip`) — router now
  decodes a copy for parsing and forwards raw bytes. After that, desktop sessions pin normally. Switched a live desktop
  session (this one) home → acct-b via the API: the very next turn went out on acct-b (200), `migrations` row reason
  `manual`. The account switch is invisible to the desktop app; cost = one cache re-write of the session's context.

## P3 transcript join + console (2026-09-25)
- **User-agent shapes seen** (digits/hex masked, logged once per shape to router.log): `claude-cli/N.N.N (external, claude-desktop, agent-sdk/N.N.N)`
  for desktop tabs, and `curl/N.N.N` from probes. The parenthesised part is the CLI's `CLAUDE_CODE_ENTRYPOINT`, so a real terminal
  `claude` should read `(external, cli)` (not yet observed live). Gotcha: a `claude` spawned from *inside* a desktop session (e.g. an
  agent's Bash tool) inherits `CLAUDE_CODE_ENTRYPOINT=claude-desktop` and is counted as desktop. `ua_kind` = `desktop` iff the UA contains `claude-desktop`.
- **Transcript format facts the tailer handles:**
  - One API response = several `assistant` rows (one per content block: thinking / text / tool_use), all with the same `requestId`
    and the *same, final* `usage`. So the usage UPDATE is idempotent; tool_use names are keyed by the block `id` (insert-or-ignore).
  - Those rows land in the JSONL while the response is still streaming; the router only logs its row when the stream ends
    (observed gap up to ~177 s). A fixed 2 s retry misses these → unmatched recent rows wait in memory and join on the router's insert.
  - Subagent transcripts live at `<project>/<session>/subagents/agent-*.jsonl` (hence the recursive watch).
  - Side requests (title generation, suggestions: haiku, 1 message, 0 tools) never get an `assistant` row → stay unjoined ("—" in the UI).
  - Rows carry `entrypoint` (`claude-desktop`/`cli`) and `cwd`; the router fills `sessions.cwd` from `cwd`.
  - Names: `custom-title` rows (`customTitle`, last wins) → `sessions.title`, else the first `user` row with string content (reminders stripped, 60 chars);
    rows can precede the router's session row, so titles upsert. `agent-name` rows so far only appear in *main* files (= the session name), not subagent files.
  - Subagents: parent = the `<session>` dir; name = `agent-name` row, else `description` from the sibling `agent-<id>.meta.json`, else first prompt; their `requestId`s set `requests.agent_id`.
- **Fingerprint gotchas:** the CLI's first system block is `x-anthropic-billing-header: cc_version=…; cch=…` and changes per request —
  excluded from `system_hash` or every turn would look like a system-prompt change. The first user message is mostly
  `<system-reminder>` blocks; `first_user_hash` hashes the remaining typed text (falls back to all text).
- **Burst "previous request"** = previous request in the same *thread* (same session_key + first_user_hash), because a session's
  metadata session_id is shared by its subagents and side requests, which have different prefixes. A thread's first request is a
  cold start ("first turn, cold cache" on the turn), never a burst. Burst = `cache_create > max(8k, 2 × context added since the previous
  turn)` (context = joined in+read+create, else the byte estimate): it re-wrote old context, not just the new tokens. Replaced
  `> max(20k, 3 × session median)`, which flagged ordinary big turns on large sessions (9 of 10 read "context growth / unknown"). Account switch = migration row for the request *or* account differs from the previous turn
  (manual pins log their migration with request_id null).
- 7d projection uses the window's average rate so far (util × 7d / elapsed); a 60-min burn stretched over days projected 300%+.

## Advisor, switch cost, timeline (2026-09-25)
- **Actual switch cost:** `migrations.actual_cost_tokens` = `cache_create` of the first `/v1/messages` request (status < 400) in the
  session at or after the migration's ts, filled when the tailer joins that request (forced replays: `migrations.request_id` names it).
  Existing ledgers are backfilled once from joins already present. Live data: switching *back* to an account within the hour
  costs almost nothing (29–225 tokens) because that account's cache is still warm; real switches cost 4k–23k.
- **Timeline** (`/router/sessions/:key/timeline`) reuses `turns()` from console.ts, so it has the same thread-aware bursts and
  excludes failed attempts (a 429 before a replay is not a turn). A manual pin attaches to the first turn at or after it.
- **Advisor trigger:** after every usage join, for main-thread rows (`agent_id is null`) logged in the last 30 min:
  `pct = (in + cache_read + cache_create) / window(model)`. First time a session reaches `context_warn_pct` (0.7) or
  `context_urgent_pct` (0.85) → one `advice` row for that level; a level never repeats, `urgent` never downgrades to `warn`.
  The 30-min guard keeps a first scan of old transcripts from firing a Haiku call per old session.
- **Window:** longest matching prefix in `settings.context_windows`, else 1M if the model contains `[1m]`, else `default` (200k).
  The API body never carries `[1m]` (it's the CLI's alias; the body says e.g. `claude-opus-5-5`), so a request that succeeded
  with more context than its window is taken as proof of the 1M window. For 1M sessions below 200k that can't be known:
  set a prefix override (`{"claude-opus-5-5": 1000000}`) if you always run that model at 1M.
- **Breakdown** (deterministic, from `requests.jsonl_path` of the main transcript, since the last `compact_boundary`): each
  `tool_result` sized chars/4 (text blocks only; images not counted), keyed by its `tool_use` name + target (first string input,
  60 chars, for Read/Edit/Write/Grep/Glob/Bash; else the tool name). Sizes and names only, never result content.
- **Prompts** (verbatim in `advisor.ts`): the advice prompt ("You are advising a developer whose Claude Code session is at
  {pct}% …", then the breakdown JSON) and the handoff prompt ("Summarize this session for a fresh session …", then
  `{title, user_prompts (300 chars, reminders stripped, isMeta skipped), files_touched (Read/Edit/Write targets), last_assistant_text (3 × 500 chars)}`).
- **Subprocess:** `claude -p --model <advisor_model> --output-format text --no-session-persistence --tools ""`, prompt on stdin,
  cwd = tmpdir, 60 s timeout, env = the router's env minus every `CLAUDE_CODE_*` and `ANTHROPIC_*` (PATH/HOME kept). The extra
  two flags keep the call out of `~/.claude/projects` and stop Haiku from calling tools. The call itself goes through this
  router like any client (it shows up as a short untitled session). Binary: `CLAUDE_BIN` env, else `settings.claude_bin`, else
  `which claude`, else `~/.local/bin/claude` (launchd's PATH has no `~/.local/bin`, so the fallback is what runs there);
  shown in `/router/health`. Failure → advice stored with `text = null`, one log line, never a crash.
- Notification: `osascript display notification` on macOS unless `NOTIFY=0`.
- Dry run on a copy of the live ledger: real Haiku advice in ~11 s (two API calls, 0.9 s + 9.3 s), handoff in ~20 s.

## Live 429 drill (2026-09-25)
`POST /router/accounts/:id/fault429 {count}` makes the next N `/v1/messages` on that account behave as an upstream 429
(`retry-after: 60`) without dialing. Drill on a fresh Haiku session pinned to raymond: injected 429 → raymond cooled
60 s → replayed on acct-b (real API, 200, `retry_of` set) → migration `429`, est 62k → **actual 74 tokens** because
acct-b had a warm cache for the same prefix from other Haiku sessions within the hour. Prefix caches are per account,
not per session: the cheapest fallback is the account that recently served the same kind of session (unused signal).

## Proactive switch + notifications (2026-09-26)
- **Rule** (`router.ts proactive()`, before sending): a `/v1/messages` request whose session is pinned to a healthy A with
  `uA = max(util_5h, util_7d) >= proactive_switch_pct` (0.95) moves to the healthy B with the lowest `uB`, if `uB <= uA - proactive_min_gain`
  (0.2). No failed request, no cooldown (A is full, not broken); pin moves, `migrations.reason = proactive: A at NN%`. Unknown
  utilization = 0; `util()` now reads 0 for a window whose reset has passed (it never expired before), which also fixes stale
  headers in new-session placement and the Accounts/Cost views. Never under policy `manual`. Subagents share the session key, so
  they follow the pin. If B then 429s, the replay lands back on A and no migration is logged.
- **Ping-pong guard:** at most one proactive move per session per 10 min (last `proactive%` migration of that session in the ledger,
  so it survives restarts).
- **Notifications** (`advisor.ts notify()`, osascript; off via `settings.notify = false` or `NOTIFY=0`; no-op without `/usr/bin/osascript`;
  `NOTIFY_LOG=<file>` appends instead, for tests). Every fire also logs `notify: <msg>` to router.log. Fired on: proactive move,
  forced 429/529/401 replay (`home rate-limited — replayed ‘title’ on acct-b, home cools for 60 s`), unhealthy pinned account,
  context advice (existing), and the first time an account's window crosses `warn_pct`: one per account per window instance, keyed
  by the window's reset in `accounts.warned_5h / warned_7d`, so restarts don't repeat it. Manual pins don't notify (you did it).
- **Drill hooks** exist only with `DRILLS=1` in the router's env (404 otherwise): `fault429` and
  `POST /router/accounts/:id/fake-util {util_5h?, util_7d?, reset_in_s? = 3600}`, which merges synthetic `…-{5h,7d}-utilization/-reset`,
  `-5h-status: allowed`, `-status: allowed` into `last_ratelimit_json` (logged as `DRILL fake-util …`); the account's next real
  response overwrites it. `AGENT_ROUTER_DRILLS=1 ./agent-router.sh restart` writes `DRILLS` into the plist; a plain restart drops it.
- **Drill recipe:** `AGENT_ROUTER_DRILLS=1 ./agent-router.sh restart`; fresh `claude -p … --model haiku` (note: `~/.claude/settings.json`
  env beats the process env, so a dev router on another port needs `--settings '{"env":{"ANTHROPIC_BASE_URL":…}}'`); find its key/account
  in `/router/sessions`; `fake-util` A to 0.96 both windows; `claude -p --resume <key> …`; check ledger rows, `migrations`, the pin and
  `grep notify: ~/.agent-router/router.log`. Faking A moves *every* session pinned to A on its next request, not only the drill session.
- **Live drill (2026-09-26), policy `manual`, acct-b/raymond paused:** fresh session → home; fake-util home 0.96/0.96 → `notify: home at 96%
  of its 5h window, resets Sat 03:18`; resumed turn stayed on home (manual never moves), no migration; home's next real response put it
  back at 39%/16%. The proactive move itself is covered by the fake-upstream test only until a drill runs with a non-manual policy.

## Stream usage (2026-10-01)
- **Why:** usage columns were filled only by the tailer's transcript join, which lags (the row is written when the stream ends, the
  join later) and never happens for side requests and turns the CLI doesn't write to disk. On the live ledger that day: 105 of 149
  successful `/v1/messages` rows (70.5%) had usage. Budgets need it at the moment the response ends.
- **How** (`router.ts tapUsage()`): a second `data` listener on the upstream response next to `pipeline(up, res)`: the client's bytes are
  not delayed, re-chunked or altered (the SSE-verbatim and gzip-passthrough tests are unchanged). The copy goes through a streaming
  `createGunzip/Inflate/BrotliDecompress` when `content-encoding` says so, then:
  - `text/event-stream`: split on `\n`, keep only the current partial line; `data:` lines containing `"usage"` are parsed:
    `message_start` → `message.usage`, `message_delta` → `usage`, shallow-merged so the last value of each field wins (the delta carries
    the final `output_tokens`; `cache_creation.ephemeral_{1h,5m}_input_tokens` come from `message_start`).
  - anything else: body buffered up to 2 MB, top-level `usage` read at the end (only if the response completed).
  Only numeric fields are kept. Any parse failure → that row has no stream usage, one log line per process (never the content).
- The row gets `in_tok/out_tok/cache_read/cache_create/cache_1h/cache_5m` and `usage_src = 'stream'` in the same insert. The tailer still
  does everything it did (titles, agents, tool_uses, `agent_id`, `jsonl_path`, `thinking_tok`, advisor + switch-cost hooks) but its usage
  UPDATE is `coalesce(existing, transcript)` and sets `usage_src = 'transcript'` only when it filled. Rows from before the column were
  backfilled `'transcript'` once.
- **Dry run on a copy of the live ledger, real `claude -p` (CLI 2.1.x, haiku):** 12 of 12 `/v1/messages` rows through the new code had
  usage at log time, including the 6 one-message side requests that never reach a transcript (`in 900 / out ~9`). Real responses were
  uncompressed SSE; the gzip path is covered by the test only.
- A client that disconnects mid-stream leaves the `message_start` numbers (input and cache) with `output_tokens` as of that event.

## Budgets (2026-10-01)
- **Shape:** `settings.budgets = [{id, name, scope: all|project|account|session, match, period: day|week|session, limit, action: notify|stop,
  thresholds: [0.8, 1]}]`, validated on `PUT /router/settings` (400 `invalid_setting`). `scope: session` requires `period: session`
  (`match: null` = every session, each measured on its own: the runaway-agent guard). `period: session` also works with the other scopes
  (a per-session cap inside one project/account). Default `[]`, so nothing can stop until the user adds a budget.
- **Unit** (`console.ts UNITS()`, the only definition, a SQL expression): `in + 0.1·cache_read + 1.25·cache_5m + 2·cache_1h + 5·out`;
  a cache write without the 1h/5m split counts 1.25×. Dollars come only from `rate_card`, null if any model in the window has no rate.
- **Spend** (`console.ts budgetStatus()`): `sum(UNITS)` over `/v1/messages` rows with status < 400 in the window, grouped by session and
  model (top 3 sessions, dollars). day = since local midnight, week = rolling 7×24 h (no reset; `period_end: null`), session = the
  session's whole life. Computed on demand per request and per UI poll; ~3 ms per budget on a 25k-row ledger using the two existing
  indexes, so no new index. `// ponytail:` keep a running total per budget if the ledger gets large.
- **Project** = basename of `sessions.cwd`, which comes from the transcript. Observed live: a fresh `claude -p` session's cwd is not yet
  in the ledger when its first request arrives (it was ~2 s later, when the response ended), so a project budget does not stop a
  one-shot `claude -p`; a resumed or multi-turn session is stopped from its next request. `all`, `account` and per-session budgets have
  no such gap. Upgrade path if it matters: read the working directory from the request's system prompt.
- **Notify** (`router.ts budgetCheck()`, after every successful `/v1/messages` row is logged): thresholds crossed for the first time in the
  current period are inserted into `budget_events(budget_id, period_key, threshold, ts)` (`period_key` = local date / `rolling-7d` /
  session key; an event counts while `ts >= period_start`, so a rolling week re-arms 7 days after it fired) and one notification goes
  out for the highest: `Budget ‘climatefluent / day’ at 82% — 1.6M of 2M units`. Raising a limit mid-period does not re-arm.
  Spend is re-read on the next request, not when the tailer later fills a row the stream missed.
- **Stop** (`router.ts handle()`, before dialing; fails open on any error in the check): a matching `stop` budget at ≥ 100% →
  **HTTP 400** `{"type":"error","error":{"type":"invalid_request_error","message":…}}` plus `x-should-retry: false`, and a ledger row with
  status 400, the account it would have used, no `request_id`. `count_tokens` and every non-messages path are never checked.
- **Stop status, observed with real `claude -p` against the dev router:** 400 `invalid_request_error` → the CLI printed
  `API Error: 400 agent-router budget ‘budgetproj / day’ is spent: 10.98M of 50k input-equivalent tokens today. It resets Fri 00:00.
  Raise or remove it at http://localhost:4101/router/#cost`, exit code 1 after 2.6 s, `terminal_reason: "api_error"` in
  `--output-format json`. The ledger shows exactly one 400 row per request the CLI made (the title side request and the turn): no retry.
  429 was not tried: the CLI retries it with backoff, which is the loop this must avoid.
- **Clock:** `ledger.ts now()` = `Date.now()` + a skew that only `POST /router/clock {skew_ms}` (DRILLS=1) sets; request rows and budget
  windows both use it. The period-roll test moves it a day forward.


## Brain (2026-10-01)
Spec: `docs/BRAIN.md`. Code: `brain.ts` (+ hooks in router/tailer/console/advisor/ledger). Off by default; nothing is written until `brain_enabled`.
- **Tagging the router's own model calls.** `ANTHROPIC_CUSTOM_HEADERS` is honoured by CLI 2.1.268 (format `Name: value`, verified live against the
  dev router): `advisor.ts claude()` sets `x-agent-router-source: brain|advisor`, and both `/v1/messages` requests of a `claude -p` carried it
  (the `/api/hello` probe does not). The router stores it in `requests.source` and strips the header before dialing (it is in `SKIP_REQ`).
  Brain spend today = `sum(UNITS)` where `source = 'brain'` since local midnight. Rows with a `source` are left out of `turns()` (so out of
  Cache, Cost, one-shots, Insights, timeline) and out of the Sessions view; budgets still count them. No `--session-id` fallback was needed.
- **A bare `claude -p` is expensive, a lean one is not** (same one-line prompt, haiku, measured on the dev router):
  | flags | turn request | title request |
  | --- | --- | --- |
  | none (what the advisor used so far) | 21,019 tokens of prefix (cache write), 36 MCP tools | 899 in |
  | `--strict-mcp-config` | 7,674 (cache write), 0 tools | 899 in |
  | `--strict-mcp-config --disable-slash-commands --system-prompt …` | 1,758 in | 899 in |
  | `--safe-mode` | 3,343 in | 899 in |
  | `--safe-mode --system-prompt …` | 360–377 in | 899 in |
  | `--safe-mode --system-prompt … --name x` | 377 in | none |
  | … + `MAX_THINKING_TOKENS=0` | 347 in, 4 out (was 43–71 out) | none |
  The body dump showed why: plugin `SessionStart` hook output (5.3k chars of someone's style plugin) was being injected as a `<system-reminder>`
  into the advisor's prompt; the "title request" is the CLI naming the session, and it re-sends the *whole prompt* (5.4k and 7.4k tokens for a
  real classifier and writer call); thinking was on with a 32k budget; and the prompt was written to the 1h cache (2×) that a one-shot never
  reads. The runner now always passes `--safe-mode --system-prompt <one line> --name "agent-router <source>"` and sets `MAX_THINKING_TOKENS=0`,
  `DISABLE_PROMPT_CACHING=1`. This applies to the advisor too. `--safe-mode` still reads `env` from `~/.claude/settings.json` (checked with a
  throwaway HOME whose settings pointed at the dev port: the request arrived there), so CLI-only installs keep routing through the router.
- **Jev wire shapes, confirmed from docs.typesafe.ai (`/introduction/quickstart`, `/primitives/choice`, `/primitives/noul`):**
  `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, body `{state, model: "jev-latest", questions: {<id>: {type, instructions, criteria?}}}`.
  choice: `criteria` is an object `{option: description}`; answer `{type: "choice", choice, confidence, probabilities: {option: p}}`.
  noul: `criteria` is optional, an object `{true, false}`; answer is **only** `{type: "noul", noul: p}` (p of yes) — no `confidence`, no
  `probabilities` (BRAIN.md had assumed both). So `classify()` maps noul to `{value: p >= 0.5, confidence: max(p, 1 - p)}`. Response top level:
  `{model, answers, usage: {input_tokens, output_tokens}}`. Not stated in those pages: error bodies/status codes (any non-2xx or malformed
  answer falls back to the model backend) and whether a one-option choice is accepted (so `matches` is only asked once a skill exists).
  No TypeSafe key on this machine: Jev runs only against the fake server in the test. Its usage is not in units (another vendor's bill).
- **Model backend** returns the same `{answers: {key: {value, confidence}}}`; ```` ```json ```` fences and prose around the object are tolerated; an
  answer that fails validation (missing key, confidence outside 0–1, a choice not among the criteria) is no gate at all, logged once.
  First real run answered `reusable: false` with confidence 0.35 (it gave p(yes)); the prompt now says confidence is about the value given.
- **Gate rule:** pre-filter `tool_calls >= 8 and (files written or commands run)`; then the writer runs iff `kind != nothing` at
  `>= brain_confidence`; a skill is wanted only for `kind = skill` with `reusable = true` at that confidence and `matches = new` (or an unsure
  match). The writer's `skill` is dropped unless wanted. "Distill anyway" (`force`) skips both.
- **Capture reads** user rows minus `isMeta`/`isSidechain`/`isCompactSummary`/`isVisibleInTranscriptOnly`, minus rows whose `origin.kind` is not
  `human` (peer and task notifications), minus text starting with `<` (`<task-notification>`, `<command-name>`, `<bash-input>` …). A Bash
  command is listed only if its `tool_result` exists and is not `is_error`. Transcript path: `requests.jsonl_path`, else
  `<projects>/*/<session>.jsonl` by name (sessions from before the router, or never routed, have no joined request).
- **Dry run, dev router on a copy of the live ledger, real transcripts:** capture of everything: 49 sessions looked at, 42 notes written
  (the other 7 have no transcript on disk) in 0.43–0.47 s; vault 65 files, ~400 KB; no secret-shaped string in any note (the only `sk-ant` /
  `Bearer` hits were grep patterns the user had typed). One real session (climatefluent, 96 turns, 2.5M units, 146 tool calls):
  | run | classifier (haiku) | writer (sonnet) | wall |
  | --- | --- | --- | --- |
  | bare runner | 22,726 units (2 requests) | 28,123 units (2 requests) | 22 s |
  | lean runner | 5,526 units (5,151 in / 75 out, 1.6 s) | 10,865 units (6,870 in / 799 out, 9.2 s) | 14 s |
  | lean, forced (skill wanted) | — | 15,305 units (7,485 in / 1,564 out, 16.3 s) | 18 s |
  Gate (model): `reusable = false (0.85)`, `kind = project-knowledge (0.90)` → distilled, no skill asked for; 3 decisions, 3 learnings,
  5 open threads on the project note. The forced run produced a valid candidate (`verify-referral-links-after-route-change`). At ~16k units
  a session the 200k default cap is about 12 distills a day.
- **Not built:** the per-prompt recall hook (the `brain` skill is the recall path), bundled scripts in imported skills, vector search
  (search is a substring scan), automatic demotion (unused-for-30-days is a chip in the console).
