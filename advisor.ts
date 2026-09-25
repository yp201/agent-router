// Context advisor: when a session's context first crosses warn/urgent of its window, break down what fills it (names, targets,
// sizes from the local transcript, never tool output) and ask Haiku, via the user's own `claude -p`, what to do about it.
import { execFile, execFileSync } from 'node:child_process';
import { createReadStream, appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { db, settings } from './ledger.ts';

const one = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
const which = () => { try { return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || null; } catch { return null; } };
export const CLAUDE_BIN: string = process.env.CLAUDE_BIN ?? settings().claude_bin ?? which() ?? `${homedir()}/.local/bin/claude`;

// Window for a model: longest matching prefix in settings.context_windows, else 1M for a `[1m]` model, else default.
// A request that succeeded with more context than that must have had the 1M window (the `[1m]` alias never reaches the API body).
export function windowOf(model: string | null, ctx = 0) {
  const cw = settings().context_windows ?? {}, m = model ?? '';
  const k = Object.keys(cw).filter((p) => p !== 'default' && m.startsWith(p)).sort((a, b) => b.length - a.length)[0];
  const w = k ? cw[k] : m.includes('[1m]') ? 1_000_000 : cw.default ?? 200_000;
  return ctx > w ? 1_000_000 : w;
}

// `claude -p` with the prompt on stdin. Env minus CLAUDE_CODE_* / ANTHROPIC_* so the child is a plain CLI on the user's login
// (it still reaches the API through this router, like any other client). null on any failure; never throws.
export function claude(prompt: string): Promise<string | null> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CODE_|ANTHROPIC_)/.test(k)));
  return new Promise((ok) => {
    const c = execFile(CLAUDE_BIN, ['-p', '--model', settings().advisor_model, '--output-format', 'text', '--no-session-persistence', '--tools', ''],
      { env, cwd: tmpdir(), timeout: 60_000, maxBuffer: 1 << 20 }, (e, out) => {
        if (e || !out.trim()) console.log(`advisor: ${CLAUDE_BIN} failed (${e ? e.code ?? e.signal ?? 'exit' : 'empty output'})`);
        ok(e ? null : out.trim() || null);
      });
    c.stdin!.on('error', () => {}).end(prompt);
  });
}

const TARGET = new Set(['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash']);
const strip = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
// One pass over a transcript. Tool results are counted since the last compaction (that's what is in context now); prompts,
// files and assistant text span the whole file (handoff input). Only sizes of tool results are kept, never their content.
async function scan(path: string) {
  const acc = new Map<string, { tool: string; target: string; chars: number; count: number }>(), uses = new Map<string, { tool: string; target: string }>();
  const prompts: string[] = [], files = new Set<string>(), texts: string[] = [];
  for await (const l of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (l.includes('"subtype":"compact_boundary"')) { acc.clear(); continue; }
    if (!l.includes('"message"')) continue; // user/assistant rows only
    let r: any;
    try { r = JSON.parse(l); } catch { continue; }
    if (r.isSidechain || r.isMeta) continue; // isMeta: injected skill/command text, not typed by the user
    const c = r.message?.content;
    if (r.type === 'user' && typeof c === 'string' && strip(c)) prompts.push(strip(c).slice(0, 300));
    for (const b of Array.isArray(c) ? c : []) {
      if (r.type === 'user' && b?.type === 'text' && strip(String(b.text))) prompts.push(strip(String(b.text)).slice(0, 300));
      if (r.type === 'assistant' && b?.type === 'text' && b.text?.trim()) texts.push(String(b.text).trim().slice(0, 500));
      if (b?.type === 'tool_use') {
        const target = TARGET.has(b.name) ? String(Object.values(b.input ?? {}).find((v) => typeof v === 'string') ?? '').slice(0, 60) : b.name;
        uses.set(b.id, { tool: b.name, target });
        if (/^(Read|Edit|Write)$/.test(b.name) && target) files.add(target);
      }
      if (b?.type === 'tool_result') {
        const u = uses.get(b.tool_use_id) ?? { tool: 'unknown', target: 'unknown' }, k = `${u.tool}\0${u.target}`;
        const chars = typeof b.content === 'string' ? b.content.length
          : Array.isArray(b.content) ? b.content.reduce((a: number, x: any) => a + (x?.type === 'text' ? String(x.text ?? '').length : 0), 0) : 0; // ponytail: images not counted
        const e = acc.get(k) ?? { ...u, chars: 0, count: 0 };
        e.chars += chars; e.count++; acc.set(k, e);
      }
    }
  }
  const rows = [...acc.values()].map((x) => ({ tool: x.tool, target: x.target, tokens: Math.round(x.chars / 4), count: x.count })).sort((a, b) => b.tokens - a.tokens);
  const by = new Map<string, { tool: string; tokens: number; calls: number }>();
  for (const x of rows) { const t = by.get(x.tool) ?? { tool: x.tool, tokens: 0, calls: 0 }; t.tokens += x.tokens; t.calls += x.count; by.set(x.tool, t); }
  return {
    breakdown: { top_results: rows.slice(0, 8), files_read_repeatedly: rows.filter((x) => x.tool === 'Read' && x.count > 1).map(({ target, count, tokens }) => ({ target, count, tokens })),
      by_tool: [...by.values()].sort((a, b) => b.tokens - a.tokens) },
    prompts, files: [...files], texts: texts.slice(-3),
  };
}

