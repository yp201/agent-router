# I put a proxy in front of Claude Code. Here's what my tokens were actually doing.

*Subtitle: I kept running into Claude Code's limits at the wrong moments, so I built the thing I wished existed. The routing worked. The surprise was the ledger.*

---

I kept running into Claude Code's limits at the wrong moments. Not at the end of the day — in the middle of a task, with a long agent run half done, on a Saturday. I have more than one Claude subscription. I had no good way to use them together, and no way to see how close I was on either.

So I built a small local proxy that sits in front of Claude Code and does two things: keeps a session intact while routing it to whichever account has headroom, and writes down what every request cost. It's called agent-router. This post is less about the tool and more about what the ledger showed me once it had a few days of my own traffic in it. Some of it changed how I use Claude Code.

## The setup, in one paragraph

Claude Code — the desktop app and the CLI — talks to `api.anthropic.com`. agent-router answers for that hostname on my machine, forwards every request to Anthropic unchanged except for the account header, and logs the response headers and token counts. Every session gets pinned to one account and stays there, because a prompt cache lives on one account and moving a session means re-writing it. It only moves when the account is nearly full or actually rate-limited, and it sends a notification when it does. Then a second process watches Claude Code's own transcript files and joins each API response to the turn that produced it, by request id. That join is where everything below comes from.

## 1. Almost everything is cache. The bill is the part that isn't.

Every turn of a Claude Code session re-sends the whole conversation. What's already cached is read at a small
fraction of the input price; what isn't gets written at a premium. Over one week my sessions read 914 million tokens
from cache and wrote 29 million. Priced at list rates, those 29 million written tokens were about half the total.
Output, the thing I assumed I was paying for, was 6 to 16 percent.

So the question that matters is: when does the cache get rewritten? The router fingerprints every request and
compares each turn to the one before. In my own week the causes were:

- **A session sat idle past the one-hour cache lifetime.** One five-hour gap re-wrote 468,000 tokens on the next turn.
- **A session moved to another account.** Caches are per account.
- **A few rewrites my fingerprints could not explain.** I'm saying so because a tool that always has an answer is lying.

Claude Code's own docs list what else does it: switching model mid-session, turning on fast mode, changing effort on
most models, and a tool list that changes when tools are loaded upfront. One thing I had wrong: editing CLAUDE.md
mid-session does not rewrite the cache. It doesn't apply until the next session at all.

## 2. Pointing the CLI at a proxy quietly turned off tool search

Claude Code defers MCP tool definitions by default: only names enter the context until a tool is used. With a custom
`ANTHROPIC_BASE_URL`, that is off unless you set `ENABLE_TOOL_SEARCH=true`. My desktop sessions, captured
transparently, had tool search on. My terminal sessions, pointed at the proxy the documented way, were sending all 68
tool definitions in full on every request. The fix is one environment variable, and my own README didn't mention it.

## 3. Switching is not automatically cheaper

Three things I assumed would save money, checked against my own week:

- **Switching accounts.** The first time a session lands on an account it re-writes its context: about 23,000 tokens
  in the case I measured. Moving back within the hour cost about 200, because the cache was still warm there.
- **A shorter cache lifetime.** Five-minute cache writes are cheaper than one-hour writes. Replaying my week with
  five-minute caching would have cost 60 percent more, because 58 turns came after a pause of five to sixty minutes
  and each would have re-written everything.
- **A cheaper model.** The same tokens on Sonnet 5.5 instead of Opus 5.5 come to 29 percent less, not half. Cache
  reads cost the same on both, and reads are most of the tokens. And switching mid-session re-writes the whole
  context on the new model first.

## 4. Long sessions cost four times more per turn, and the tool can't tell you

One session of mine ran to 500k tokens of context. It kept working — the model handles it — but every turn re-read all of it. A fresh session with a handoff summary at 100k would have done the same work for a fraction. Claude Code will auto-compact eventually, but by then you've paid for the long tail and you don't get to choose what's kept.

So the router now watches each session's real context (from the transcript, not an estimate), and at 70% and 85% of the window it builds a breakdown — the biggest tool results, the files read repeatedly, tokens by tool — and offers a handoff summary. The breakdown is free and exact. The summary is one Haiku call, on demand.

## 5. The desktop app really doesn't want to be proxied

The CLI honours `ANTHROPIC_BASE_URL` in settings. The desktop app spawns the same CLI but injects the URL itself and strips that variable from every config layer — user settings, managed settings, inherited environment. I tried all three. What works is answering for `api.anthropic.com` on the machine: a hosts entry plus a locally generated CA that the system trusts. That is a real thing to ask someone to install, so the README says it in plain words before the install command, the CLI path needs none of it, and `uninstall` reverses it in one command.

## What it is, and isn't

agent-router is ~1,800 lines, zero dependencies (Node 24 and its built-in SQLite), MIT. It stores no request bodies — hashes, counts and token totals only — and sends no telemetry. It's early and macOS-first; the CLI-only mode works on Linux with no sudo.

It is for accounts you own. It is not a way to share one subscription between people, and I've deliberately kept shared pools out of scope.

```
brew tap yp201/tap && brew install agent-router
```

https://github.com/yp201/agent-router

If you try it and it helps, tell me what you'd want next. The ledger only gets interesting with more sessions in it, and the things I'd build next — the ones people actually ask for — are the ones I can't see from my own data.
