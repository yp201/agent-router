# ADR-001: Distributable binary and remote account pool

**Status:** Proposed
**Date:** 2026-09-25
**Deciders:** Yashaswi

## Context

agent-router today is 1,017 lines, zero dependencies, Node 24 (`node:sqlite`, `.ts` type-stripping), one process,
one SQLite file, verified end-to-end on the Claude desktop app: transparent TLS capture of `api.anthropic.com`,
sticky per-session routing across two subscription accounts, cooldown + replay on 429, management UI.

Two things it is *not* yet:
1. **Distributable.** It runs from a git checkout: ledger and `ui.html` resolve from `import.meta.dirname`, the launchd
   plist bakes in this machine's fnm node path, `install` assumes the project dir, and users need Node 24 + `openssl`.
2. **Multi-user.** One trust domain: every client is on the same machine, no auth on `/router/*`, tokens come from this
   user's Keychain, the data model has no notion of *who* made a request.

Forces: (a) the desktop app cannot be pointed at a remote URL — only the local hosts/CA trick reaches it, and that trick
must never cross a network; (b) prompt cache is per Anthropic org, so routing must stay sticky per session no matter
where the router lives; (c) pooling *subscription* OAuth across people is the exact thing Anthropic's ToS prohibits,
while pooling *API-key* accounts is ordinary usage; (d) the ledger must keep storing no request bodies, because a shared
router sees everyone's prompts.

## Decision

Split the system into two roles of the **same binary**, chosen by flag:

```
                 ┌────────────────────────── one machine ──────────────────────────┐
desktop tab ──┐  │  agent-router --local                                            │
claude CLI ───┼──►  :443 transparent + :4001 explicit   ── local accounts (Keychain)│──► api.anthropic.com
SDK scripts ──┘  │  ledger.sqlite (this user)  · ui  · P3 tailer                    │
                 └────────────────────────────────┬─────────────────────────────────┘
                                                  │ optional: UPSTREAM = https://pool.example.com  (per-user key)
                                                  ▼
                 ┌─────────────────────────── one VM ──────────────────────────────┐
                 │  agent-router --remote                                           │
                 │  :443 behind Caddy (real cert) · users/pools/quotas              │──► api.anthropic.com
                 │  accounts = API-key rows + (this operator's own) OAuth rows      │
                 │  ledger.sqlite (all users, no bodies) · ui with per-user view    │
                 └──────────────────────────────────────────────────────────────────┘
```

- **Local mode is the product on every machine.** It is the only thing that can capture the desktop app. It keeps
  working with zero network dependency; the remote pool is just one more "account" it can route to.
- **Remote mode is the same router with three additions:** a `users` table + per-request key check, `pool_id` on
  accounts, and quota in `pick()`. Its accounts are **API keys** (`x-api-key`) by default; subscription OAuth rows are
  allowed only for the operator's own accounts, never shared across users. The local agent forwards to the pool by
  swapping the inbound bearer for its user key — the same header-swap it already does per account.
- **Distribution = signed `.app` bundling Node** (the P7 menubar app), with `npm i -g` / Homebrew as the developer channel
  in the meantime. No SEA, no Bun.

## Options Considered

### (1) How to ship the local binary

#### Option A: `npm publish` + `engines.node >= 24` (developer channel)
| Dimension | Assessment |
|---|---|
| Complexity | Low — publish what exists; `bin` points at a 5-line launcher |
| Cost | none |
| Scalability | n/a |
| Team familiarity | High |

**Pros:** zero packaging work; `npx agent-router install` is a one-liner; updates are `npm update`.
**Cons:** requires Node 24 on the user's machine; still needs sudo for hosts + CA; not what non-devs will run.

#### Option B: Node Single Executable Application (SEA)
| Dimension | Assessment |
|---|---|
| Complexity | Medium — needs a transpile step (esbuild, dev-only) because SEA blobs can't strip types; codesign after injection |
| Cost | none |
| Scalability | n/a |
| Team familiarity | Low |

