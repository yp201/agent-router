# agent-router

![agent-router console — overview](docs/img/overview.png)

A local proxy for Claude Code that routes each session to one of several Claude accounts, keeps prompt caches warm,
and shows you where your tokens go. Works with the Claude desktop app (transparent mode) and the terminal CLI.
Zero dependencies: Node 24 + SQLite (built in) + `openssl`.

**Status:** early, macOS first (Linux/Windows via CLI-only mode below). Use it with subscriptions **you own** — it is
not a way to share one account between people. MIT licensed.

- **Sticky routing.** A session stays on one account (its cache lives there). New sessions start on the account with
  the most headroom. Rate-limited → cooldown, replay on another account, logged. A session whose account passes 95% of a
  window moves to one with more headroom *before* it gets rate-limited, and every switch posts a macOS notification.
- **Ledger.** Every request joined to your session transcripts by request id: cache read/write per turn, bursts and
  why they happened, per-window headroom, per-session cost.
- **Console** at `http://localhost:4001/router/`: accounts, sessions (switch with one click), cache manager, budgets, insights.
- **Brain** (optional, off by default). Plain Markdown notes about your past sessions, and skills extracted from them, so the
  next session looks things up instead of working them out again.


## What it looks like

| Session timeline — which account each turn ran on, and what every switch cost | Cache manager — bursts and why they happened |
| --- | --- |
| ![timeline](docs/img/timeline.png) | ![cache](docs/img/cache.png) |

| Accounts & routing — headroom per window, one-click switch | Cost & budgets — pooled windows, thresholds, per-session share |
| --- | --- |
| ![accounts](docs/img/accounts.png) | ![cost](docs/img/cost.png) |

| Insights — unused tools, oversized contexts, when bursts happen |
| --- |
| ![insights](docs/img/insights.png) |

## Setup (macOS)

**Homebrew** (run `brew update` first if your Homebrew is older than 4.x):

```bash
brew tap yp201/tap && brew install agent-router && brew services start agent-router && agent-router install
```

**Plain Node** (any Node 24+, no Homebrew):

```bash
git clone https://github.com/yp201/agent-router.git && cd agent-router && ./agent-router.sh install
```

Both do the same thing; pick whichever you prefer. Upgrading: `brew upgrade agent-router` or `git pull && ./agent-router.sh restart`. Releases: `docs/RELEASING.md`.

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

## Context advisor

When a session's context first passes 70% of its window (85% again as "urgent"), the router reads that session's transcript
locally, sizes what fills it — biggest tool results, files read more than once, tokens per tool — and asks Haiku, through
your own `claude` CLI, for the three biggest avoidable items and whether to hand off now. You get a macOS notification and an
advice card under the session in the console, with a **Write handoff summary** button that drafts a summary to paste into a
fresh session. Only tool names, targets and sizes are stored, never tool output. Thresholds, per-model windows and the model
live in settings (`context_warn_pct`, `context_urgent_pct`, `context_windows`, `advisor_model`, `advisor_enabled`); `NOTIFY=0` mutes it.

## Budgets

