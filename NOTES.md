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
- **Unit** — superseded the same day by dollars at list price (see "Cost insights" below; `limit` is now USD, messages read
  `$1.65 of $2.00`). What this section measured in "units" was `in + 0.1·cache_read + 1.25·cache_5m + 2·cache_1h + 5·out`, which is
  exactly Haiku 4.5's price list × 1e6 and wrong for every other model.
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

## Cost insights (2026-10-01)
Spec: `docs/COST-INSIGHTS.md`. Code: `console.ts` (prices, `cost()`, `why()`, `ttlFit()`, `whatIf()`, `insights()`), `router.ts` (`fingerprint()`,
`coldTick()`), `advisor.ts` (`carrying()`), `brain.ts` (one-shot filter). No model call anywhere in it.
- **Unit: dollars at list price.** `console.ts PRICES` ($/MTok input / 5m write / 1h write / read / output, `PRICES_AS_OF = '2026-10-01'`),
  matched by substring of the model id, first hit wins (`opus-5-5` before `opus-5`). `cost(row)` is the only pricing function: budgets,
  brain cap (`brain_daily_usd`, default 1.00; a stored `brain_daily_units` is ignored), Cost tab, bursts, insights. `rate_card`
  (`{ [substring]: { input, write_5m, write_1h, read, output } }`) overrides the fields it names. A cache write without the 1h/5m split is
  priced at the 5m rate. A model with no price (seen here: `claude-opus-4-6`, and rows with no model) costs `null`: counted as
  "unpriced", never summed. Body `speed: "fast"` on Opus 5.5 doubles input and output (not observed live yet).
- **Fingerprint fields confirmed from real requests** (terminal CLI 2.1.268 through a header-logging forwarder in front of the dev router):
  | stored | where it comes from |
  | --- | --- |
  | `effort` | body `output_config.effort` (`"high"` on Sonnet 5, sent with `thinking: {type: "adaptive"}`); Haiku 4.5 sends no effort but `thinking: {type: "enabled", budget_tokens: 31999}`, so the budget is stored instead |
  | `speed` | body `speed` (absent in every request seen; fast mode was never on) |
  | `beta_hash` | header `anthropic-beta`, comma list, sorted then hashed. Seen: `claude-code-20250219, oauth-2025-04-20, interleaved-thinking-2025-05-14, thinking-token-count-2026-05-13, context-management-2025-06-27, prompt-caching-scope-2026-01-05, mid-conversation-system-2026-04-07, advisor-tool-2026-03-01, effort-2025-11-24, extended-cache-ttl-2025-04-11`, plus `advanced-tool-use-2025-11-20` only when tool search is on and `structured-outputs-2025-12-15` on the title side request |
  | `cli_version` | header `user-agent`: `claude-cli/2.1.268 (external, sdk-cli)` |
  | `image_count` | `image` blocks in `messages[].content`, including inside `tool_result.content` |
  | `tools_loaded` / `tools_deferred` / `tools_tok` | `tools[]` entries without / with `defer_loading: true`; JSON bytes of the loaded ones / 4 |
  | TTL used | response usage `cache_creation.ephemeral_1h_input_tokens` vs `ephemeral_5m_input_tokens` (already stored as `cache_1h` / `cache_5m`). Request side: `cache_control: {type: "ephemeral", ttl: "1h"}` on the last two system blocks and the last message block |
  Last 7 days here: the main conversation wrote only 1h caches, subagents only 5m (no turn mixed the two).
- **Deferred-tool flag: `defer_loading: true`.** With `ENABLE_TOOL_SEARCH=true` the CLI sent 12 `tools` entries instead of 68: 11 plain ones
  (among them a client tool named `ToolSearch`) and one `DeferredToolPlaceholder` carrying `defer_loading: true`. After the model called
  `ToolSearch`, the next request listed the found MCP tool as a 13th entry, also `defer_loading: true`; the old all-names `tools_hash`
  changed, yet that turn read the whole prefix from cache (read 31,509 = the previous 23,748 + 7,761; wrote 1,419). So deferred
  definitions are not part of the cache key: `tools_hash`, `tool_names_json` and `tools_tok` cover loaded definitions only, and the
  unused-tools insight counts loaded tools only (rows from before `tools_loaded` are used only while nothing newer is in the window).