**Pros:** one ~90 MB file, no Node install. **Cons:** still needs Developer ID signing + notarization to open without
Gatekeeper warnings; `node:sqlite` experimental flag must be baked in; gains nothing over Option C once an `.app` exists.

#### Option C: Signed `.app` (menubar) bundling a Node runtime + the `.ts` files
| Dimension | Assessment |
|---|---|
| Complexity | Medium — Swift menubar shell (P7), bundle `node` binary, sign + notarize |
| Cost | Apple Developer ID ($99/yr) |
| Scalability | n/a |
| Team familiarity | Medium |

**Pros:** the "Docker Desktop" shape the product wants; `install` can request admin rights once with a proper consent
dialog (`osascript … with administrator privileges` or SMAppService); launchd registration via `SMAppService.loginItem`;
the CA/hosts step is *explained on screen* instead of in a terminal. **Cons:** signing pipeline; ~80 MB download.

#### Option D: Bun `--compile`
Rejected: the router uses `node:sqlite`, `node:https` server internals and `dns.Resolver`; Bun's compat for these is
partial and unverified. Not worth a rewrite to save a runtime download.

**Decision:** A now (this week, as the dev channel), C as the release channel with P7. Skip B and D.

### (2) How to run a remote pool

#### Option E: Same binary, `--remote` flag, SQLite, one VM behind Caddy
| Dimension | Assessment |
|---|---|
| Complexity | Low–Medium: ~150 lines (users, pools, quota, key check, encrypted token store) |
| Cost | one small VM |
| Scalability | tens of users, thousands of req/hour on SQLite WAL; single instance |
| Team familiarity | High — it's the code we have |

#### Option F: Separate service (Postgres, multi-instance, LiteLLM-style)
| Dimension | Assessment |
|---|---|
| Complexity | High |
| Cost | DB + ≥2 instances + LB |
| Scalability | hundreds of users |
| Team familiarity | Medium |

**Decision:** E. F is a *later* migration (swap `node:sqlite` for Postgres behind the same `ledger.ts` functions) that
should be triggered by a measured problem, not anticipated.

## Trade-off Analysis

- **Local agent stays mandatory even with a pool.** Tempting to think "remote router, point clients at it" — but the desktop
  app cannot be pointed anywhere, and the only way to reach it (hosts + local CA) must not be extended across a network
  (that would be distributing a MITM CA). Hence local-forwards-to-remote. Cost: one more hop (~5 ms on a LAN, ~30 ms
  across regions) on every request. Acceptable; streaming is piped, not buffered.
- **API keys vs subscription OAuth in the pool.** Subscription pooling across users is cheaper per token but is a ToS
  violation with a real ban risk against the accounts *and* a legal surface for whoever runs the server. API-key pooling
  costs per token but is ordinary use and lets quotas be dollars, not fractions of a 5-hour window. The router already
  handles both header styles; the *policy* is what this ADR fixes: **shared pools are API-key pools.**
- **Cache economics get better in a pool, not worse.** Sessions stay pinned per account, so the per-org cache still hits.
  Many users sharing one account means shared prefixes (common CLAUDE.md fragments, skills, tool lists) get cached once —
  this is exactly the data P6's "cross-cutting skills" recommendation needs.
- **Privacy.** The remote router terminates TLS and sees full prompts in memory. It stores none; the ledger holds
  request ids, token counts, account, user, latency. Write that down as a policy in the repo and enforce it in tests
  (the existing "no token in ledger" test becomes "no body bytes in ledger").
- **Port 443 on all interfaces** (macOS forces this for non-root binds) — already loopback-guarded in-process. For the
  `.app` this is fine; document it. Root-owned launchd + `127.0.0.1:443` is the alternative if a port scan ever matters.

## Consequences

**Easier:** one codebase, one mental model (a router that swaps a header); pool = "another account"; the menubar app
wraps a script that already exists; every phase P3–P6 reads the same ledger locally and remotely.

