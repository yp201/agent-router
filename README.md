# agent-router

A local proxy for Claude Code that routes each session to one of several Claude accounts, keeps prompt caches warm,
and shows you where your tokens go. Works with the Claude desktop app (transparent mode) and the terminal CLI.
Zero dependencies: Node 24 + SQLite (built in) + `openssl`.

**Status:** early, macOS first (Linux/Windows via CLI-only mode below). Use it with subscriptions **you own** — it is
not a way to share one account between people. MIT licensed.

- **Sticky routing.** A session stays on one account (its cache lives there). New sessions start on the account with
  the most headroom. Rate-limited → cooldown, replay on another account, logged.
- **Ledger.** Every request joined to your session transcripts by request id: cache read/write per turn, bursts and
  why they happened, per-window headroom, per-session cost.
- **Console** at `http://localhost:4001/router/`: accounts, sessions (switch with one click), cache manager, budgets, insights.

## Setup — one command (macOS)

```bash
git clone https://github.com/yp201/agent-router.git && cd agent-router && ./agent-router.sh install
```

It checks for Node 24, generates a local CA, asks for `sudo` twice (trust the CA, point `api.anthropic.com` at this
machine), registers the router with launchd so it's always on, and health-checks itself. Then **quit and reopen the
Claude desktop app**. Open `http://localhost:4001/router/`.

What you are agreeing to: every process on this Mac that talks to `api.anthropic.com` now goes through a proxy you run,
and trusts a CA generated on this machine. `./agent-router.sh uninstall` reverses all of it.

## Add a second account

Console → **Add account** → run the command it prints in any terminal (it opens the official login in your browser) →
**Check**. New sessions will start on whichever account has the most headroom; live sessions stay where they are unless
you switch them.

```bash
CLAUDE_CONFIG_DIR=~/.agent-router/accounts/<name> claude auth login
```

## Day to day

```bash
./agent-router.sh status     # one line per component
./agent-router.sh logs       # tail the router log
./agent-router.sh restart    # after pulling a new version
./agent-router.sh uninstall  # remove hosts entry, CA trust, launchd job
```

State lives in `~/.agent-router/` (ledger, certs, accounts, log); the checkout only holds code.

After a reboot everything comes back by itself. If the router is ever down, Claude can't reach the API — `status` tells
you in one line, `start` fixes it.

## Terminal CLI only (Linux, or macOS without the desktop app)

No sudo needed. Add to `~/.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:4001" } }
```

and run `node router.ts` (or the launchd/systemd job). Transparent mode is only required for the desktop app,
which ignores that setting.

## Development

```bash
node --test test_router.ts   # 14 tests, fake upstream, no network
```

`router.ts` proxy + routing · `accounts.ts` token store · `tailer.ts` transcript join · `console.ts` analytics ·
`ui.html` console · `agent-router.sh` install/status/uninstall. Plan and findings: `PLAN.md`, `NOTES.md`, `docs/`.

Tokens are read from the official CLI's credential store at request time and never written to disk, logs or the UI.
No request bodies are stored — only hashes, counts and token totals.