- **Tool search behind a custom base URL, verified.** Same prompt, Haiku, dev port: without the variable 68 definitions, no `ToolSearch`,
  `tools_tok` 34,331, cached prefix 50,709 tokens; with `"ENABLE_TOOL_SEARCH": "true"` in the settings `env` 12 definitions (11 loaded +
  1 deferred), `tools_tok` 10,575, prefix 23,786. The CLI binary carries the message: `[ToolSearch:optimistic] disabled: ANTHROPIC_BASE_URL=…
  is not a first-party Anthropic host. Set ENABLE_TOOL_SEARCH=true`. This machine's own `~/.claude/settings.json` still has only the base
  URL; the A7 finding flags its terminal sessions.
- **Rewrite causes** (`why()`, previous request of the same thread, first match wins): account switch → model changed → fast mode on →
  effort changed (not on Opus 5.5 / Sonnet 5.5 / Fable 5.1: `EFFORT_KEEPS_CACHE`) → loaded tool set changed → system prompt changed →
  images removed → message count dropped (compaction: "expected rebuild") → gap > lifetime (60 min after 1h writes, 5 min after 5m) →
  request body got smaller (also "expected rebuild", see below) → CLI version changed → unexplained. Avoidable = model, fast, effort, tools.
  Editing CLAUDE.md is not a cause: it neither applies nor invalidates mid-session. On the last 7 days (57 re-writes):
  | | before | after |
  | --- | --- | --- |
  | idle / lifetime expired | 20 (only gaps > 1h) | 38 (13 on 1h, 25 on 5m) |
  | account switch | 8 | 8 |
  | model changed | — | 2 (Fable 5.1 → Opus 5.5, $8.43) |
  | expected rebuild | — | 4 |
  | unknown / unexplained | 29 | 5 ($2.28) |
  The four rebuilds had a growing message count and a *smaller* body (two subagents whose body lost a third of its bytes; two main
  turns 8 and 12 minutes after the one before, a few hundred tokens smaller): the client had cleared something out of the history, so the
  spec's "message count dropped" alone missed them. That rule sits after the lifetime check so a cold cache is never called a rebuild.
- **Lifetime fit, same 7 days:** main conversation actual $391.78 on 1h, $632.34 on 5m (+61%; 64 of 1,429 turns followed a 5–60 min
  pause). Subagents actual $176.30 on 5m, $170.40 on 1h (−3%; 22 of 1,747 turns): under the 5% bar, so "keep".
- **Going cold:** `warmth()` = a session's last main turn (no `agent_id`, a tool list) + the lifetime of its last cache write;
  `coldTick()` every 60 s (`COLD_TICK_MS` in tests) notifies once per idle period, keyed in memory by that turn's timestamp.
- **A6 idle fires: not shipped.** 167 transcripts hold no marker for a scheduled, loop or goal check-in turn: no `/loop` or schedule
  `command-name`, no Cron/ScheduleWakeup tool call, and `origin.kind` on user rows is only `human`, `task-notification`, `coordinator` or
  `peer`. `queue-operation` rows (enqueue/dequeue/remove) carry typed prompts, `<task-notification>`, `<bash-input>` and `<agent-message>`,
  i.e. queued user input and subagent results, not timers. Without a marker it would be a guess from gaps, so it was left out.
- **Brain noise:** capture skips sessions with fewer than 2 typed prompts and fewer than 3 tool calls. On the copy of the live vault the
  next idle pass removed 22 of 42 notes (all one prompt, at most two tool calls: `reply with exactly: ok` probes and the like); the 20
  left include two-prompt drills, which the rule keeps. `brain_sessions.trivial`: null = not judged yet (judged once), 1 = one-shot.


## Brain pipeline, graph, Obsidian link (2026-10-01)
Code: `brain.ts` (`pipeline()`, `batch()`, `graph()`, `open()`, `gate1()` split out of `distill1()`), `ui.html` (Brain views Pipeline · Notes · Graph).
- **Scan and extract are separate calls now.** `POST brain/scan` = pre-filter + classifier, stored; `distill` reuses a stored scan only if no
  writer has used it and it is newer than the session's last turn (so "Distill again" and the idle tick still re-gate, and the 3×(classifier +
  writer) count in the existing test holds). A scan over the cap is a 409, never queued: the tick would run the writer on a queued session.
- **Cost per step** is the brain-tagged spend logged between the call's start and end (`scan_usd`, `extract_usd`), a window rather than a
  per-call tag: two brain calls at once would both be counted in each. The estimate in the confirm is count × the mean of the last 20.
  Sessions distilled before this have no measured cost, so the first estimate is empty.
