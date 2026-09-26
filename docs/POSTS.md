# Launch posts (final text per venue)

## Reddit — r/ClaudeAI (image post: docs/img/timeline.png or the Bicycle-studio crop)

**Title:** My Claude Code session hit the limit four times and kept going — I built a local proxy that routes sessions between my own accounts

**Body:**
I kept running into Claude Code's limits at the wrong moments, so I built the thing I wished existed.

agent-router is a small local proxy in front of Claude Code (desktop app and CLI). If you own more than one Claude subscription, it keeps your session intact and routes it to whichever account has headroom — automatically, before the wall, with a notification when it moves. So a long task you walked away from doesn't stop. It also shows one meter across your accounts (from Anthropic's rate-limit headers, not estimates) and explains your prompt cache: why it got rewritten and whether you could have avoided it.

The screenshot is one real session: 7,309 turns, moved four times, the label on each marker is what the switch actually cost.

Zero dependencies (Node + SQLite), MIT, early. For accounts you own — not a way to share one subscription. The README says exactly what it changes on your machine (a local CA and a hosts entry for the desktop app; the CLI needs neither) before you install, and uninstall reverses it in one command. No request bodies stored, no telemetry.

`brew tap yp201/tap && brew install agent-router`
https://github.com/yp201/agent-router

If you try it and it helps, tell me what you'd want next — that decides what I build.

## Hacker News — Show HN

**Title:** Show HN: A local proxy that routes Claude Code sessions between your accounts and explains your cache
**URL:** https://github.com/yp201/agent-router

**First comment (post it yourself right after submitting):**
Author here. I kept hitting Claude Code's limits mid-task, so this sits in front of it (desktop app and CLI) and routes each session to whichever of my subscriptions has headroom, moving it before it hits the wall. Sessions stay intact — the switch is a header swap; the cost is a cache re-write on the new account, which the ledger measures (first move ~50k tokens, moving back within the hour ~200).

Things worth knowing before you install: the desktop app hard-codes api.anthropic.com and ignores every config option, so capturing it means a locally generated CA plus a hosts entry — the README says so up front and `uninstall` reverses it. The CLI path needs neither. Zero dependencies (Node 24 + SQLite), ~1,800 lines, MIT. It's for accounts you own; shared pools are out of scope on purpose.

The part I didn't expect to be useful: joining every request to the session transcript by request-id. That's how it explains cache bursts (tool list changed, CLAUDE.md edited mid-session, idle past the 1h TTL, account switch) instead of just counting tokens.

Happy to answer anything about the routing or the transparent mode.

## X / Twitter

I kept running into Claude Code's limits at the wrong moments, so I built the thing I wished existed.

agent-router: a local proxy that keeps your session intact and routes it between your own Claude accounts before it hits the wall. One meter, from the real headers. Explains your cache.

Zero deps, MIT.
https://github.com/yp201/agent-router

[image: timeline crop]

## Substack — long-form (draft in docs/SUBSTACK.md)
