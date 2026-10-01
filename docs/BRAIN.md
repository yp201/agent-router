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
wiki/logs/            one note per session (what happened), plus one per unit of it: `<session note> — <name>.md`   generated, free
wiki/projects/        one note per project (what is true): decisions, learnings, gotchas, each dated
wiki/daily/           one note per day: sessions, spend
skills/               one note per skill that is promoted or came out of a session: status, source units, project, uses, cost
skills/candidates/    <name>/SKILL.md extracted from sessions or imported, awaiting review; for a promoted skill, a proposed update
skills/merged/        <name>/SKILL.md of a fragment a consolidation replaced (merged or covered); kept as it was, restorable
skills/<installed>.notes.md   facts from fragments an installed skill may lack (a consolidation's covered clusters); the installed skill itself is never edited
```

Generated content sits between `<!-- agent-router:begin -->` and `<!-- agent-router:end -->`. Anything outside
the markers is the user's and is preserved on every rewrite. Notes use YAML frontmatter and `[[wikilinks]]`.
A note can hold more than one generated block, so each is rewritten on its own: the session note's distilled part is
`<!-- agent-router:begin distilled -->…<!-- agent-router:end distilled -->`, the project note's bullets are
`…begin knowledge…`. Frontmatter keys the router owns are rewritten in place; keys the user adds are kept; `tags` is a union.
`skills/<name>.md` exists while the skill is promoted or has a source session: it links that session, its project and the `SKILL.md`,
and the session's distilled block ends with `Skill candidate: [[skills/<name>|<name>]]` (kept in step with the ledger on every index pass, so a
later extract that returns no skill does not drop it; a reject removes it). An imported skill's note is removed on demote; a skill note the user
wrote in is never deleted.

## Units

A pipeline row is a **unit**, not only a session. A unit is one of:

- a **session's main thread** (as before; a session with no other units is one unit);
- a **subagent run**: one `<session>/subagents/agent-<id>.jsonl` with 8 tool calls or more. Smaller runs stay a name in the
  session note's Subagents list;
- a **task segment** of a main thread with more than 150 tool calls: the thread is cut at typed prompts of 15 characters or more
  (reminder blocks stripped, tool-result turns ignored), a cut is made only once the segment so far holds 25 tool calls, and a
  short tail joins the segment before it.

Why: a session that delegates its work shows none of it in its own note. Measured on a real one ("Google Docs link"): 29 subagents
with 1,608 tool calls, 814 more on the main thread of which the note kept the last 80 commands, scanned `reusable = false`.

Each subagent or segment unit has its own note next to the session's, `wiki/logs/<date> <session title> — <name>.md` (a segment is
`— part N`), written by the session's capture: frontmatter (`unit`, `kind`, `parent`, `agent`, project, started, ended, turns, model,
tool calls, usd at list price from the ledger rows of that `agent_id`, or of that time window for a segment), a `Trace:` line (a link to the console's Trace view and
"214 steps → 38 after pruning") and sections **Brief**
(a subagent's first message, 1,500 characters; a segment's prompts), **Commands that worked** (every distinct Bash command whose
result was not an error, 300 characters each; no cap of 80, but past ~3,000 tokens only the first of each command family and the
final third of the run are listed), **Files written**, **Tools**, **Final report** (a `SubagentHandback` message if the run ended
with one, else the last assistant text, 2,000 characters). Everything is scrubbed like the session note. The session note's
Subagents and Task segments sections link each unit note; the unit note links its session and project. The session note keeps
its own overview (the last 80 commands); `index.md`, the day note and the project note list sessions only.

As built: units are rows of `brain_sessions` (`kind` `session` | `subagent` | `segment`, `parent` = the session, `agent_id`,
`seg_index`, `name`, `started`; the key is `<session>/<agent id>` or `<session>/seg-<n>`), so rows from before units are sessions
and keep their scan and extract state. A command family is its `commandKeys()` tuple (see Trace).

## Pipeline

1. **Capture (no model call).** When a session has been idle 15 minutes (or on demand) write its
   `wiki/logs/YYYY-MM-DD <title>.md`: frontmatter (session, project, started, ended, turns, models, accounts,
   usd at list price, cache hit, peak context, tags) and sections Asked (user prompts, <= 300 chars each, reminder blocks
   stripped), Files touched, Commands run (successful Bash commands, <= 200 chars each), Tools, Subagents,
   Account switches. Regenerate the day note, the project note's session list and `index.md`.
   As built: a note lists the last 80 distinct commands (the rest are counted); the transcript is the path the tailer
   recorded, else `<projects>/*/<session>.jsonl` by name, so sessions from before the router are captured too; a session
   whose requests carry `source` (the brain's or advisor's own calls) is never captured; `POST /router/brain/capture`
   forces one session or all. The file is `YYYY-MM-DD <sanitised title>.md`; a retitle renames it, and the `session` key
   in the frontmatter finds a note again if it was moved inside `wiki/logs/`.
2. **Scan (the gate: classification).** Deterministic pre-filter first: >= 8 tool calls, at least one file written or
   command run, not already processed. Then typed questions over the session note:
   - `reusable` (noul): "The session worked out a multi-step procedure (commands, tool sequence, or workflow) that the same person would
     want to repeat in a different project — for example setting up a pipeline, producing a video, deploying a service. A one-off fix or a
     discussion is not reusable."
   - `kind` (choice): `skill` | `project-knowledge` | `nothing`
   - `matches` (choice): an existing skill name, or `new`
   Backend `classifier: auto` = Jev when a TypeSafe key exists (`TYPESAFE_API_KEY` or
   `~/.agent-router/typesafe.key`, mode 600), else `brain_classifier_model` (default `haiku`) through the existing `claude -p` runner returning
   the same JSON. The classifier never writes notes or skills; it only decides whether the writer runs. Proceed only at confidence >= `brain_confidence` (0.7). Every answer is stored with its backend
   and confidence so the two can be compared.
   Jev wire format (confirmed against docs.typesafe.ai): `POST https://api.typesafe.ai/v1/systemone`,
   `Authorization: Bearer`, body `{state, model: "jev-latest", questions: {key: {type, instructions, criteria}}}`.
   choice: `criteria` is `{option: description}`, the answer is `{type, choice, confidence, probabilities}`.
   noul: the answer is only `{type, noul}` (the probability of yes), with no confidence of its own, so it is stored as
   `value = noul >= 0.5`, `confidence = max(noul, 1 - noul)`. A Jev error or malformed answer falls back to the model.
   As built: the writer runs when `kind` is not `nothing` at the confidence; a skill is asked for only when `kind` is
   `skill`, `reusable` is true at the confidence and `matches` is `new`. `matches` is only asked once a skill exists.
   A model answer that is not the JSON asked for is no gate at all. "Distill anyway" skips the gate.
   `POST scan {session}` runs this step alone and stores the answer; the writer is not called. A distill then uses a stored scan that no
   writer has used yet and that is newer than the session's last turn; otherwise it scans first. A scan over the cap is refused (409), not queued.
   **Per unit.** `session` in `scan` / `distill` is a unit key. A subagent or segment unit is gated on its own Brief, the first 40 lines of its
   minimal trace and its Final report, not the session's note, with the same questions and the same pre-filter.
   **Matching.** `matches` lists every existing skill and candidate with its one-line description and asks: "Answer with an existing
   skill only if this run performs the same procedure with the same main tools; similar topic is not enough. When unsure, answer new."
   For `kind = skill` and `reusable` at the confidence, `matches = new` (or an unsure match) asks the writer for a new skill;
   `matches = <skill>` at the confidence is **refine mode** (`gate.refine`). Only skills the brain made or imported and still owns are offered:
   never the built-in recall skill (`brain_skills.source = 'builtin'`), and never a promoted skill whose installed directory has lost its
   `.agent-router` marker. A stored scan that names one anyway is read as `new`.
3. **Distill (one Sonnet call per gated session).** The writer is a separate, stronger model than the
   classifier: `brain_writer_model`, default the CLI alias `sonnet` (resolves to the newest Sonnet the account has). Structured input, capped near 8k tokens, never the raw
   transcript. Output JSON: `summary`, `decisions[]`, `learnings[]`, `open_threads[]`, `tags[]`, and
   `skill: {name, description, body} | null`. Writes the session note's distilled block, appends dated bullets
   to the project note (exact-duplicate lines dropped; distilling a session again replaces that session's bullets),
   and writes a skill candidate when present and the gate asked for one. When the scan said `kind = skill` (and asked for one) the prompt
   asks for the skill outright: a name, a when-to-use description, and a body with `## Prerequisites`, `## Steps` (numbered, the exact
   commands that worked), `## Pitfalls` (seen in the session) and a short `## Verify` step; prerequisites name tools, versions and
   keys, never their values; inventing a step is forbidden.
   A subagent or segment unit sends `run` instead of the session extract: its Brief, its **minimal trace** (see Trace) and its Final report
   (the note's own Commands and Files lists are no longer sent); its summary goes into that unit note's distilled block and its bullets onto
   the project note. The output schema and refine mode are unchanged.
   **Refine mode** (the gate matched an existing skill): the input also carries that skill's current `SKILL.md`, and the writer
   returns the improved skill under the same name (keep what is still right, replace steps this run did better, add pitfalls this
   run hit, never drop a prerequisite without evidence) plus a one-line `changelog`. The classifier sees only descriptions, so the
   writer has the last word: if it finds a different procedure it answers under a new name, which is a new candidate, and the
   matched skill is left alone (measured: Haiku matched JS/ffmpeg trailer builds to a yt-dlp/Python prototype skill at 0.85).
   A refined **candidate** is rewritten in place. A refined **promoted** skill is never touched where it is installed: the new text
   goes to `skills/candidates/<name>/SKILL.md` as a proposed update (`brain_skills.update_ts`; the console shows it against the
   installed copy as a line diff). **Promote** applies it, **Reject** discards it (the vault copy becomes the installed one again).
   Every unit that wrote or refined a skill is in `skill_sources(skill, unit_id, ts, mode 'create'|'refine', note)`; the skill note
   lists them with the changelog lines, and each of those units' notes links the skill.
   **Order.** A session's units are processed oldest first. They are usually scanned in one go, before any has written a skill, so
   none could match a sibling's: a unit whose stored scan asked for a skill is scanned again at extract time if a skill has appeared
   since, so later runs refine the earlier one's skill instead of repeating it.
   What each scan and extract cost is stored per unit (`brain_sessions.scan_usd`, `extract_usd`): the brain-tagged spend logged while
   the call ran.
   **How a writer call ends** is stored on the unit (`brain_sessions.extract_result`, a short `extract_detail`, never model output beyond a 120-character parse error) and shown
   on its pipeline row, so no call is silent:
   | `extract_result` | meaning |
   | --- | --- |
   | `skill_created` | a new candidate was written |
   | `skill_refined` | an existing candidate (or a proposed update to a promoted skill) was improved |
   | `no_skill` | the writer answered, and no skill came of it: `writer returned skill: null`, `skill dropped: skill_exists (name)` (the name belongs to another unit's candidate), an incomplete skill, or none was asked for |
   | `parse_failed` | the reply was not the JSON object asked for, twice: it is asked once more with "return only the JSON object"; the failed text is only in one log line |
   | `writer_error` | `claude` exited non-zero or printed nothing |
   | `timeout` | no answer within 180 s |
   Only `skill_*` and `no_skill` set `distilled_ts`; the other three leave the unit to extract again (**Retry**). When the scan said `skill` (or named a skill to refine) at the
   confidence and the result is `no_skill`, the row shows an amber **no skill written** chip with the detail and **Retry**. Retry (and "Distill anyway" on a unit with a stored scan that
   asked for a skill) keeps that scan: the writer is asked for the skill outright, or to refine the skill named, as the scan said. (A forced distill used to replace the scan with
   "want a skill, maybe"; handed a 192-step run and no prompt to write one, the writer answered `skill: null`: measured, 2 of 3 runs on the richest unit of a real session.)
   A unit extracted again that already wrote a candidate improves that candidate in place (refine mode on its own skill) instead of inventing a second name.
   The outline the writer reads is cut in the middle when it is over the cap (see Trace); `brain_sessions.trace_trimmed` is 1 then, and the row shows a "trace trimmed" chip.
   In refine mode a writer that decides the run is a different procedure answers with the new skill and `"related_to": "<the matched name>"`; the unit is then linked to both
   (`skill_sources` mode `related` on the matched skill, `create` on the new one), so a consolidation sees the relation.
   A "Consolidate notes" button runs one further writer call to merge and rewrite a project note.
4. **Skills.** Candidates never reach Claude Code on their own. **Promote** copies
   `skills/candidates/<name>/` to `~/.claude/skills/<name>/` (user-level, so every project gets it) with a
   `.agent-router` marker; an existing skill directory without that marker is never overwritten. **Demote**
   removes the installed copy (only if it carries the marker); the candidate copy never left the vault, and is restored
   from the installed one if it was deleted. **Reject** deletes the candidate; the writer does not propose that name
   again, an import may. **Import from URL** fetches one `SKILL.md` (https only, 200 KB cap, text only, at most 3
   redirects, no bundled scripts in v1) into candidates with `source: <url>`; `github.com/<o>/<r>/blob|tree/<ref>/…`
   is rewritten to the raw file (`<ref>` must be one path segment). In the console a candidate is shown as raw text.
5. **Recall.** A `brain` skill (installed by a button) tells Claude to read `index.md`, grep the vault and open
   at most three notes when the user refers to past work. It is installed through the same promote path (marker,
   never over an unmarked `brain` directory) and shows up in the skills table. The bounded per-prompt recall hook from
   obsidian-second-brain is a later, opt-in addition.

## Consolidation

Extraction is per unit, so a long procedure comes out as fragments (a real session's video and voice work gave nine). Consolidation turns the fragments of one project, or one
session, into the smallest set of end-to-end skills. It is a **proposal**: nothing changes until the user applies clusters of it.

- **Input.** Every candidate with a source unit in the scope (a project is the session's cwd name): name, description, the whole `SKILL.md`, the titles of its source units and their
  count (units of mode `create`, `refine` or `merge`, not `related`). And the skills in the skills dir as name, description and whether they carry the `.agent-router` marker (the
  recall skill and a skill with no description are left out). Sent to the writer model (`brain_writer_model`) through the same runner (source `brain`, inside the daily cap).
- **One call**, strict JSON: `{clusters: [{skill: {name, description, body} | null, covered_by: "<installed skill>" | null, replaces: [fragment…], rationale, additions_for_installed: […]}], untouched: […]}`.
  The prompt: merge fragments that are steps or variants of one procedure into one end-to-end skill (setup, main steps, variants, verification, pitfalls; the fragments' exact commands; no
  invented step); a lone fragment stays untouched; if an installed skill covers the same job with the same main tools, set `covered_by`, write no competing skill, and list only
  concrete facts its description does not mention ("may already be covered: …": the model sees descriptions only). The plan is cleaned before it is stored: unknown fragment or skill names,
  a fragment claimed twice, a bad or taken name and a cluster that does nothing are dropped.
- **Too many candidates for one call** (over 80,000 characters of `SKILL.md`, about 20k tokens): fragments are grouped by what they share (words of name and description that most
  fragments do not share, the executables of their commands, a little for the same session), small groups ride together, a group over the budget is cut in arrival order, and each group is one call.
- **Stored** in `brain_consolidations(id, scope 'project'|'session', scope_key, ts, plan_json, usd, status 'proposed'|'applied'|'dismissed')`; a newer proposal for the same scope dismisses an
  unanswered older one. `plan_json.applied` lists the clusters already applied (the status is `applied` once all are).
- **Apply** (`POST consolidations/<id>/apply {clusters: [index…]}`), per cluster:
  - *merge* (`skill` set): the merged skill is written as a new candidate (`skills/candidates/<name>/SKILL.md`; source `session`; `skill_sources` mode `merge` for the union of the
    fragments' source units); each fragment it replaces gets `status = 'merged'`, `merged_into`, and moves to `skills/merged/<name>/`; it leaves the candidate list, the match targets and the graph.
  - *covered* (`covered_by` set): each fragment gets `status = 'covered'`, `covered_by`, and moves the same way; the additions go into the generated block of `skills/<installed>.notes.md`.
    **An installed skill is never edited**, with the marker or without.
  - Nothing is promoted. **Restore** (`POST skills/<name>/restore`) moves a fragment back and makes it a candidate again. Dismiss changes nothing.
- **Automatic** (`brain_consolidate = after_extract`, the default): after an extract-all (a session's own or all) in which a session's units wrote or refined 3 or more skills, one proposal for that
  session's project is queued. `manual` never does. It only proposes.
- **Console.** The Notes view's Skills area has a Consolidate panel: a button per project ("Propose consolidation for <project>", confirm with the number of calls, the estimate and what is
  left of the cap), and each open proposal: per cluster the merged skill's name and description, the fragments it replaces with their source counts, the rationale, or "covered by <skill>" with the
  proposed additions, a checkbox, a preview of the merged `SKILL.md` as raw text; **Apply selected**, **Dismiss**. The skills table hides merged and covered fragments; a chip ("9 fragments merged
  into 2") opens them, each with Restore. The graph leaves merged fragments out; the merged skill is tied to the units its fragments came from, and a covered fragment to an outlined
  `installed` node for the skill that covers it.
- Measured on a real project (21 candidates, the user's own end-to-end video skill installed without a marker): see NOTES.md "Consolidation".

## Cost accounting

- **Brain spend is exact.** Gate and distill calls go through the router; they are tagged `source = brain` and
  summed in dollars at list price. `brain_daily_usd` (default 1.00) caps the day; over the cap, work queues until tomorrow.
  The tag is the `x-agent-router-source` request header, set through the CLI's `ANTHROPIC_CUSTOM_HEADERS`, stored in
  `requests.source` and stripped before the request goes upstream. Jev calls are another vendor's bill and not counted.
  The subprocess runs lean (`--safe-mode`, a one-line system prompt, a fixed session name, no thinking, no cache write):
  a distill measured about a third of what a bare `claude -p` costs (NOTES.md "Brain"; roughly $0.03 at list price).
- With `brain_distill = on_idle` only sessions that went idle within the last day are distilled automatically; older
  history stays manual, so enabling the brain cannot spend days of cap on the backlog.
- **Skill use is counted, savings are not claimed.** Transcripts record each Skill tool call by name. Per skill
  the console shows uses, sessions, projects, last used, and the dollars (list price) the source session spent working it out.
- **A promoted skill costs prefix tokens in every session** (its description line). Skills unused for 30 days
  are flagged for demotion. Promotion changes the skill list, so it applies from the next session.

## Viewer (console Brain tab)

Four views, chosen with a segmented control and kept in the hash (`#brain?view=pipeline|notes|graph|trace[&unit=<id>]`).

- **Pipeline** (default). A funnel strip of five stages, each naming who does the work: Captured · no model → Scanned · Haiku (or Jev) →
  Extracted · Sonnet → Skill candidate → Promoted. Counts are over units and cumulative (a unit counts in every stage it passed); clicking
  a stage filters the table to the units that reached it. A session with subagent or segment units is a parent row with a collapsible
  list beneath ("28 subagents · 22 segments · 4 scanned · 2 skills"), each unit a row with a kind chip and the same actions, plus
  "Scan this session's subagents (N) — about $X" and "Extract (M)" for that session alone. One row per captured session: title, project, step chips (Captured ✓ → Scan:
  `skill 0.92` / `knowledge 0.90` / `nothing` / `too small` → Extract: `$0.03` / `skipped` / `queued` → Skill: name or —) and actions
  (Scan, Extract, Open note). **Scan backlog (N)** scans every captured, unscanned unit that passes the pre-filter; **Extract scanned
  (M)** runs the writer for every unit whose scan said to keep something and that has no extract yet. Both run sequentially in the
  background, one run at a time (a second is 409), stop at the daily cap or when the brain is turned off, and show progress inline. The
  confirm states the count, an estimate (count × the mean of the last 20 measured calls; none until there is history) and what is left
  of the cap. A batch that stops at the daily cap leaves a banner ("Scan stopped at the daily cap with 12 units left") with **Resume (12 left)**:
  the same call limited to what is left (`pipeline.stopped = {kind, session?, left}`), disabled while the cap is still spent. Every row has a **Trace** button. A row's Extract chip says how the writer call ended (`extract_result`): an amber **no skill written** (with the detail) and **Retry**, or "unreadable answer" / "writer failed" / "timed out" and **Retry**; **trace trimmed** when the outline was cut.
- **Notes.** Tree on the left (Sessions by date with their unit notes nested beneath, Projects, Skills promoted / candidates, Daily, Index, Facts), rendered
  Markdown in the middle (small built-in renderer; `[[wikilinks]]` navigate in place), search across the vault
  with snippets. A candidate that is an update to a promoted skill is shown as a line diff against the installed copy, with Apply update
  and Discard update. Actions: Distill, Consolidate, Promote / Reject / Demote, Import skill from URL, edit
  `CRITICAL_FACTS.md`, install the recall skill. Header: spend today against the cap, sessions captured, skills promoted, candidates waiting.
- **Graph.** The vault as a force-directed graph, inline SVG, plain JS (repulsion between notes closer than 200 units, a spring per link,
  a pull to the centre; run to rest in one go, no animation loop; O(n²) per iteration: 200 notes lay out in 20–45 ms). Nodes: sessions
  (muted), units (small, muted; chip "Subagents", on by default), projects (clay), days (dim), skills (teal; a candidate has a dashed
  ring), tags (amber, off by default); size by degree. Edges: session→project, session→day, unit→its session (`subagent` / `segment`),
  skill→every unit that wrote, refined, was merged into it or was related to it (`source`, from `skill_sources`), a covered fragment→the skill that covers it (`covered`; an outlined `installed` node unless the brain promoted that skill itself; merged fragments are left out) and its first source's project, skill→sessions
  that invoked it (`tool_uses`), note→tag, and any other `[[wikilink]]` between notes; one edge per pair. A skill is one node whichever of
  its two files a link names. `index.md`, the manual, the log and notes outside the folders the router writes are left out. Drag to pan,
  wheel or pinch to zoom, drag a note to pin it, hover to light a note and its neighbours, click to open it in Notes; type chips filter,
  the search box highlights matches. It is laid out again only when the set of notes or links changes; pan, zoom and pins survive polls.

- **Trace.** See "Trace" below. Reached from a pipeline row, a note, a graph unit node (alt-click) and a session's timeline in Accounts & routing.

**Open in Obsidian** shows when Obsidian is installed (macOS: `/Applications/Obsidian.app` or `~/Applications/Obsidian.app`; elsewhere
`obsidian` on PATH; `OBSIDIAN_APP` overrides the path probed) and runs `open -a Obsidian <vault>`. Otherwise the button is **Reveal
folder** (`open <vault>` / `xdg-open`). The directory is always the configured vault; nothing from the request reaches the command.

## Trace

A trace is the run tree of one unit, the way LangGraph/LangSmith show a run: `trace(unit)` in `trace.ts`, built from the transcripts and joined to the ledger by
`requestId`, recomputed on demand (a pure function of those files; nothing is stored, and a trace holds no tool input beyond a short `target` and no tool output).

```
{ unit_id, title, kind: session|subagent|segment, mode, started, ended, usd, tokens: {in, out, cache_read, cache_create}, lim, last_ts, counts,
  spans: [ { id, parent, kind: prompt|model|tool|subagent|segment, name, target, t0, t1, ms, ok, out_tokens_est, usd, tokens, lim, n_children } ] }
```

Spans are a flat pre-order list with `parent` ids. A prompt span (first 80 characters of the typed prompt) is at the top; under it, in order, the model calls (name =
model id; times, `ok` and dollars from the ledger row; a transcript with no ledger row falls back to its own usage) and the tool calls each led to (tool_use to its
tool_result: `ms`, `ok` = not `is_error`, `out_tokens_est` = result chars / 4; `target` = file path relative to the cwd, first 120 characters of a command, URL host and
path, search query, skill or description, scrubbed). An `Agent` call whose result names a subagent transcript becomes a `subagent` span (first to last row of that file) with
that run's own spans under it. A main thread of more than 150 tool calls is grouped into `segment` spans, the same segments the unit notes use; a segment unit's trace is just
its prompts. Containers carry the dollars and tokens of everything beneath them; `usd` and `tokens` of the trace are the sum of its model calls. `counts` = `steps`
(tool calls and subagent runs), `tool_calls`, `failed`, `subagents`, `models`.

**Minimal trace**, `minimal(trace)`, applies in this order: (1) drop tool spans with `ok = false`, and an unanswered call that a later success of the same family supersedes;
(2) collapse runs of consecutive read-only exploration (`Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `ToolSearch`, and Bash whose every command is read-only: `ls`, `cat`, `head`,
`tail`, `grep`, `rg`, `find`, `tree`, `pwd`, `wc`, `stat`, `file`, `du`, `df`, `which`, `jq`, `ffprobe`, `sed` (not `-i`), `awk`, `cut`, `tr`, `sort`, `ps`, `date`, …, `git status|log|diff|show|branch`,
`sqlite3` with a `select`, and no redirect into a file) into one `explored N files` span that keeps the 3 largest targets; (3) of the writes to one path keep the last
(`edits: n`); (4) of the successful Bash commands of one family keep the last (`runs: n`); (5) keep every prompt and segment, every subagent span (pruned on its own, recursively) and
each unit's last model call, which is its report. Every other model call is dropped (it carries no content). A *family* is the same tool; for the file tools the same path; for Bash the
**`commandKeys(line)` tuple** (`trace.ts`, also the unit notes' command families; the one definition of family and of read-only):
- the line is split into simple commands on unquoted `&&`, `||`, `;`, `|`, `&`, `( )` and newlines (quotes, `$(…)`, backticks and heredocs stay whole); `for`/`while`/`until`/`if` keywords are
  peeled off (a loop's header goes, its condition and body stay);
- set-up noise is dropped: `cd`, `pushd`/`popd`, `export`, `set`, `source`, `sleep`, `true`/`false`, `:`, `wait`, `exit`, `trap`, pure `VAR=value`, comments, and `echo`/`printf` not redirected into a file;
  `VAR=value` prefixes are stripped and `sudo`, `env`, `time`, `nohup`, `timeout N`, `xargs`, `bash -c '…'` unwrapped to the command inside;
- each command left is a key: the executable's basename, plus a subcommand (`git`, `npm`, `npx`, `pnpm`, `yarn`, `bun`, `docker`, `brew`, `gh`, `wrangler`, `cargo`, `go`, `kubectl`, `pip`, `uv`,
  `launchctl`, `deno`: the first non-flag argument, and the script name after `run`) or script (`python`, `node`, `bash`, `sh`, `ruby`, `perl`, `$VAR`: the script's basename, `-m X` for modules, a hash of
  `-c`/`-e` code), plus the file it writes (`-o`/`--output` value, a redirect target, the last argument of `ffmpeg`/`magick`/`sox`/`yt-dlp` when it has an extension), reduced to its basename, plus a
  hash of a heredoc's text. So `cd d && ffmpeg … out_a.mp4` and `… out_b.mp4` are different families, `npm run build && npm run deploy` is not `npm run build`, and a true re-run of the same
  command to the same output is one family: the later success supersedes the earlier;
- a line is exploration when every command left is read-only and nothing is redirected into a file (a read mixed with a real command is a step; a line of nothing but set-up counts as exploration);
- the span's `target` is the line with the set-up removed (first 160 characters, scrubbed), so a row reads `ffmpeg -i … out.mp4`, not `cd /private/tmp/…`; the keys travel with a Bash span as `cmd: {keys, ro}`.

It is a line scanner, not a shell parser: it flattens `( … )`, ignores what is inside `$(…)`, and misreads functions defined earlier in the shell, `case`, `git -C dir …`, aliases and a target held in a
variable; every misreading keeps a step that could have been merged, none merges two commands. The result has `pruned` (`failed_or_superseded`, `collapsed`, `collapsed_into`, `overwritten_writes`,
`repeated_commands`, `model_calls`), `counts` of what is kept and `full` (the counts before).

`md(trace)` renders a minimal trace as a numbered outline (step, tool, target, outcome, duration; a subagent's steps as a nested list), at most ~6,000 tokens (24,000 characters):
over that it drops `explored` spans first, then the **middle** of the other steps (the first 25% and the last 55% stay; the cut grows outward from the middle of the gap between them until it
fits) and puts a line `… N steps omitted …` where it cut, and never a prompt, subagent or write: a run's setup and its ending say more than its long middle. (It used to drop the oldest steps, which is the setup.) The unit is marked `trace_trimmed`. **The writer reads this outline**, with the unit's Brief
and Final report; the scan reads its first 40 lines. A unit note carries a line `Trace: [open in the console](…) · 214 steps → 38 after pruning`.

The console's **Trace** view: a collapsible tree (kind chip, name, target, a red mark for a failed step) with a duration bar on the unit's own time axis beside each row, and for model
calls tokens and dollars (with the "% of your 5-hour window" phrasing in the tooltip and header). Header: totals, Full / Minimal with the pruning summary ("dropped 41 failed or
superseded, collapsed 96 reads into 12, kept 38 of 214"), Copy as Markdown, Download JSON, and Distill from this trace (a subagent run or segment; the usual cost confirm). Only open
rows are drawn, children load when a span is opened, a filter box loads the whole trace once, arrows move and expand. The poll fetches only the unit's `last_ts`.

## API (all under `/router/brain/`)

`GET stats` (incl. `obsidian`) · `GET tree` (`files`, `units`: unit note → session note) · `GET note?path=` (`installed` for a proposed
update) · `GET search?q=` · `GET pipeline` (`stages`, `rows` each with `units`, `cap`, `running`, `stopped`, `todo`, `avg`) ·
`GET graph` (`nodes`, `edges`) · `GET trace?unit=<id>&mode=full|minimal[&depth=1 | &parent=<span id>][&download=1]` (`unit` = a session, `<session>/<agent id>` or `<session>/seg-<n>`;
`depth=1` the top-level spans, `parent` one span's children, both with `n_children`; 404 `no_transcript`; `meta=1` is just `{unit_id, last_ts}`) · `GET trace.md?unit=` (the minimal trace as an outline) · `POST capture {session?}` · `POST scan {session}` · `POST distill {session, force?}` (`session` = a unit key) ·
`POST scan-all {limit?, session?}` · `POST extract-all {limit?, session?}` (`session`: only that session's subagent and segment units, oldest
first; 202 `{total, estimate_usd, cap}`; 409 `brain_busy` while one runs; `pipeline.stopped` says what a batch left at the cap, and Resume is this call with `limit` = what is left) · `POST open {target: obsidian|folder}` ·
`POST consolidate-notes {project}` (merge a project note's bullets) · `GET consolidations` (`projects` with an estimate, `proposals` with each cluster's `SKILL.md`, `running`, `last_error`) ·
`POST consolidate {project | session}` (202 `{scope, scope_key, fragments, calls, estimate_usd, cap}`, background, 409 `brain_busy` / `brain_over_cap`, 404 `nothing_to_consolidate` under two candidates) ·
`POST consolidations/<id>/apply {clusters}` · `POST consolidations/<id>/dismiss` · `POST skills/import {url}` · `POST skills/<name>/promote|demote|reject|restore` · `POST recall` ·
`PUT facts {text}` · `POST facts-load {on}` (adds or removes the one line `@<vault>/CRITICAL_FACTS.md` in `<CLAUDE_HOME or ~/.claude>/CLAUDE.md`;
`stats.facts_loaded` reads it back). Reads always answer; every write is `409 brain_disabled` until `brain_enabled`. Enabling is
`PUT /router/settings {brain_enabled: true, brain_dir}`.

## Settings

`brain_enabled` false · `brain_dir` · `brain_distill` `manual` | `on_idle` · `brain_daily_usd` 1.00 ·
`classifier` `auto` | `jev` | `model` · `brain_classifier_model` `haiku` · `brain_writer_model` `sonnet` ·
`brain_confidence` 0.7 · `brain_consolidate` `after_extract` | `manual`

## Safety

- Off until enabled: the vault holds excerpts of the user's own prompts and commands.
- Excerpts are scrubbed for obvious secrets (API keys, bearer tokens, `password=`) before being written or sent.
- Imported skills are untrusted instructions: candidate only, full text shown, explicit promote.
- The router writes only inside `brain_dir`, plus `~/.claude/skills/<name>/` on promote. Every path from the
  API is resolved and checked to be inside the vault.
- The ledger still stores no bodies; the brain is a separate folder the user chose.