- **Pre-filter in the pipeline view** is read off the note (`## Tools` counts, non-empty Files/Commands lists), not the transcript: same
  verdict as `distill`, no transcript read per poll. Both views read every note per poll; fine at this size, marked `ponytail`.
- **Provenance was one-way.** The session linked `skills/candidates/<name>/SKILL`, the skill linked nothing. Now `skills/<name>.md` exists
  for a candidate that has a source session and links the session, the project and the SKILL.md; the session's line points at that note and
  is rebuilt from `brain_skills` on every `index()`. An imported candidate still has no note (nothing to point at), which keeps "demote
  removes the note" true for imports.
- **Graph layout:** first constants (repulsion 2400/d, no cut-off, gravity 0.02) spread 40 notes over 3,500 units; with a 200-unit cut-off,
  300/d, springs of 35 and gravity 0.06/0.1 (x/y) the live vault is 540 × 360. Measured in the browser: 40 notes 1–6 ms (38 ms cold),
  200 synthetic notes 25–37 ms, 500 notes 123 ms; drawing 200 notes 2 ms. Type tags (`session`, `project`, `daily`, `skill`) and the
  project's own tag are not drawn as tag nodes.
- **Obsidian** is not installed here: `obsidian://` did nothing. The button now goes through `POST brain/open`; the test puts a fake `open`
  first on PATH, so no window opens.
- **Dry run on a copy of the live vault and ledger:** pipeline 20 captured / 5 scanned / 3 extracted / 1 candidate / 0 promoted, 8 to scan;
  graph 55 nodes (20 sessions, 10 projects, 9 days, 1 candidate, 15 tags) and 57 edges (21 project, 20 day, 15 tag, 1 source); the candidate
  has 2 edges (its session, `reel-radar`). One real scan with the tightened question (a 176-tool-call publish-and-deploy session, Haiku 4.5,
  3,135 in / 110 out, $0.0037, 3.5 s): `reusable = true (0.85)`, `kind = skill (0.80)`, `matches = incremental-prototype-with-real-data-eval (0.75)`,
  so no new skill is asked for.
- **Not built:** touch-screen pinch is handled, but there is no keyboard navigation of the graph; nodes can be un-pinned only all at once
  (Reset layout); scan-all does not resume after a restart (the progress is in memory).


## Limits as the unit, keep warm, tool loading, facts switch (2026-10-01)
Spec: `docs/COST-INSIGHTS.md` "Next". Code: `console.ts` (`limits()`, `asLimits()`, `limText()`, `warmPlan()`, `warmQuote()`, `ruleEnd()`, `toolsView()`),
`router.ts` (`keep()`, `ping()`, `warmTick()`, the per-server fingerprint), `brain.ts` (`loadFacts()`), `advisor.ts` (`claudeHome()`).
- **Limits estimator, on this machine's ledger** (14 days, grouped by each window's `…-reset` header; utilization comes with two decimals,
  so movement is whole points): home $0.89 per 1% of 5h (7 windows, $297 on 335 points) and $4.85 per 1% of the week (2 windows, $335 on
  69 points) over 2,522 requests; yp-2 $1.22 and $7.43 (1,740 requests, 5 + 1 windows): both `ok`. acct-b (removed since): 43 points of 5h
  on $0.51 → $0.012 per point, `low` ("not enough traffic through the router yet": under $20). The "used outside the router" flag needs at
  least two qualifying windows, since it compares the latest window with the account's own median. One scan is 24 ms on 27k rows
  (SQLite reads the JSON); memoised until the next request is logged.
- A dev router on a *copy* of the ledger sees home's windows move from the live router's traffic: its own estimate drifts down ($0.86)
  exactly as an account used elsewhere would. Expected; the live ledger sees all of it.
- **Budgets in %:** `unit: pct_7d | pct_5h`; `spent` is then percentage points (`spent_usd` keeps the dollars), state `waiting` until the
  account has a rate. A low-confidence rate still fires (the row and the message show the dollars beside it).