**Harder:** two deployment shapes to test (add a `--remote` test run of the same suite with a fake pool); token-at-rest
encryption on the server (`node:crypto` AES-GCM, key from env — no KMS until there's a second operator); signing +
notarization pipeline for the `.app`.

**Revisit when:** a pool exceeds one VM's SQLite comfortably (→ Postgres behind `ledger.ts`), or Anthropic ships a
first-party way to point the desktop app at a gateway (→ delete transparent mode, keep everything else).

## Action Items

Distribution (this week)
1. [ ] Paths: default `LEDGER_PATH` and logs to `~/.agent-router/`, not `import.meta.dirname`; ship `ui.html` next to the
       entry and resolve it the same way; plist `ProgramArguments` = the installed launcher, not a checkout.
2. [ ] `bin/agent-router` launcher (node shebang) exposing `install|uninstall|status|start|stop|restart|logs|ui` — port
       `agent-router.sh` into the binary so the `.app` and the CLI share one implementation; drop the now-unneeded
       `launchctl setenv NODE_EXTRA_CA_CERTS` step (the CLI trusts the System keychain — verified).
3. [ ] `package.json`: `bin`, `files`, `engines: {node: ">=24"}`, `version`; publish as `@yash/agent-router` (or a Homebrew tap).
4. [ ] Fold P3 (JSONL tailer) into the same process as an always-on loop; one launchd job, one binary.

Remote pool (after P3 has real data)
5. [ ] Schema: `users(id, key_hash, pool_id, quota_json, disabled)`, `pools(id, note)`, `accounts.pool_id`,
       `accounts.kind = 'apikey'`, `requests.user_id`, `sessions.user_id`.
6. [ ] `--remote`: require `Authorization: Bearer <user key>` on everything, map to `user_id`, filter `pick()` by pool +
       remaining quota; `/router/*` scoped to the caller (operator key sees all).
7. [ ] Token/API-key at rest: AES-GCM with `AGENT_ROUTER_KEY` from env; Keychain reader disabled in remote mode.
8. [ ] Local `--upstream-pool https://… --pool-key …`: forward with the user key, keep local ledger; the pool appears as
       account `pool` in the local UI.
9. [ ] Deploy: one VM, Caddy for TLS, SQLite on a volume, the same `node --test` suite run with `--remote` against a fake
       upstream in CI.
10. [ ] Policy doc: "no request bodies at rest, ever" + test; "shared pools are API-key pools" in the README.

Menubar app (P7)
11. [ ] Swift menubar shell: status from `agent-router status --json`, embedded `ui.html` in a WKWebView, one consent
        dialog for the admin step, `SMAppService` login item replacing the hand-written plist; sign + notarize.

## Addendum 2026-09-25: Linux (and later Windows)

The router is already portable (Node 24 stdlib only; Linux credentials are the `.credentials.json` reader that
`accounts.ts` tries first). Platform specifics live entirely in `agent-router.sh`/`setup.sh`:

| macOS | Linux |
|---|---|
| `security add-trusted-cert` | `/usr/local/share/ca-certificates/agent-router.crt` + `update-ca-certificates` (Debian) / `trust anchor` (Fedora) |
| launchd plist | systemd user unit + `loginctl enable-linger` |
| unprivileged `*:443` bind | `setcap cap_net_bind_service=+ep <node>` (re-apply on node upgrade) or `:8443` + one nft redirect |
| `sed -i ''`, `open` | `sed -i`, `xdg-open` |

Key difference: no official desktop app on Linux, and every Linux client (terminal CLI, IDE extensions) is the CLI,
which honours `settings.json → env.ANTHROPIC_BASE_URL`. So **Linux installs default to explicit mode** (`:4001`, no
sudo, no CA, no hosts) with `--transparent` as opt-in for URL-hardcoding scripts. Windows: hosts under
`System32\drivers\etc`, `certutil -addstore Root`, Scheduled Task — after Linux.

Action: a `PLATFORM` switch in `agent-router.sh` (~60 lines), `agent-router.service` template beside the plist,
`install` picks the mode by platform. Priority: after the P3/console build.
