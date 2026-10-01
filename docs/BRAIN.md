# Brain — design

**Goal: spend fewer tokens by not re-deriving what a past session already worked out.**
Everything is plain files in one folder. The router is the automatic writer; the console's Brain tab and
Obsidian are viewers. Off by default.

## Vault

Default `~/agent-router-brain` (setting `brain_dir`; not under Documents/Desktop — macOS blocks those for
launchd services). Layout follows the wiki-style vault of
[obsidian-second-brain](https://github.com/eugeniughelbur/obsidian-second-brain) (MIT) so its commands work on the
same folder if the user installs it. Its rule: the vault's `_CLAUDE.md` Folder Map is authoritative.

```
_CLAUDE.md            operating manual + Folder Map (generated once, then user-owned)
index.md              catalogue of every note, regenerated; Claude reads this first
CRITICAL_FACTS.md     <= ~120 tokens, user-written, never overwritten by the router
log.md                append-only: what the router wrote and why
wiki/logs/            one note per session (what happened)            generated, free
wiki/projects/        one note per project (what is true): decisions, learnings, gotchas, each dated
wiki/daily/           one note per day: sessions, spend
skills/               one note per promoted skill: source sessions, uses, cost
skills/candidates/    <name>/SKILL.md extracted from sessions or imported, awaiting review
```

Generated content sits between `<!-- agent-router:begin -->` and `<!-- agent-router:end -->`. Anything outside
the markers is the user's and is preserved on every rewrite. Notes use YAML frontmatter and `[[wikilinks]]`.

## Pipeline

1. **Capture (no model call).** When a session has been idle 15 minutes (or on demand) write its
   `wiki/logs/YYYY-MM-DD <title>.md`: frontmatter (session, project, started, ended, turns, models, accounts,
   units, cache hit, peak context, tags) and sections Asked (user prompts, <= 300 chars each, reminder blocks
   stripped), Files touched, Commands run (successful Bash commands, <= 200 chars each), Tools, Subagents,
   Account switches. Regenerate the day note, the project note's session list and `index.md`.
2. **Gate (classification).** Deterministic pre-filter first: >= 8 tool calls, at least one file written or
   command run, not already processed. Then typed questions over the session note:
   - `reusable` (noul): the session worked out a multi-step procedure that would apply in other projects
   - `kind` (choice): `skill` | `project-knowledge` | `nothing`
   - `matches` (choice): an existing skill name, or `new`
   Backend `classifier: auto` = Jev when a TypeSafe key exists (`TYPESAFE_API_KEY` or
   `~/.agent-router/typesafe.key`, mode 600), else `brain_classifier_model` (default `haiku`) through the existing `claude -p` runner returning
   the same JSON. The classifier never writes notes or skills; it only decides whether the writer runs. Proceed only at confidence >= `brain_confidence` (0.7). Every answer is stored with its backend
   and confidence so the two can be compared.
   Jev wire format: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, body
   `{state, model: "jev-latest", questions: {key: {type, instructions, criteria}}}`, response
   `{answers: {key: {type, <value>, confidence, probabilities}}, usage}`. Confirm `criteria` for choice at
   https://docs.typesafe.ai/primitives/choice before coding.
3. **Distill (one Sonnet call per gated session).** The writer is a separate, stronger model than the
   classifier: `brain_writer_model`, default the CLI alias `sonnet` (resolves to the newest Sonnet the account has). Structured input, capped near 8k tokens, never the raw
   transcript. Output JSON: `summary`, `decisions[]`, `learnings[]`, `open_threads[]`, `tags[]`, and
   `skill: {name, description, body} | null`. Writes the session note's distilled block, appends dated bullets
   to the project note (exact-duplicate lines dropped), and writes a skill candidate when present.
   A "Consolidate" button runs one further writer call to merge and rewrite a project note.
4. **Skills.** Candidates never reach Claude Code on their own. **Promote** copies
   `skills/candidates/<name>/` to `~/.claude/skills/<name>/` (user-level, so every project gets it) with a
   `.agent-router` marker; an existing skill directory without that marker is never overwritten. **Demote**
   moves it back. **Import from URL** fetches one `SKILL.md` (https only, 200 KB cap, text only, no bundled
   scripts in v1) into candidates with `source: <url>`.
5. **Recall.** A `brain` skill (installed by a button) tells Claude to read `index.md`, grep the vault and open
   at most three notes when the user refers to past work. The bounded per-prompt recall hook from
   obsidian-second-brain is a later, opt-in addition.

## Cost accounting

- **Brain spend is exact.** Gate and distill calls go through the router; they are tagged `source = brain` and
  summed in units. `brain_daily_units` (default 200k) caps the day; over the cap, work queues until tomorrow.
- **Skill use is counted, savings are not claimed.** Transcripts record each Skill tool call by name. Per skill
  the console shows uses, sessions, projects, last used, and the units the source session spent working it out.
- **A promoted skill costs prefix tokens in every session** (its description line). Skills unused for 30 days
  are flagged for demotion. Promotion changes the skill list, so it applies from the next session.

## Viewer (console Brain tab)

Tree on the left (Sessions by date, Projects, Skills promoted / candidates, Daily, Index, Facts), rendered
Markdown in the middle (small built-in renderer; `[[wikilinks]]` navigate in place), search across the vault
with snippets. Actions: Distill, Consolidate, Promote / Reject / Demote, Import skill from URL, edit
`CRITICAL_FACTS.md`, install the recall skill, open in Obsidian. Header: spend today against the cap, sessions
captured, skills promoted, candidates waiting.

## Settings

`brain_enabled` false · `brain_dir` · `brain_distill` `manual` | `on_idle` · `brain_daily_units` 200000 ·
`classifier` `auto` | `jev` | `model` · `brain_classifier_model` `haiku` · `brain_writer_model` `sonnet` ·
`brain_confidence` 0.7

## Safety

- Off until enabled: the vault holds excerpts of the user's own prompts and commands.
- Excerpts are scrubbed for obvious secrets (API keys, bearer tokens, `password=`) before being written or sent.
- Imported skills are untrusted instructions: candidate only, full text shown, explicit promote.
- The router writes only inside `brain_dir`, plus `~/.claude/skills/<name>/` on promote. Every path from the
  API is resolved and checked to be inside the vault.
- The ledger still stores no bodies; the brain is a separate folder the user chose.