- **Keep warm — the proof** (dev router, real `claude -p --model sonnet` sessions, `FORCE_PROMPT_CACHING_5M=1` so every write was
  `ephemeral_5m`; dev settings `warm_allow_5m`, `warm_lead_min: 1`, `warm_min_context: 3000`; context 64k tokens):
  | | ping | turn 2 (`--resume`) at 7 min: cache read / cache write |
  | --- | --- | --- |
  | scheduler ping (variant a) at 4:06 | read 64,067 · wrote 0 · in 2 · out 2 · 1.9 s | **64,067 / 41** |
  | drill ping with `max_tokens: 1` (variant b) at 4:02 | read 64,165 · wrote 0 · in 2 · out 1 · 1.5 s | 64,165 / 36 |
  | control, no ping | — | **0 / 64,107** |
  So a ping keeps the cache: $0.013 for the read against $0.16 for the 5m re-write on Sonnet 5.
- **Ping variants.** (a) identical bytes, socket destroyed once `message_start`'s usage is read; (b) the same body with `max_tokens`
  replaced by 1 and read to the end. Both got a 200 and a full cache read, and both refreshed the cache. (b) was accepted with 1 even on
  Haiku 4.5's request with `thinking.budget_tokens: 31999` (out 1, 0.7 s; (a) on the same request: out 4 at `message_start`, 0.8 s). The
  difference is a few output tokens (under $0.0001 a ping on any model) and half a second. **Shipped: (a).** It replays what was sent,
  byte for byte, so it needs no parsing and works for the desktop's gzipped bodies; (b) has to edit (and for gzip re-encode) the body.
  What an aborted stream is billed for after `message_start` is not observable from here; the row logs the `message_start` usage.
- **Header set.** The ping sends exactly what `send()` sent for the kept request: every inbound header except the hop-by-hop ones
  (`SKIP_REQ`), plus `host`, `content-length`, and the `authorization` of the account it went to. From the terminal CLI that is `accept`,
  `authorization`, `content-type`, `user-agent`, `x-claude-code-session-id`, `x-stainless-*`, `anthropic-beta`, `anthropic-version`,
  `anthropic-dangerous-direct-browser-access`, `x-app`, `accept-encoding`. No smaller set was tried: with the full set the read was complete.
  For an oauth account the kept token is replayed as is (no refresh: a ping must not be able to mark an account `needs_login`); if it has
  expired the ping gets a 401 and that session's warming stops until its next request, like home.
- **Thread identity** is the burst code's: session key + `first_user_hash` (model when there is none). In the runs above each `claude -p`
  session made three requests: the title side request (no tools, its own first-user hash: never held) and two turns of the main thread
  (held, replaced by the newer one). A thread is known to be a subagent's once the tailer has joined one of its rows to a
  `subagents/agent-*.jsonl` transcript (`agent_id`), which happens when that row is logged; from then on it is not held. A subagent's
  *first* request is held if it is large enough (nothing in the request marks it), but the scheduler only looks up the thread of the
  session's last main turn (`warmth()`), so it is never pinged and ages out of the 20 slots. After a compaction the first user message,
  and so the thread, changes: the old entry is left to age out the same way.
- **What a ping touches:** one `requests` row (`source = 'warm'`, no fingerprint) and the account's `last_ratelimit_json`. Not
  `sessions` (pin, `last_ts`, `request_count`), not `migrations`, not `cool()`, not `warnCheck()`, not the budget stop, not `joined()`.
  `turns()` already left out rows with a source; the Sessions list and brain capture used `source is not null` to hide the router's own
  sessions and now exclude `warm` from that test. `warmth()` adds the last 2xx ping after the last real turn to `cold_at`.
- **Scheduler state is the ledger.** `warmPlan()` derives cover, stop reason and next ping from rows + settings + whether the request is
  in memory, so a failed ping "stops until the next real request" with no flag to clear. `warm_sessions.reason` is a record for one-offs
  (and `stopped by you` with `until_ts = 0` is the Stop button, which also blocks rule cover until the next request).
- **Nothing is held while `warm_enabled` is false** (the spec holds always): a default-off feature should not keep request bodies and
  bearer tokens in memory. Cost: after switching it on, a session is first pinged after its next request.
- **Not verified:** a 1-hour lifetime was not waited out (the 5m run shows the mechanism); a ping against a rate-limited account.
- **Tool loading — what requests carry.** Terminal CLI behind the dev port (tool search off): 64 definitions, all loaded: 28 built-in
  (22k tokens), `analytics-mcp` 9 (3.8k), `claude_ai_Google_Drive` 11 (3.8k), `claude_ai_Claude_Docs` 8 (1.2k), `ghg-calculator` 8
  (1.2k). Desktop requests list deferred MCP definitions in `tools` with `defer_loading: true` (45 loaded + 24 deferred seen), so their
  sizes are known; the terminal CLI with tool search on sends a `DeferredToolPlaceholder` and adds a server's definitions only once a
  search found them, so a never-searched server is invisible in requests and appears only if a config file names it.
  `tool_servers_json` is new: sessions from before this build have calls but no load state ("recorded from the next request on").