const ADVISE = (pct: number, w: number) => `You are advising a developer whose Claude Code session is at ${pct}% of its ${w}-token context window and will auto-compact soon. Below is a structured breakdown of what occupies the context: tool results by size, files read repeatedly, tokens per tool, thinking tokens. In under 150 words, plain text, no preamble: (1) the three biggest avoidable items and what to do about each, (2) whether to start a fresh session with a handoff summary now or continue, with the reason, (3) one habit change that would have kept this smaller. Be specific: name the files and numbers from the breakdown.`;
const HANDOFF = 'Summarize this session for a fresh session that will continue the work. Include: the goal, what\'s done (with file paths), what\'s in progress, decisions made and why, open questions, and the exact next step. Omit exploration that led nowhere. Under 800 tokens.';
const ins = db.prepare(`insert into advice (session_key, ts, level, pct, context_total, window, breakdown_json, text, model, request_id)
  values (:sk, :ts, :level, :pct, :ctx, :w, :b, :text, :model, :rid)`);
export const title = (sk: string) => one('select title from sessions where session_key = ?', sk)?.title ?? sk.slice(0, 8);
const q = (s: string) => s.replace(/["\\]/g, '\\$&');
// macOS notification. Off with settings.notify = false or NOTIFY=0; NOTIFY_LOG=<file> appends instead (tests); no osascript (Linux) = no-op.
export function notify(msg: string) {
  if (!settings().notify) return;
  console.log(`notify: ${msg}`);
  if (process.env.NOTIFY_LOG) return appendFileSync(process.env.NOTIFY_LOG, msg + '\n');
  if (process.env.NOTIFY !== '0' && existsSync('/usr/bin/osascript'))
    execFile('/usr/bin/osascript', ['-e', `display notification "${q(msg)}" with title "agent-router"`], () => {});
}

const busy = new Set<string>();
// Tailer hook, after each usage join. Main thread only (subagents have their own, smaller context); live rows only, so a first
// scan of old transcripts never fires a burst of Haiku calls. ponytail: one advice per level per session, even after a compaction.
export function check(rid: string) {
  const st = settings();
  const r = one(`select session_key sk, ts, model, jsonl_path path, in_tok + cache_read + cache_create ctx from requests
    where request_id = ? and agent_id is null and cache_create is not null`, rid);
  if (!st.advisor_enabled || !r?.sk || !r.path || Date.now() - r.ts > 30 * 60_000) return;
  const w = windowOf(r.model, r.ctx), pct = r.ctx / w;
  const level = pct >= st.context_urgent_pct ? 'urgent' : pct >= st.context_warn_pct ? 'warn' : null, k = `${r.sk}/${level}`;
  if (!level || busy.has(k)) return;
  const have = one(`select max(level = 'urgent') u, count(*) n from advice where session_key = ? and level in ('warn', 'urgent')`, r.sk);
  if (have.u || (have.n && level === 'warn')) return;
  busy.add(k);
  (async () => {
    const { breakdown } = await scan(r.path);
    const t = one(`select sum(thinking_tok) th, sum(agent_id is null) turns, sum(agent_id is not null) sub from requests where session_key = ? and cache_create is not null`, r.sk);
    const b = { ...breakdown, thinking_tokens_total: t.th ?? 0, turns: t.turns, subagent_turns: t.sub, context_total: r.ctx, window: w, pct: Math.round(pct * 100) };
    const text = await claude(`${ADVISE(b.pct, w)}\n\n${JSON.stringify(b)}`);
    ins.run({ sk: r.sk, ts: Date.now(), level, pct, ctx: r.ctx, w, b: JSON.stringify(b), text, model: r.model, rid });
    notify(`${title(r.sk)} at ${b.pct}% — recommendation ready`);
  })().catch((e) => console.log('advisor:', e.code ?? e.message)).finally(() => busy.delete(k));
}

// POST /router/sessions/:key/handoff. Input is structured (title, prompts, files, last assistant text), never the raw transcript.
export async function handoff(sk: string) {
  const r = one(`select request_id rid, model, jsonl_path path, in_tok + cache_read + cache_create ctx from requests
    where session_key = ? and agent_id is null and jsonl_path is not null order by ts desc limit 1`, sk);
  if (!r) return null;
  const s = await scan(r.path);
  const text = await claude(`${HANDOFF}\n\n${JSON.stringify({ title: title(sk), user_prompts: s.prompts, files_touched: s.files, last_assistant_text: s.texts })}`);
  const w = windowOf(r.model, r.ctx ?? 0);
  if (text) ins.run({ sk, ts: Date.now(), level: 'handoff', pct: r.ctx == null ? null : r.ctx / w, ctx: r.ctx, w, b: null, text, model: r.model, rid: r.rid });
  return { text };
}
