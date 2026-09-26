# I put a proxy in front of Claude Code. Here's what my tokens were actually doing.

*Subtitle: I kept running into Claude Code's limits at the wrong moments, so I built the thing I wished existed. The routing worked. The surprise was the ledger.*

---

I kept running into Claude Code's limits at the wrong moments. Not at the end of the day — in the middle of a task, with a long agent run half done, on a Saturday. I have more than one Claude subscription. I had no good way to use them together, and no way to see how close I was on either.

So I built a small local proxy that sits in front of Claude Code and does two things: keeps a session intact while routing it to whichever account has headroom, and writes down what every request cost. It's called agent-router. This post is less about the tool and more about what the ledger showed me once it had a few days of my own traffic in it. Some of it changed how I use Claude Code.

## The setup, in one paragraph

Claude Code — the desktop app and the CLI — talks to `api.anthropic.com`. agent-router answers for that hostname on my machine, forwards every request to Anthropic unchanged except for the account header, and logs the response headers and token counts. Every session gets pinned to one account and stays there, because a prompt cache lives on one account and moving a session means re-writing it. It only moves when the account is nearly full or actually rate-limited, and it sends a notification when it does. Then a second process watches Claude Code's own transcript files and joins each API response to the turn that produced it, by request id. That join is where everything below comes from.

## 1. Almost everything is cache. The bill is the part that isn't.

Every turn of a Claude Code session re-sends the whole conversation. What's already cached is read at a tenth of the price; what isn't gets written at a premium. My cache hit rate over a week was 96%. That sounds like a solved problem. It isn't, because the 4% is exactly where the cost lives, and I had no idea what was in it.

So I fingerprinted every request — a hash of the system prompt, a hash of the tool list, the message count — and compared each turn to the one before it. When the cache gets rewritten, one of a handful of things happened:

- **The MCP tool list changed.** A server reconnected, its tools moved in the list, and everything after them in the prefix was invalidated. This was my most common avoidable burst.
- **I edited CLAUDE.md mid-session.** A 200-byte change to the system prompt re-wrote 130k tokens of context.
- **The session sat idle past the one-hour cache TTL.** Lunch. Every time.
- **The session moved accounts.** Expected, and the one I chose.

The console now labels each burst with its cause and whether I could have avoided it. Two of the four causes are habits.

## 2. 74 of my 115 MCP tools had never been called once

Tool definitions sit at the front of every request. I had 115 of them loaded across projects; 41 had ever been used in any session. The other 74 were pure prefix — cached, so cheap per turn, but they're also what gets invalidated when a server reconnects, which is cause number one above. I turned off the servers I don't use per project. Bursts dropped.

## 3. Switching accounts is expensive exactly once

I assumed every switch cost a full cache re-write. The ledger measured the real number on each move, and it split cleanly in two:

- First time a session lands on an account: **~50,000 tokens** written. That's the whole context, cold.
- Moving *back* to an account that served this session within the last hour: **~200 tokens.** The cache was still warm there.

Prompt caches are per account, not per session. So the cheap fallback isn't a random spare account — it's the one that served this exact kind of session most recently. That's now a routing rule, not a guess.

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