- **"Now" and the dollars.** The state of a scope is the newest recorded tool list of a main conversation in it. A loaded server's
  cost counts only the turns of sessions whose recorded list had it loaded; the first version multiplied by every turn of the scope
  and put $3.24 on a connector that only the terminal probes had loaded. Always-load's cost is the hypothetical: every turn of the scope.
- **Where a server lives:** `~/.claude.json` → `projects[cwd].mcpServers` (local), `<cwd>/.mcp.json` (project), top-level `mcpServers`
  (user), matched on the name with everything outside `[A-Za-z0-9_-]` as `_`. Here: `analytics-mcp` and `ghg-calculator` at user scope.
  `plugin_*` = a plugin's server, `claude_ai_*` or a UUID = a claude.ai connector, anything else = the app or a config not read.
- **Facts switch.** `~/.claude/CLAUDE.md` on this machine is the single line `@~/agent-router-brain/CRITICAL_FACTS.md`; the switch reads
  "on". `CLAUDE_HOME` stands in for `~/.claude` (and `${CLAUDE_HOME}.json` for `~/.claude.json`) in development and tests.

## Brain units: subagent runs and task segments (2026-10-01)
Spec: `docs/BRAIN.md` "Units". Code: `brain.ts` (`read()`/`digest()` replace the one-pass `extract()` body; `units()`, `unit()`, `segments()`, `keep()`,
`refine()`), `ledger.ts` + `schema.sql` (columns on `brain_sessions`, `brain_skills.update_ts`, table `skill_sources`), `ui.html`.
- **Why.** "Google Docs link" was scanned `reusable = false (0.95)`: its note listed 29 subagents by name and the last 80 of 814 main-thread
  tool calls, while the subagents ran 1,608 tool calls, 154 of them ffmpeg-type commands.
- **Units are rows of `brain_sessions`**, not a new table: `kind`, `parent`, `agent_id`, `seg_index`, `name`, `started` added with `alter table`;
  the key is `<session>/<agent id>` or `<session>/seg-<n>`. Old rows are `kind = 'session'` and keep their state with no copy. Every query that
  means "sessions" now says `parent is null`; a unit's project comes from its parent (`coalesce(b.parent, b.session_key)`).
- **A subagent transcript** is all `isSidechain` rows; its first user row is the brief, the reminder and image rows are `isMeta`, follow-up
  messages carry a non-human `origin`. 28 of 29 runs end with a `SubagentHandback` tool call whose `message` is the report, followed by a
  one-line assistant text, so the final report is the last handback when there is one.
- **`matches` is weak on a small model.** With one existing candidate (a yt-dlp/Python prototype skill) Haiku matched 9 of 28 skill-kind units
  to it at 0.70–0.85, two trailer builds among them. "When unsure, answer new" took that to 4; listing each skill's main tools moved one more
  and was removed again. So the writer has the last word: in refine mode it gets the matched `SKILL.md` and answers under the same name only
  if it is the same procedure; a new name is a new candidate. In the run below no trailer unit ended up in the prototype skill.
- **Scan-all then extract-all cannot merge siblings by itself**: every unit is scanned before any skill exists. A unit whose stored scan asked
  for a skill is scanned again at extract time when a skill has appeared since (one more classifier call, about half a cent).
- **Writers copy shell escapes into JSON.** The four longest skill bodies (ffmpeg filters with `\:`) failed `JSON.parse`; `json()` now retries
  with unknown backslash escapes doubled. Three of the four then parsed, the fourth parsed on the next run.
