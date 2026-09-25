# agent-router — plan

A cache-affinity proxy in front of `POST /v1/messages` with a session-joined ledger.
Everything else (UI, remote pool, quotas, recommendations) is a *reader* of that ledger.

Companion: [NOTES.md](NOTES.md) — prior art + verified JSONL facts.

---

## 0. Verified facts that shape the design

| Fact | Consequence |
|---|---|
| Desktop app spawns the **stock `claude` CLI** as a child (`…/Claude/claude-code/2.1.281/claude.app/…/claude --input-format stream-json`) with `ANTHROPIC_BASE_URL=https://api.anthropic.com` set explicitly in its env, `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1` | The CLI honours `ANTHROPIC_BASE_URL`. Question is only whether `settings.json → env` beats the desktop's explicit env. **P0 spike.** No mitmproxy unless the spike fails. |
| Desktop host injects + refreshes the OAuth bearer (scopes `user:inference user:file_upload user:profile user:sessions:claude_code`) | Proxy strips inbound `Authorization`, swaps in the chosen account's token. Inbound token = "home" account identity. **Proxy never refreshes the home token** — desktop does. Proxy only refreshes tokens for *added* accounts. |
| `assistant` JSONL rows carry `requestId` == API `request-id` response header | Free join key proxy-log ↔ transcript. No fingerprinting. |
| `assistant` rows carry `apiBlockIndex` + full `usage` (cache_read / cache_creation / 1h vs 5m / thinking) | Cache-miss analytics come from the transcript. Proxy only needs to log what the transcript doesn't have: **which account served it, latency, status, rate-limit headers.** |
| Transcript is account-agnostic; resumed sessions chain via `parentUuid` across `sessionId`s | **Account switch = zero JSONL surgery.** What breaks is the prompt cache (per-org). |
| Prompt cache is per org | Switch cost = one full `cache_creation` of current context (25k–150k tokens @1.25×). **Round-robin is wrong. Sticky routing is right.** |
| Node 24 on this machine (no bun) | `node:sqlite`, native streaming `fetch`, `.ts` runs directly. **Zero dependencies, zero build step.** |

---

## 1. Architecture

```
claude CLI (desktop tab / terminal)
   │  ANTHROPIC_BASE_URL=http://127.0.0.1:4001
   ▼
┌─────────────────────────────────────────────┐
│ router  (single node process, ~400 loc)     │
│                                             │
│  POST /v1/messages ──► pick(account) ──► fetch(api.anthropic.com) ──► pipe SSE back
│                              │                     │
│                              │              on 429/529: cooldown(acct), pick again,
│                              │              retry same body once, log migration
│                              ▼
│                        ledger.sqlite  (requests, accounts, sessions)
│  everything else: transparent passthrough on pinned account
│  GET /router/*   : health, accounts, stats (JSON) — UI reads these later
└─────────────────────────────────────────────┘
                     ▲
    jsonl-tailer ────┘  (optional sidecar: watches ~/.claude/projects/**/*.jsonl,
                         upserts usage rows joined on requestId)
```

Two processes max: `router` and `tailer`. Tailer can be folded into router later; keep separate so router stays dumb and restartable.

### Session identity
The CLI doesn't send a session id header. Derive `session_key` from the request:
1. `metadata.user_id` in the body if present (CLI sends one) — check in P1 by logging bodies.
2. Fallback: hash of `system[0]` + first user message = stable per session.
Log both in P1, pick in P2. Don't design around it before seeing real bodies.

### Routing policy (the whole product)
```
pick(session_key):
  a = pins[session_key]
  if a && a.healthy && !a.cooling:  return a            # cache-hit path, 99% of calls
  b = argmax(accounts.filter(healthy && !cooling), remaining_quota)
  if !b: return 503 with clear body                      # never silently queue
  if a: ledger.migration(session_key, a→b, est_cost = last_input_tokens(session_key))
  pins[session_key] = b
  return b
```
- Sticky until forced. Force = 429/529/401 from upstream, or account marked disabled.
- Never rotate for "balance". Balance is a *loss* here.
- `count_tokens` and non-messages endpoints: pinned account, no quota accounting.
- Cooldown: from `retry-after` if present, else 5 min, else until `anthropic-ratelimit-*-reset`.
  **Don't guess header names** — P1 logs all `anthropic-ratelimit-*` headers raw; P2 reads what's there.

