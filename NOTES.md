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
  metadata session_id is shared by its subagents and side requests, which have different prefixes. First request of a thread that
  bursts is labelled "first turn, cold cache". Account switch = migration row for the request *or* account differs from the previous turn
  (manual pins log their migration with request_id null).
- 7d projection uses the window's average rate so far (util × 7d / elapsed); a 60-min burn stretched over days projected 300%+.