- **Dry run, dev router on a copy of the live vault and ledger, that one session, real models through :4101:**
  | step | units | result | cost (list price) | wall |
  | --- | --- | --- | --- | --- |
  | capture | 28 subagent + 22 segment notes; 1 subagent of 6 tool calls stays a name | vault 424 → 1,008 KB, 54 → 104 notes | free | 0.5 s |
  | scan (Haiku 4.5) | 49 (1 failed the pre-filter: no command, no file) | 28 `kind = skill` and reusable (0.75–0.92), 21 project-knowledge (0.75–0.92), 0 nothing | $0.24 | 143 s |
  | extract (Sonnet 5) | 49 | 12 skills created, 10 refinements, 22 units tied to a skill | $1.84 incl. re-scans and 5 unparsed answers | 17 min |
  Skills: `canvas-rendered-explainer-video-with-ffmpeg` (CBAM explainer video; refined by the R1 cohort trailer, the JS-canvas rebuild and
  trailer v3), `clone-voice-with-qwen3-tts-mlx` (segment 11; refined by the Qwen3-TTS setup and the voice clone),
  `re-voice-video-with-tts-and-music-bed`, `self-contained-html-tool-with-site-styling-and-playwright-tests` (+2 refinements),
  `integrate-cashfree-payment-links-and-webhook` (+2), `add-gst-invoice-gen-to-cloudflare-lms` (+1), `canvas-social-cards-with-playwright-core`,
  `fact-grounded-outreach-kit-from-site-source`, `before-after-clutter-audit-for-responsive-copy`, `local-role-based-redteam-for-cloudflare-lms`,
  `promote-redesign-shot-to-production-paths`, `ai-image-realism-review-and-site-integration`. All carry Prerequisites, Steps, Pitfalls, Verify.
  Pipeline endpoint with 106 units: 26–32 ms. Each dev `claude -p` also sends one `HEAD /api/hello` through the transparent :443 path, which the
  live router logs as a zero-token brain-tagged row; every `/v1/messages` call went to :4101.
- **The default $1 daily cap is below one such session** ($2.1 here): the batch stops at the cap and does not resume by itself.
- **Not built:** `status = 'update'` as a status (it is `update_ts` on a promoted skill, so every `status = 'promoted'` check stays true);
  automatic extraction of units on idle (`on_idle` still covers sessions only); cleaning up unit rows whose transcript is gone; a unit note the
  user moved is written again rather than found by its `unit` key; a segment's turns and dollars are the ledger rows inside its time window.

## Agent trace (2026-10-01)
Spec: `docs/BRAIN.md` "Trace". Code: `trace.ts` (new: `trace()`, `minimal()`, `md()`), `brain.ts` (`input()` feeds the gate and the writer, `traceLine()`, `mainPaths()`, `pipeline().stopped`, `known()`),
`router.ts` (`json()` takes headers, `page()` and `health.build`), `ui.html` (Trace view, build check, Resume).
- **A trace is recomputed, never stored.** Flat pre-order spans with `parent` ids; `depth=1` / `parent=<id>` just filter that list, so the UI loads a unit in pieces. The one cost is parsing the transcript, so
  the last 96 parses stay in memory keyed by file size, mtime and the session's ledger row count (a lazy expansion, or the 22 segments of one session, do not re-read a 50 MB file). An Agent call becomes a
  `subagent` span through `toolUseResult.agentId` on its result row (the CLI writes it; the id names `<session>/subagents/agent-<id>.jsonl`).
- **Model calls are in the full trace and out of the minimal one** (they carry no content; only each scope's last one stays, as the report), so "steps" means tool calls and subagent runs.
- **The family rule is the notes' own (`family()`: executable + first argument), and it is coarse.** On the dry-run unit 130 of 272 steps were "repeated commands" (every `ffmpeg -i`, every
  `~/.venv/bin/python voiceover.py`): only the last of each is kept, with `runs: n`; `npm run build` and `npm run deploy` are one family. That is what the spec asks for; if the skills lose steps, split on more words here.
- **Main-thread session units keep their own extract.** The writer's trace input is for subagent runs and segments (the units whose input was the note's Commands/Files lists); a session's input is
  unchanged (its note still lists the last 80 commands) and its test asserts that. Both the gate and the writer fall back to the note when a unit's transcript is gone.
