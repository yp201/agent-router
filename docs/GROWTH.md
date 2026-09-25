# agent-router — S-tier moves and launch plan

## The one sentence
**The real usage meter and cache doctor for Claude Code.** Multi-account routing is a feature for people who own more
than one subscription. It is never the headline.

## Why this can spread
- Rate limits are the #1 complaint of Claude Code power users. Every existing tracker (ccusage, cctally,
  Claude-Code-Usage-Monitor, the status-line plugins) *estimates* usage from transcripts. We read the real
  `anthropic-ratelimit-unified-*` headers on every response. Nobody else has the actual number.
- We are the only thing that captures the **desktop app**, not just the CLI.
- The ledger joined to transcripts is a new data asset: "why did your cache burst, and was it avoidable" does not
  exist anywhere else.

## S-tier moves, ranked by leverage ÷ effort
| # | Move | Why it's S-tier | Effort |
|---|------|-----------------|--------|
| 1 | **Menubar meter** — `5h 25% · 7d 6%` per account, always visible | The number every Max user wants and the app doesn't show clearly. Standalone product; zero ToS surface. | SwiftBar plugin: 1 day (`agent-router status --json` is the plugin). Signed app: P7. |
| 2 | **Weekly Cache Doctor card** — `agent-router report` → an SVG/markdown card: "9% of your window went to 2 avoidable cache rewrites. Causes: …" | People share numbers, not tools. Every card is a screenshot with our name on it. | 1 day (SQL we have + an SVG template, zero deps). |
| 3 | **"Make it a skill" in one click** — recurring preamble → `~/.claude/skills/<name>/SKILL.md` | The wow moment: the app makes you *better* at Claude Code, not just cheaper. | 1 day (one Haiku prompt, already written). |
| 4 | **Two-minute install** — `brew install yp201/tap/agent-router`, then the `.app` | Virality dies at "clone a repo and sudo twice". | Tap: hours. App: P7. |
| 5 | **CLI-only mode, zero sudo** (Linux, Windows, macOS without desktop) | 80% of users at 20% of the friction; no CA, no hosts. | 1 day (ADR addendum). |
| 6 | **One meter for every agent** — Codex/Cursor/Gemini CLI through the same ledger | ccusage's angle, with real numbers. Borrow their audience: ship a ccusage-compatible export first. | `/v1/responses` adapter: 2–3 days. Export: hours. |
| 7 | **Jev decisions** — keep-warm (`Noul`), handoff scoring (`Score`) | Differentiation nobody can copy fast; needs early access. | 1 day once we have the API. |

Do 1–5 before launch. 6–7 are the second act.

## Launch sequence
**Week 0 — polish.** Burst threshold relative to context growth (kills the "unknown" noise). `report` command.
README gif of the console. MIT license, repo public. ccusage-format export.

**Week 1 — soft launch with a number, not a tool.** Post one Cache Doctor card and one insight to r/ClaudeAI, X,
the Claude Discord: *"25 of my 57 MCP tools were never used — 27k tokens on every request. Here's the tool that told me."*
Lead with the finding. Link second.

**Week 2 — Show HN.** *"Show HN: I put a real usage meter and a cache doctor in front of Claude Code."* Brew one-liner
in the first line. The "what you're agreeing to" paragraph in the README is the trust move — say it before they ask.
Answer every comment for 24 hours.

**Week 3 — menubar.** Ship the meter screenshot. Reach out to the ccusage/cctally maintainers with the export — allies,
not competitors. Ask the Claude Code DevRel folks for a look; the cache doctor is genuinely useful to them.

**Ongoing — findings as content.** Every real burst cause is a 300-word post: "Why an MCP reconnect costs you 24k
tokens", "The lunch-break cache cliff", "Your CLAUDE.md edit just invalidated 130k tokens." Weekly. Each links the card.

## What we measure
Stars · brew installs (no telemetry in the app, ever — count tap downloads) · report cards shared (search the card's
footer string) · % of installs that add a second account · cache hit rate before/after (the product's own proof).

## The honest lines — say them first
- **Multi-account is for your own subscriptions.** Never "unlimited Claude". Shared pools are API-key pools (ADR-001).
  The projects that marketed unlimited got the ToS attention; we don't want it and don't need it.
- **Transparent mode is a local CA + hosts entry.** Say so in plain words, one command to undo, and CLI-only mode
  needs neither. Trust is the moat for a tool that sits in front of your API traffic.
- **Anthropic may ship a first-party meter.** Fine — the cache doctor, the switch-cost ledger and the routing remain.
- **No request bodies stored, no telemetry.** Say it on the README's first screen.

## Pre-launch checklist
- [ ] burst threshold = cache_write ≫ context added since last turn
- [ ] `agent-router report` (SVG card + markdown), footer "made with agent-router"
- [ ] "Make it a skill" button (Haiku prompt in docs/GROWTH.md → code)
- [ ] SwiftBar plugin `agent-router.1m.sh`
- [ ] Homebrew tap `yp201/homebrew-tap`
- [ ] CLI-only install path (Linux/Windows), `install --explicit`
- [ ] ccusage-compatible JSON export
- [ ] README: gif, license, "what you're agreeing to" above the fold
- [ ] repo public