### Data model (`ledger.sqlite`)
```sql
create table accounts (
  id            text primary key,     -- short label, e.g. "home", "acct-b"
  kind          text not null,        -- 'home' (token from inbound request) | 'oauth' (stored) | 'apikey'
  token_ref     text,                 -- keychain item name or path; NEVER the token itself
  expires_at    integer,
  disabled      integer default 0,
  cooling_until integer,
  note          text
);
create table requests (
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
  retry_of       integer,             -- requests.id if this was a migration retry
  ratelimit_json text,                -- all anthropic-ratelimit-* headers, verbatim
  -- filled by tailer from transcript, null until joined:
  jsonl_path     text, session_id text, api_block_index integer,
  in_tok integer, out_tok integer, cache_read integer, cache_create integer,
  cache_1h integer, cache_5m integer, thinking_tok integer
);
create table migrations (
  ts integer, session_key text, from_account text, to_account text,
  est_cost_tokens integer, request_id text
);
create index on requests(session_key, ts);
```
That's it. No ORM, no migrations framework — a `schema.sql` applied with `CREATE IF NOT EXISTS`.

### Secrets
Tokens live in macOS Keychain (`security add-generic-password -s agent-router -a <acct>`), ledger stores only the account id. Home account token is never persisted — it arrives on every request. `accounts.json`-on-disk like CC-Router is a downgrade; don't copy it.

### File layout
```
agent-router/
  router.ts        server + routing + upstream fetch (P1–P2)
  ledger.ts        sqlite open + schema + insert helpers
  accounts.ts      keychain read, token refresh for stored accounts
  tailer.ts        jsonl watcher → usage join (P3)
  schema.sql
  test_router.ts   one runnable check per phase (node --test)
  PLAN.md NOTES.md
```

---

## 2. Phases — each is one self-contained delegation to a coding agent