A budget is a spend limit over a scope (everything, one project, one account, or every session individually) and a period
(day = since local midnight, week = the last 7×24 h, rolling, or the session's whole life). Add them in the console under
**Cost & budgets**, or `PUT /router/settings` with `budgets: [...]`. There are none until you add one.

- **Unit:** input-equivalent tokens, the same for every model: `input + 0.1 × cache read + 1.25 × cache write (5m) + 2 × cache write (1h) + 5 × output`.
  Usage is read from each response as it streams through, so spend is current to the last request. Dollars are shown only for models in your rate card.
- **notify** posts one macOS notification the first time the budget passes 80% and 100% in a period.
- **stop** also refuses further `/v1/messages` requests in that scope once it is at 100%: Claude Code shows
  `API Error: 400 agent-router budget ‘…’ is spent: 2.1M of 2M input-equivalent tokens today. It resets Fri 00:00. Raise or remove it at http://localhost:4001/router/#cost`
  and ends the turn (no retries). Raise or delete the budget to continue. Token counting and other endpoints are never blocked.

```bash
# 2M units a day for one project (notify), and a 5M cap on any single session (stop: the runaway-agent guard)
curl -X PUT localhost:4001/router/settings -d '{"budgets": [
  {"id": "cf-day", "name": "climatefluent / day", "scope": "project", "match": "climatefluent", "period": "day", "limit": 2000000, "action": "notify", "thresholds": [0.8, 1]},
  {"id": "cap", "name": "per-session cap", "scope": "session", "match": null, "period": "session", "limit": 5000000, "action": "stop", "thresholds": [0.8, 1]}]}'
```

A project is the basename of the session's working directory, known once the session's transcript has been read: the first
request or two of a brand-new session are not counted against (or stopped by) a project budget.

## Brain

Off until you enable it in the console's **Brain** tab (or `PUT /router/settings {"brain_enabled": true}`). It writes plain
Markdown into one folder, `~/agent-router-brain` by default (`brain_dir`), laid out so it opens as an Obsidian vault:

```
_CLAUDE.md  index.md  CRITICAL_FACTS.md  log.md
wiki/logs/       one note per session: what you asked, files written, commands that worked, tools, subagents, account switches
wiki/projects/   one note per project: dated decisions, learnings and open threads, plus its sessions
wiki/daily/      one note per day: sessions and spend
skills/          one note per promoted skill;  skills/candidates/<name>/SKILL.md  awaiting your review
```

- **Capture is free.** A session that has been idle for 15 minutes gets its note straight from its transcript; no model is
  called. Prompts are cut to 300 characters, commands to 200, obvious secrets (API keys, bearer tokens, `password=`, private
  keys) are redacted, tool output is never copied. Text you write outside the `<!-- agent-router:begin/end -->` markers is kept.
- **Distilling spends quota, and only when asked.** Click **Distill** on a session (or set `brain_distill` to `on_idle`). A
  classifier first decides whether the session is worth it: [TypeSafe's Jev](https://docs.typesafe.ai) if you have a key
  (`TYPESAFE_API_KEY` or `~/.agent-router/typesafe.key`), otherwise Haiku. Only then does Sonnet write the summary, the dated
  bullets for the project note and, when the session worked out a reusable procedure, a skill candidate. Both models run
  through your own `claude` CLI and this router; their requests are tagged, summed in the same units as budgets, and stop at
  `brain_daily_units` (200k a day by default). Over the cap, work is queued for the next day.
- **Skills go candidate → promoted, by hand.** A candidate (extracted, or imported from an https URL to one `SKILL.md`) is just
  a file in the vault. **Promote** copies it to `~/.claude/skills/<name>/` with a marker file, so every new session loads it;
  a skill directory the router did not install is never overwritten. **Demote** removes it again, **Reject** deletes the
  candidate. The console counts each skill's uses from `Skill` tool calls in your transcripts and flags promoted skills
  unused for 30 days. No savings are claimed.
- **Recall.** *Install recall skill* adds a small `brain` skill that tells Claude to read the vault's index and at most three
  notes when you refer to past work.

Settings: `brain_enabled`, `brain_dir`, `brain_distill` (`manual` | `on_idle`), `brain_daily_units`, `classifier`
(`auto` | `jev` | `model`), `brain_classifier_model` (`haiku`), `brain_writer_model` (`sonnet`), `brain_confidence` (0.7).
Design and the choices behind it: `docs/BRAIN.md`.

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
node --test test_router.ts   # 28 tests, fake upstream, no network
```

`router.ts` proxy + routing · `accounts.ts` token store · `tailer.ts` transcript join · `console.ts` analytics · `advisor.ts` context advisor · `brain.ts` notes and skills ·
`ui.html` console · `agent-router.sh` install/status/uninstall. Plan and findings: `PLAN.md`, `NOTES.md`, `docs/`.

Tokens are read from the official CLI's credential store at request time; a refreshed token is written back to that same
store (the CLI's own) and never written to the ledger, logs or UI.
The ledger stores no request bodies — only hashes, counts and token totals. The optional brain, when you enable it, writes
excerpts of your own prompts and commands to a folder you choose.
