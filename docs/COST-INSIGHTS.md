# Cost insights — plan

**Rule: propose a saving only when quality is unchanged, or say plainly that quality is unverified.**
Every number comes from arithmetic over the ledger at list prices. No recommendation is produced by a model.

Sources: Claude Code [costs](https://code.claude.com/docs/en/costs) and
[prompt caching](https://code.claude.com/docs/en/prompt-caching) docs, API
[pricing](https://platform.claude.com/docs/en/about-claude/pricing) (fetched 2026-10-01).

## What one week of this machine's ledger says

| | Opus 5.5 | Fable 5.1 |
|---|---|---|
| Turns | 1,888 | 966 |
| Cache read / written / output | 495.5M / 21.2M / 0.73M | 418.5M / 7.7M / 0.95M |
| List-price cost | $235.70 | $301.14 |
| Share: reads / writes / output | 42% / 52% / 6% | 35% / 49% / 16% |

- Cache **writes are half the cost**; output is small. Avoiding rewrites beats everything else.
- Subagents are 30% of spend ($160 of $538).
- Same tokens on Sonnet 5.5 instead of Opus 5.5: −29%, not −50%. Cache reads cost $0.20/MTok on both.
- Same tokens on Opus 5.5 instead of Fable 5.1: −46%.
- Main conversation on a 5-minute cache instead of 1 hour: **+60%** (58 turns followed a 5–60 minute pause).
- Subagents on a 1-hour cache instead of 5 minutes: −5%.

## Corrections this research forces

1. **Unit.** Budgets and insights move to **dollars at list price** using the built-in table below (overridable by
   `rate_card`, shown with its as-of date). "Input-equivalent tokens" hid a 10× price gap between models and used a
   0.1× read multiplier that is wrong for Opus 5.5 (0.05×) and Fable 5.1 (0.025×).
2. **CLAUDE.md.** Editing it mid-session does not invalidate the cache (and does not apply until the next session).
   Remove that cause and fix text everywhere.
3. **Tool search.** A custom `ANTHROPIC_BASE_URL` turns tool search off, so every tool definition loads upfront.
   Observed here: terminal sessions through the explicit port send 68 definitions with no ToolSearch tool; desktop
   sessions (transparent mode) have it. README and `install --explicit` must set `ENABLE_TOOL_SEARCH=true`.
4. **Unused tools insight.** Count only tools actually loaded (not `defer_loading`), or it overstates.

| $/MTok | input | 5m write | 1h write | read | output |
|---|---|---|---|---|---|
| Fable 5.1 | 10 | 12.50 | 20 | 0.25 | 50 |
| Opus 5.5 | 4 | 5 | 8 | 0.20 | 20 |
| Opus 5 | 5 | 6.25 | 10 | 0.50 | 25 |
| Sonnet 5.5 / Sonnet 5 | 2 | 2.50 | 4 | 0.20 | 10 |
| Haiku 4.5 | 1 | 1.25 | 2 | 0.10 | 5 |

Fast mode on Opus 5.5 doubles input and output prices.

## Tier A — waste, no quality change (build first)

| # | Insight | Signal | Recommendation shown |
|---|---|---|---|
| A1 | **Every rewrite gets its real cause** | Fingerprint what the docs say is in the cache key: model, effort, fast-mode header, loaded tool set, system prompt, image count, CLI version; compaction and tool-result clearing counted as expected | "You switched model at turn 40: $4.10 to re-cache 512k. Pick the model at session start." |
| A2 | **Going cold** | Session with a large cached context N minutes from its cache lifetime (1h main, 5m subagents, 5m on usage credits) | Notification: "‘Bicycle studio’ goes cold in 5 min. A message now costs $0.10; after that the next turn costs $4.10." No request is sent by the router. |
| A3 | **Cache lifetime fit** | Replay each bucket's real gaps under 5m and 1h | "Keep 1h for the main conversation: 5m would cost 60% more." / "Set `subagentPromptCacheTtl` to `1h`: saves $8 a week." Names the exact setting. |
| A4 | **Carrying cost** | Each tool result's size × read price × turns it stayed in context | Top offenders with dollars: "One 48k file read was re-read on 300 turns: $2.90." Suggest offset/limit, a subagent, or the test-output hook from the docs. |
| A5 | **Task boundaries** | Prompts classified as unrelated to the work before them (Jev or Haiku, from the brain's session notes) | "Three unrelated tasks in one session. `/clear` between them would have saved $31." Confidence shown. |
| A6 | **Idle fires** | Turns with no user prompt at regular intervals (loops, scheduled tasks, goal check-ins) on a large context | "A loop fired 22 times while you were away, re-reading 480k each time: $2.10." |
| A7 | **Gateway check** | No ToolSearch tool and many definitions in the request | "Tool search is off for terminal sessions. Set `ENABLE_TOOL_SEARCH=true`." |

## Tier B — model and effort choices, shown with evidence

| # | Insight | What is exact | What is not |
|---|---|---|---|
| B1 | **Model what-if** | Price of the same tokens on each model, including the one-time rewrite when switching mid-session and the break-even turn count | Whether the cheaper model would have done the work as well |
| B2 | **Safe switches** | Same family, newer and cheaper (Opus 5 → Opus 5.5). Read-only exploration subagents → `model: haiku`, which the docs recommend; subagents classified by their tool mix | — |
| B3 | **Effort** | Thinking share of output cost per session | Output is 6–16% of cost here, so the ceiling is low; shown last |
| B4 | **Quality evidence** | From the user's own transcripts, per model and task type: rewinds, corrections, repeated edits to one file, failed tool calls | Observational, not causal. An opt-in shadow test (replay a sample of small-context turns on the cheaper model and compare the next action) gives real evidence but costs tokens, so it gets its own budget. |

Until B4 has data, B1 and B3 carry the label **"saving if quality holds — unverified."**

## Not building

- **MCTS / workflow search.** It searches agent pipelines against a benchmark with many model calls per step. For one
  person's interactive sessions it would spend more than it saves, and there is no score function. What we take from
  it is the objective (quality minus cost); the tools are replay arithmetic and a small shadow test.
- **Local models for the coding loop.** That is a quality trade. A local model is only an optional classifier backend
  for the brain (order: Jev → local → Haiku), added when someone asks.
- **Router-originated keep-warm requests.** A2 notifies instead; the router keeps to forwarding what the client sends.

## Where it shows up

Insights tab becomes a ranked list of dollar findings for the week, each with cause, evidence, the exact setting or
command, and a quality label (none / unverified). Cache tab gains the A1 causes. Sessions rows show carrying cost.
`agent-router report` prints the same list.

## Overlap with Claude Code itself

`/usage` now shows cache misses with a likely cause for the main conversation, and `/insights` reports on work
patterns. What this adds: subagents, history across sessions and accounts, dollars, what-if replays, and a warning
before the cache goes cold.