- **Built-in and unmarked skills are no match targets** (coordinator's addition, after the recall skill `brain` was offered to a unit and got a proposed update): `known()` drops `source = 'builtin'` and a promoted
  skill whose directory has no `.agent-router` marker; a stored scan that names one is read as `new`. The pending update on the live vault was left for the human to reject.
- **Dry run, dev router on a copy of the live ledger and vault, real transcripts** ("Google Docs link", the subagent unit "Build trailer v3 from Aayush's script"):
  | | full | minimal |
  | --- | --- | --- |
  | spans | 515 (1 prompt, 242 model, 272 tool) | 80 (1 prompt, 78 tool, 1 model) |
  | steps | 272 (5 failed) | 78 |
  | JSON | 170,043 bytes | 27,556 bytes; the outline 12,182 bytes (about 3k tokens, under the 6k cap) |
  Pruned: 5 failed, 85 reads collapsed into 26 `explored` spans, 130 repeated commands, 241 model calls hidden (so 5 + 59 + 130 = 194 steps dropped). Time over HTTP: 122 ms cold (112 ms in
  process, the transcript read included), 8 ms from the memo; `depth=1` is 1,001 bytes in 8 ms. The whole session (29 subagents, 22 segments): 4,864 spans, 1.5 MB, 588 ms cold, 38 ms warm;
  minimal 1,235 spans, 380 KB, steps 2,422 → 1,021; one segment 174 spans in 160 ms. The unit's top level is one prompt with 79 children, in order (names only): explored ×3, Write ×3, Bash ×3, explored, Bash, explored, Read, explored, Bash, explored, Bash, Read, explored, Monitor, … (a `SubagentHandback` each time the run was continued) … and the final model call.
  **Distill from the trace, once** (the stored scan reused: refine mode against `incremental-prototype-with-real-data-eval`, 0.88): one Sonnet call, 10,353 in / 2,461 out, $0.045 at list price; the skill
  was rewritten in place from 13 to 31 lines (27 added, 9 removed, 4 unchanged): a material change, the trailer-specific steps added. The call went through :4101 (its row is in the dev ledger, and the dev log).
- **Stale console.** `health.build` is the first 8 hex of a hash of ui.html; the router serves the page with it filled in (`const BUILD`), the page compares on every poll and reloads itself, or shows a
  "New version — reload" chip while a form is dirty or an input has focus (checked in the browser: typing in the filter box held the reload, clearing it let it happen).
- **Not built:** trace search is over the loaded spans after one full fetch (no server-side search); a very long idle gap (the subagent above spans 5 h 42 min for 342 minutes of wall time, mostly waiting) makes
  the bars thin: no axis break; spans are not windowed past ~20,000 open rows.

## Minimal trace: parse the command before deciding its family (2026-10-01)
Spec: `docs/BRAIN.md` "Trace". Code: `trace.ts` `commandKeys()` (one definition; `minimal()` and the unit notes' command families in `brain.ts` use it; `family()` and the read-only regex are gone).
- **The old family rule (first two words after `cd … &&`) threw real steps away.** `cd <dir> && ffmpeg …`, `cd <dir> && node render.js`, `cd <dir> && python3 voiceover.py` were one family per directory and only the last
  survived; the survivors were `cd`, `until`, `for`, `S=…`. Now a line is split into its commands, set-up (`cd`, `export`, `VAR=x`, `sleep`, `echo`, …) is dropped, and each command is keyed by executable +
  subcommand/script + output file; the family is the tuple. A Bash span carries `cmd: {keys, ro}` (computed from the full command, since `target` is cut at 160 characters) and its `target` is the line without set-up.
- **Dry run on a copy of the live ledger and vault, no model call.** Subagent "Build trailer v3" (272 steps, 189 Bash): kept 78 -> 192; repeated_commands 130 -> 6; collapsed reads 85 -> 99 (more of the
  `sed`/`cut`/`tr`/`awk`/`ps` filters count as looking now); outline 12.1k -> 24.0k characters (at the 24k cap, so `md()` trims). Two more units of that session: 126 steps, 74 -> 100 (44 -> 5 repeated) and 129 steps,
  51 -> 86 (43 -> 3). Every distinct successful non-read-only command family of the full trace is in the minimal one (128 of 128, 55 of 55, 57 of 57); ffmpeg 22 distinct runs, 22 kept (old: 2).
- **What it costs.** Heredoc scripts (`python3 - <<EOF …` file patches, 47 in the first unit) are distinct by a hash of their text, so every patch is a step; collapsing them was the old failure in another form.
  A rule that merges patches by the file they touch would need the heredoc parsed. Shell functions defined in an earlier call (`hc`, `snap`), `$VAR` executables with no script and `case` are keyed by their name only.
- **Read-only grew** beyond the spec's list (`sed` without `-i`, `awk`, `cut`, `tr`, `sort`, `uniq`, `ps`, `pgrep`, `date`, `basename`, `diff`, `strings`, …) after the first run kept dozens of `sed -n`/`cut`/`pgrep` steps.