### P0 — spike: does the desktop tab obey `settings.json → env.ANTHROPIC_BASE_URL`?  (30 min)
1. 20-line `node` server on `:4001` that logs `method path` and 502s.
2. Add `"env": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:4001"}` to `~/.claude/settings.json`.
3. Open a **new** desktop Code tab, send "hi". Did `:4001` log a `POST /v1/messages`?
- **Yes** → proceed. Remove the env line until P1 is real.
- **No** (desktop's explicit env wins) → fallback order: (a) `claude` wrapper script in the versioned desktop dir that sets env and execs the real binary — fragile across updates, note the version path; (b) mitmproxy like CC-Router. Decide then, not now.
- Also verify: terminal `claude` + `ANTHROPIC_BASE_URL` — expected yes, confirm.
**Exit:** one sentence in NOTES.md saying which path works.

### P1 — transparent proxy + ledger  (~200 loc)
- `router.ts`: accept any request, forward verbatim to `https://api.anthropic.com` (headers passthrough incl. `anthropic-beta`, `anthropic-version`, `user-agent`; strip `host`), stream response bytes back untouched. Single account = home (inbound bearer passthrough).
- Log every request to `requests` (ts, request_id from response header, path, model from body, status, latency, stream flag, raw `anthropic-ratelimit-*` headers). Also dump **3 full request bodies** to scratch once so P2 can pick `session_key` from reality.
- `GET /router/health`, `GET /router/stats` (last 50 rows).
- Check: `test_router.ts` — spin router against a fake upstream that returns a 2-event SSE stream; assert bytes identical + one ledger row with the request_id.
**Exit:** a full desktop session (tools, thinking, streaming) runs through it with zero visible difference; ledger fills; `cache_read` in the transcript stays non-zero across turns (proves passthrough didn't break caching).

### P2 — multi-account + sticky routing + cooldown  (~150 loc)
**Status (2026-09-25): built + tested with fake upstream; real e2e on home only.** Second real account awaits a human `claude auth login`.
- `accounts.ts`: read stored tokens from Keychain; refresh OAuth for non-home accounts (reuse CC-Router's refresh flow as reference, not its storage).
- `session_key` derivation (from P1 body dump). Pins in memory + persisted to `sessions` table so restart keeps affinity.
- On 429/529: cooldown, re-pick, replay the buffered request body once, log `migrations` row + `retry_of`.
  Streaming caveat: only replay if **no bytes were sent to the client yet**; otherwise pass the error through (client retries itself).
- `router/accounts` endpoint showing pin count, cooling_until, last status per account.
- Check: fake upstream that 429s account A on the 3rd call → assert the 3rd request lands on B, a `migrations` row exists, and the 4th request stays on B.
**Exit:** two real accounts, force a 429 (or set `cooling_until` by hand), session continues transparently, migration row shows the cache cost.

### P3 — transcript join  (~120 loc)
**Status (2026-09-25): ✅ built, tested (13/13), live.** `tailer.ts` runs in the router process (fs.watch recursive, 4 MB
async slices, offsets in `tail_offsets`, first run = files touched in the last 7 days: 128 MB in <5 s). Rows the transcript writes
*before* the router logs the request (stream still open — observed up to 3 min) wait in memory and join when the router's
insert calls `joined(requestId)`, instead of a fixed 2 s retry. Request fingerprints (system/tools/first-user hashes, counts,
context_est, ua_kind, tool names on first sight of a tools_hash) on every `/v1/messages`. Burst attribution is read-time JS in
`console.ts`. Settings table wired into `pick()` (policy, 5h cutoff, weekly reserve).
- `tailer.ts`: `fs.watch` on `~/.claude/projects/**`, read appended lines, for `type==assistant` rows `UPDATE requests SET usage… WHERE request_id=?`. Also stamp `jsonl_path`, `session_id`, `api_block_index`.
- Per-session rollup view: `select session_key, sum(cache_read), sum(cache_create), count(*), sum(latency_ms)…`.
- Check: feed a captured jsonl fixture → assert join hits for every `requestId` the router logged.
**Exit:** `GET /router/sessions/<key>` returns true cost including migration overhead, computed from transcript numbers not proxy guesses.

### P4 — UI (read-only first)
**Status (2026-09-25): ✅ console UI** — five hash-routed screens (`#overview #accounts #cache #cost #insights`) in the one
`ui.html`, built from the design mockups; reads `/router/{overview,sessions,cache,cost,insights,settings}`, polls 3 s, "—" where
the ledger can't compute a number yet (dollars without a rate card, weekly-window share, OpenVikings sync = placeholder).
**Status (2026-09-25): built** — `ui.html` at `/router/`, with actions (disable/enable, clear cooldown, check, remove, add account, manual pin) since P2 needed the endpoints anyway.
- Single static `index.html` served by router, polls `/router/*` JSON. Accounts, cooldowns, per-session cost, migrations timeline, cache-hit ratio.
- Actions come later and are 3 endpoints: disable account, clear cooldown, force pin. Add when you actually want to click them.
**Skip:** framework, build step, auth (localhost only).

**Status (2026-09-25): ✅ actual switch cost, session timeline, context advisor** — `migrations.actual_cost_tokens` from the
first joined turn after a switch; `/router/sessions/:key/timeline` + lane SVG in Sessions; `advisor.ts` (warn/urgent advice with a
transcript breakdown + Haiku via `claude -p`, handoff summaries, `/router/advice`). 17/17 tests. See NOTES.md "Advisor".

**Status (2026-09-26): ✅ proactive switch + notifications** — pinned sessions leave an account past `proactive_switch_pct` (0.95) for one
`proactive_min_gain` (0.2) emptier, before sending, max once per 10 min; osascript notification on every switch and on each warn_pct
crossing (once per window); `fake-util`/`fault429` drill hooks behind `DRILLS=1`. 19/19 tests. See NOTES.md "Proactive switch".

### P5 — remote / shared pool
Same binary, `--listen 0.0.0.0 --require-key`. Adds:
- `users` table (id, key_hash, quota_tokens_per_day, pool_id); requests get `user_id`.
- `pick()` filters accounts by `pool_id` and by user's remaining quota; "borrow from shared pool" = pool_id `shared` as fallback.
- TLS via caddy/tailscale in front, not in the binary.
**Flag before building:** this routes other people's traffic through subscription OAuth tokens — the part that gets accounts banned and has a ToS surface (see NOTES.md). Design so a pool can be **API-key accounts** too; that's the clean version of the remote product.

### P6 — recommendations
Pure SQL over the ledger, rendered in the UI. First three, in order of payoff:
1. **Cache-miss detector**: sessions where `cache_create` spikes without a preceding migration → something invalidated the prefix (system-prompt/tooling change, MCP tool list churn, edited CLAUDE.md mid-session). Show the turn.
2. **Migration cost report**: total tokens burned by account switches; suggests "add capacity to account X" vs "add another account".
3. **Cross-cutting skills**: cluster first-user-messages across sessions by embedding or even just TF-IDF; repeated prompt shapes → "this is a skill". Later. Needs volume first.

### Not building (until a phase above proves the need)
- OpenAI/Codex `/v1/responses` translation — only the wire adapter differs; ledger is provider-neutral (`model`, `in/out/cache`). Add a `providers/openai.ts` when someone actually runs Codex through it.
- Model-name rewriting / cross-provider routing (that's musistudio's product).
- Request body storage (privacy + size). Store hashes and token counts only.
- Any queueing when all accounts are cooling — return 503, let the CLI retry.
- Postgres, k8s, Docker. Single sqlite file. `launchd` plist for autostart is ~15 lines when wanted.

---

## 3. Order of work

`P0 (today) → P1 → P2 → P3` are the product. P4 is when it hurts to read sqlite by hand. P5/P6 only after a week of real ledger data — the recommendations are only as good as the join, and the join is only trustworthy after P3 has run against real sessions.

Delegation: each phase header above is a complete prompt for a coding agent (opus 5.5), with NOTES.md + this file as context. Ponytail applies: zero deps, one test per phase, no scaffolding for the next phase.

---

## P0.5 — transparent mode ✅ installed + verified on the desktop app 2026-09-25 (`agent-router.sh install`)
**Status (2026-09-25): built + tested (8/8), live router serving HTTPS on :443; certs + plist generated. Awaits the human's
5 commands (NOTES.md "P0.5 build").** Deviation: macOS allows non-root <1024 binds only on the wildcard address
(127.0.0.1:443 → EACCES), so the TLS listener binds `[::]:443` and drops every non-loopback peer before the handshake.

`/etc/hosts` maps `api.anthropic.com` → loopback; router terminates TLS with a local CA; dials the real
upstream by IP with SNI. Invisible to every app-side guard because the URL never changes. Terminal CLI keeps
the explicit `http://127.0.0.1:4001` path via `settings.json → env`.

**router.ts changes**
- `fetch` → `node:https` `request` + `up.pipe(res)` after `res.writeHead(up.statusCode, up.headers)`.
  Byte-for-byte: keep `content-encoding` / `content-length` / `transfer-encoding` as upstream sent them.
  Still buffer the *request* body (model, dump, P2 replay).
- Upstream dial that bypasses /etc/hosts: `dns.promises.Resolver().resolve4(UPSTREAM_HOST)` (c-ares, ignores
  hosts file), cache 5 min, re-resolve on ECONNREFUSED/ETIMEDOUT. `https.request({host: ip, port, servername:
  UPSTREAM_HOST, headers: {...passthrough, host: UPSTREAM_HOST}})`. Env: `UPSTREAM_HOST` (api.anthropic.com),
  `UPSTREAM_PORT` (443), `UPSTREAM_IP` (test override), `UPSTREAM_CA` (extra PEM for the test's fake upstream).
- Listeners, one handler: HTTP `127.0.0.1:4001` (explicit) + HTTPS `127.0.0.1:443` and `[::1]:443` (transparent)
  from `TLS_DIR` (default `~/.agent-router/ca`: `api.anthropic.com.pem`, `api.anthropic.com-key.pem`). No certs
  → log "transparent mode off" and run HTTP only. :443 bind needs no root on macOS ≥10.14; on EACCES/EADDRINUSE
  log and continue, never crash.

**setup.sh** (no sudo inside; prints the human's commands)
- `openssl` CA: CN "agent-router local CA", CA:TRUE, 3650d. Leaf: SAN `DNS:api.anthropic.com`, 397d. Idempotent, keys 600.
- Prints: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.agent-router/ca/ca.pem`;
  `printf '127.0.0.1 api.anthropic.com\n::1 api.anthropic.com\n' | sudo tee -a /etc/hosts`;
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-router.plist`.
- **Open risk:** the `claude` CLI is a compiled Bun binary and may not read the System keychain. If TLS fails after
  trust, the fallback is `NODE_EXTRA_CA_CERTS=~/.agent-router/ca/ca.pem` — for the desktop child that means
  `launchctl setenv NODE_EXTRA_CA_CERTS …` + relaunch, *if* inherited env survives the desktop's injection
  (untested, same unknown as option D). Verify empirically first with terminal `claude` and `ANTHROPIC_BASE_URL` unset.
- `uninstall.sh` prints the reverse (`sudo sed -i '' '/api.anthropic.com/d' /etc/hosts`,
  `sudo security delete-certificate -c "agent-router local CA" /Library/Keychains/System.keychain`).

**com.agent-router.plist** — user LaunchAgent, `KeepAlive` + `RunAtLoad`, cwd = project, `node router.ts`,
logs to `router.log`, PATH with the `which node` dir baked in by setup.sh. Non-optional: in transparent mode a dead
router = every Anthropic API client on the machine fails.

**test_router.ts additions** — fake upstream becomes `https.createServer` with a throwaway cert; gzip case asserts
identical gzipped bytes + header intact; transparent-listener case connects with `servername: 'api.anthropic.com'`
on `TLS_PORT` and asserts the fake upstream saw `host: api.anthropic.com` (not an IP) and a ledger row exists.

**Blast radius, stated once:** every process on this Mac that talks to `api.anthropic.com` (CLI, desktop tabs,
SDK scripts, other tools) goes through this router and trusts this CA. That is the feature and the risk.

### P7 — menubar app ("Docker Desktop for Claude accounts")
`agent-router.sh` is the whole backend: `install|uninstall|status|start|stop|restart|logs|ui`. The app is a menubar
icon that shells out to it and embeds `ui.html` in a WKWebView. Lazy first cut: a SwiftBar/xbar plugin whose output is
`agent-router.sh status` (zero app code). Real app when the plugin annoys us. Login items = the launchd plist already.
