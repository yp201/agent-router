// Agent trace (docs/BRAIN.md "Trace"): a LangSmith-style run tree of one unit (a session's main thread, a subagent run or a task segment: the ids
// brain.ts uses), built from the transcripts and joined to the ledger by requestId. A pure function of (transcript files, ledger rows): recomputed on
// demand, never stored. Of a tool call only its name, a short scrubbed `target` and the size of its result are kept: no other tool input, no tool output.
// minimal() prunes the tree deterministically; md() renders that as the outline the brain's writer reads. No model is called here.
// brain.ts and this file import each other; each only calls the other's functions at run time.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { db, settings } from './ledger.ts';
import { cost, limText } from './console.ts';
import { resultChars } from './advisor.ts';
import { desc } from './tailer.ts';
import { createHash } from 'node:crypto';
import { clip, strip, code, segments, LONG, mainPaths } from './brain.ts';

const all = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];
const one = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
type Tok = { in: number; out: number; cache_read: number; cache_create: number };
export type Span = { id: string; parent: string | null; kind: 'prompt' | 'model' | 'tool' | 'subagent' | 'segment'; name: string; target: string; t0: number; t1: number; ms: number | null;
  ok: boolean | null; out_tokens_est?: number; usd?: number | null; tokens?: Tok; lim?: string; n_children: number; edits?: number; runs?: number; cmd?: { keys: string[]; ro: boolean } };
export type Counts = { steps: number; tool_calls: number; failed: number; subagents: number; models: number };
export type Trace = { unit_id: string; title: string; kind: 'session' | 'subagent' | 'segment'; mode: 'full' | 'minimal'; started: number; ended: number; usd: number; tokens: Tok; lim: string;
  last_ts: number; counts: Counts; spans: Span[]; full?: Counts; pruned?: Record<string, number> };

// ---- the one place that says what is exploration and what is "the same command" (minimal() rules 1-4) ----
// Read-only exploration: these tools, and Bash that is just looking. A family is: the same tool; for Bash the same commandKeys() tuple; for the file tools (Read,
// Edit, Write, …) the same path.
const RO = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch']), WRITE = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const cmdOf = (s: Span) => s.cmd ?? commandKeys(s.target);
const readOnly = (s: Span) => RO.has(s.name) || (s.name === 'Bash' && cmdOf(s).ro);
const FILE = /^(Read|Edit|Write|MultiEdit|NotebookEdit)$/;
const famKey = (s: Span) => (s.name === 'Bash' ? `Bash ${cmdOf(s).keys.join(' | ')}` : FILE.test(s.name) ? `${s.name} ${s.target}` : s.name);

// A command line, read just enough to tell what it did. Split on unquoted && || ; | & ( ) and newlines ($(…), `…` and quotes stay whole); loop and `if` keywords peeled
// off; set-up noise (cd, export, VAR=x, sleep, echo, …) dropped; sudo, env, time, timeout, xargs and bash -c unwrapped. Each command left is a key: the executable, its
// subcommand or script, and the file it writes (-o, a redirect, ffmpeg's last argument when it has an extension). A line's family is the tuple of its keys; it is exploration when every command in it is read-only.
// ponytail: a line scanner, not a shell parser. A heredoc is one command, told apart by a hash of its text; it flattens ( … ) subshells, ignores what is inside $(…), and misreads functions, `case`, `git -C dir`, aliases and a target held in a
// variable ($OUT); misreads over-keep, they never merge two commands. Upgrade to a real parser if that groups badly.
const NOISE = /^(cd|pushd|popd|export|set|source|sleep|true|false|:|wait|read|test|exit|continue|break|return|trap|unset|local|declare|shift|\[\[?|[{}])$/, WRAP = /^(sudo|env|time|nohup|timeout|xargs)$/, SUB = /^(git|npm|npx|pnpm|yarn|bun|docker|brew|gh|wrangler|cargo|go|kubectl|pip|uv|launchctl|deno)$/;
const SCRIPT = /^(python[\d.]*|node|bash|sh|zsh|ruby|perl|\$\{?\w+\}?)$/, MEDIA = /^(ffmpeg|ffprobe|magick|convert|sox|yt-dlp)$/, RO_EXE = /^(ls|cat|head|tail|wc|grep|rg|find|stat|file|du|df|which|pwd|tree|jq|ffprobe|sed|awk|cut|tr|sort|uniq|nl|column|xxd|od|strings|diff|cmp|md5|shasum|ps|pgrep|lsof|basename|dirname|realpath|readlink|date|uname|whoami|afinfo|mdls)$/;
const base = (p: string) => p.replace(/^.*\//, '');
const KW = /^(?:(?:do|then|else|elif|if|while|until|!)(?:\s+|$))+/;
function split(s: string) {
  const out: [string, string][] = []; // [the separator before it, the command]
  let cur = '', sep = '', q = '', d = 0, hd = '';
  const push = (next: string) => { if (cur.trim()) out.push([sep, cur.trim()]); cur = ''; sep = next; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    cur += c;
    if (c === '\\') cur += s[++i] ?? '';
    else if (q) { if (c === q) q = ''; }
    else if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '(' && (d || s[i - 1] === '$')) d++;
    else if (c === ')' && d) d--;
    else if (!d) {
      if (c === '<' && n === '<' && s[i - 1] !== '<' && s[i + 2] !== '<') hd = /^<<-?\s*['"]?(\w+)/.exec(s.slice(i))?.[1] ?? hd; // a heredoc: its body stays in this command
      if (c === '\n' && hd) { const e = s.indexOf(`\n${hd}`, i), end = e < 0 ? s.length : e + 1 + hd.length; cur += s.slice(i + 1, end); i = end - 1; hd = ''; }
      else if (c + n === '&&' || c + n === '||') { cur = cur.slice(0, -1); i++; push(c + n); }
      else if (/[;|\n()]/.test(c) || (c === '&' && !/[<>]/.test(s[i - 1] ?? '') && n !== '>')) { cur = cur.slice(0, -1); push(c === '\n' ? ';' : c); }
    }
  }
  push('');
  return out;
}
// one simple command: its words, and the files it redirects into
function words(s: string) {
  const w: string[] = [], out: string[] = [];
  let cur = '', has = false, q = '', d = 0, red = '';
  const end = () => { if (has) { (red === 'o' ? out : red ? [] : w).push(cur); red = ''; } cur = ''; has = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && q !== "'") { cur += s[++i] ?? ''; has = true; }
    else if (q) { if (c === q) q = ''; else cur += c; }
    else if (c === "'" || c === '"' || c === '`') { q = c; has = true; }
    else if (c === '(' && (d || cur.endsWith('$'))) { d++; cur += c; }
    else if (c === ')' && d) { d--; cur += c; }
    else if (d) cur += c;
    else if (c === '\n') break; // only a heredoc body can follow
    else if (/\s/.test(c)) end();
    else if (c === '>' || c === '<') {
      if (/^(\d*|&)$/.test(cur)) { cur = ''; has = false; } else end(); // `2>` and `&>`: the number is not a word
      red = c === '>' ? 'o' : 'i';
      if (s[i + 1] === c) i++; else if (c === '>' && s[i + 1] === '&') i++;
    } else { cur += c; has = true; }
  }
  end();
  return { w, out: out.filter((f) => !/^(\d+|-|\/dev\/null)$/.test(f)) };
}
export function commandKeys(line: string) {
  const keys: string[] = [], shown: [string, string][] = [];
  let ro = true;
  const read = (s: string, top: boolean) => {
    for (const [sep, raw] of split(s)) {
      const text = raw.replace(KW, ''), { w, out } = words(text), skip = () => { while (w[0] && /^(-.*|\d+[smhd]?|[A-Za-z_]\w*=.*)$/.test(w[0])) w.shift(); };
      skip();
      while (w[0] && WRAP.test(w[0])) { w.shift(); skip(); }
      const exe = base(w[0] ?? ''), a = w.slice(1), n = keys.length;
      if (/^(ba|z)?sh$/.test(exe) && /^-\w*c$/.test(a[0]) && a[1] != null) { read(a[1], false); if (keys.length > n && top) shown.push([sep, text]); continue; }
      if (!exe || text.startsWith('#') || NOISE.test(exe) || /^(for|select|case|done|fi|esac)$/.test(exe) || (/^(echo|printf)$/.test(exe) && !out.length)) continue;
      const pos = a.filter((x) => !x.startsWith('-')), m = a.indexOf('-m'), c = a.findIndex((x) => /^-[ce]$/.test(x)), o = a.findIndex((x) => /^(-o|--out(put)?)$/.test(x)), eq = a.find((x) => /^--out(put)?=/.test(x));
      let sub = SUB.test(exe) ? pos[0] ?? '' : SCRIPT.test(exe) ? (m >= 0 ? a[m + 1] : c >= 0 ? `-c ${createHash('sha1').update(a[c + 1] ?? '').digest('hex').slice(0, 6)}` : base(pos[0] ?? '')) : '';
      if (sub === 'run' && /^(npm|pnpm|yarn|bun|deno)$/.test(exe)) sub += ` ${base(pos[1] ?? '')}`;
      const to = [o >= 0 && a[o + 1], eq?.split('=')[1], MEDIA.test(exe) && /^[^-].*\.\w+$/.test(a.at(-1) ?? '') && a.at(-1), ...out].filter(Boolean).map((t) => base(t as string)).filter(Boolean);
      keys.push([exe, sub, ...to.map((t) => `>${t}`), /<<-?\s*['"]?\w/.test(text) && `#${createHash('sha1').update(text).digest('hex').slice(0, 6)}`].filter(Boolean).join(' '));
      ro &&= RO_EXE.test(exe) ? !out.length && !a.some((x) => (exe === 'find' && /^-(delete|exec(dir)?)$/.test(x)) || (exe === 'sed' && /^-i/.test(x))) : (exe === 'git' && /^(status|log|diff|show|branch)$/.test(sub) && !out.length) || (exe === 'sqlite3' && a.some((x) => /^\s*select\b/i.test(x)));
      if (top) shown.push([sep, text]);
    }
  };
  read(line, true);
  return { keys, ro, text: shown.length ? shown.map(([s, t], i) => (i ? ` ${s} ` : '') + t).join('') : line };
}

// a tool call's one short target: file, command, pattern, url (host and path only), query, skill or description. Scrubbed; paths relative to the cwd.
const targetOf = (i: any, cwd: string) => {
  let v = i?.command ?? i?.file_path ?? i?.notebook_path ?? i?.pattern ?? i?.url ?? i?.query ?? i?.skill ?? i?.path ?? i?.description;
  if (typeof v !== 'string') return '';
  if (/^https?:\/\//.test(v)) try { const u = new URL(v); v = u.host + u.pathname; } catch {}
  return clip(cwd && v.startsWith(`${cwd}/`) ? v.slice(cwd.length + 1) : v, i?.command ? 160 : 120);
};

// ---- parse one transcript set into nested nodes ----
type Node = Omit<Span, 'parent' | 'n_children'> & { kids: Node[]; agent?: string; title?: string; acct?: string };
type Parsed = { roots: Node[]; ev: { t: 'p' | 'u'; s: string; node: Node }[]; t0: number; t1: number };
// ponytail: the last 96 parses stay in memory, keyed by file size + mtime and the session's ledger row count, so lazy expansion and a segment's siblings do not re-read a
// 50 MB transcript; a live transcript re-parses when it grows
const memo = new Map<string, Parsed>();
async function parse(sk: string, files: string[], side: boolean, pre: string): Promise<Parsed> {
  const l = one('select count(*) n, max(id) m from requests where session_key = ?', sk);
  const key = [sk, side, pre, l.n, l.m, ...files.map((f) => { const st = statSync(f); return `${f}:${st.size}:${st.mtimeMs}`; })].join('|');
  if (memo.has(key)) return memo.get(key)!;
  const rc = settings().rate_card ?? {}, L = new Map(all(`select request_id r, ts, latency_ms ms, status, model, speed, in_tok, out_tok, cache_read, cache_create, cache_1h, cache_5m, account_id acct
    from requests where session_key = ? and request_id is not null`, sk).map((x) => [x.r as string, x]));
  const roots: Node[] = [], ev: Parsed['ev'] = [], uses = new Map<string, Node>(), seen = new Set<string>();
  let cur: Node | null = null, cwd = '', t0 = 0, t1 = 0, n = 0;
  const prompt = (name: string, ts: number) => { const p: Node = { id: `${pre}p${++n}`, kind: 'prompt', name, target: '', t0: ts, t1: ts, ms: 0, ok: true, kids: [] }; roots.push(p); ev.push({ t: 'p', s: name, node: p }); return (cur = p); };
  for (const f of files) for await (const line of createInterface({ input: createReadStream(f), crlfDelay: Infinity })) {
    if (!line.includes('"message"')) continue; // user/assistant rows only
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if ((r.isSidechain && !side) || r.isMeta || r.isCompactSummary || r.isVisibleInTranscriptOnly) continue;
    const ts = Date.parse(r.timestamp) || t1, c = r.message?.content;
    if (ts) { t0 ||= ts; t1 = ts; }
    cwd ||= r.cwd ?? '';
    // one API response is several rows with the same requestId: its model span comes first, then its tool calls in order
    if (r.type === 'assistant' && r.requestId && !seen.has(r.requestId) && r.message?.model !== '<synthetic>') {
      seen.add(r.requestId);
      const x = L.get(r.requestId), u = r.message?.usage ?? {};
      const row = x && (x.in_tok != null || x.cache_create != null) ? x : { model: r.message?.model, speed: x?.speed, in_tok: u.input_tokens, out_tok: u.output_tokens, cache_read: u.cache_read_input_tokens,
        cache_create: u.cache_creation_input_tokens, cache_1h: u.cache_creation?.ephemeral_1h_input_tokens, cache_5m: u.cache_creation?.ephemeral_5m_input_tokens };
      (cur ?? prompt('(continued)', ts)).kids.push({ id: r.requestId, kind: 'model', name: row.model ?? x?.model ?? '', target: '', t0: x?.ms != null ? x.ts - x.ms : ts, t1: x?.ts ?? ts, ms: x?.ms ?? null, ok: x ? x.status < 400 : true,
        usd: cost(row, rc), tokens: { in: row.in_tok ?? 0, out: row.out_tok ?? 0, cache_read: row.cache_read ?? 0, cache_create: row.cache_create ?? 0 }, kids: [], acct: x?.acct });
    }
    for (const b of typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []) {
      if (b?.type === 'text' && r.type === 'user' && (!r.origin || r.origin.kind === 'human')) {
        const t = strip(String(b.text)); // the same typed prompts brain.ts reads: injected blocks and interruptions are not something the user asked
        if (t && !/^(<|\[Request interrupted)/.test(t)) prompt(clip(t, 80), ts);
      }
      if (b?.type === 'tool_result' && uses.has(b.tool_use_id)) {
        const s = uses.get(b.tool_use_id)!;
        Object.assign(s, { t1: ts, ms: ts - s.t0, ok: !b.is_error, out_tokens_est: Math.round(resultChars(b) / 4) });
        if (typeof r.toolUseResult?.agentId === 'string') s.agent = r.toolUseResult.agentId; // an Agent call: the id of the subagent transcript it started
      }
      if (r.type === 'assistant' && b?.type === 'tool_use' && b.id && !uses.has(b.id)) {
        const c = b.name === 'Bash' && typeof b.input?.command === 'string' ? commandKeys(b.input.command) : null;
        const s: Node = { id: b.id, kind: 'tool', name: String(b.name), target: targetOf(c ? { command: c.text } : b.input, cwd), t0: ts, t1: ts, ms: null, ok: null, kids: [],
          ...(c && { cmd: { keys: c.keys, ro: c.ro } }), ...(/^(Agent|Task)$/.test(b.name) && { title: clip(String(b.input?.description ?? ''), 80) }) };
        uses.set(b.id, s); (cur ?? prompt('(continued)', ts)).kids.push(s); ev.push({ t: 'u', s: '', node: s });
      }
    }
  }
  if (memo.size >= 96) memo.delete(memo.keys().next().value!);
  memo.set(key, { roots, ev, t0, t1 });
  return memo.get(key)!;
}

// ---- the trace of a unit ----
const UNIT = /^([\w-]+)(?:\/([\w-]+))?$/;
const agentFile = (main: string[]) => (a: string) => main.map((p) => `${p.slice(0, -6)}/subagents/agent-${a}.jsonl`).find((f) => existsSync(f));
// where a unit lives: its transcript(s); null when there is none
function where(unit: string) {
  const m = UNIT.exec(unit);
  if (!m) return null;
  const [, sk, id] = m, main = mainPaths(sk), agent = agentFile(main), seg = id?.match(/^seg-(\d+)$/)?.[1], own = id && !seg ? agent(id) : undefined;
  return !main.length || (id && !seg && !own) ? null : { sk, id, seg: seg ? Number(seg) : 0, main, agent, own };
}
export const lastTs = (unit: string) => { const w = where(unit); return w && Math.max(...(w.own ? [w.own] : w.main).map((f) => statSync(f).mtimeMs)); };

export async function trace(unit: string): Promise<Trace | null> {
  const w = where(unit);
  if (!w) return null;
  const { sk, id, seg, agent, own } = w, P = await parse(sk, own ? [own] : w.main, !!own, own ? `${id}/` : '');
  const parts = !own && P.ev.filter((e) => e.t === 'u').length > LONG ? segments(P.ev) : [], segs = parts.length > 1 ? parts : [];
  const pn = (ev: Parsed['ev']) => ev.filter((e) => e.t === 'p').map((e) => e.node);
  let roots = P.roots;
  if (seg) { if (!segs[seg - 1]) return null; roots = pn(segs[seg - 1]); }
  else if (segs.length) roots = segs.map((ev, i) => { const k = pn(ev); return { id: `seg-${i + 1}`, kind: 'segment' as const, name: `part ${i + 1} — ${ev.find((e) => e.t === 'p' && e.s.length >= 15)?.s.slice(0, 60) ?? ''}`,
    target: '', t0: k[0]?.t0 ?? 0, t1: k[0]?.t0 ?? 0, ms: 0, ok: true, kids: k }; });
  const out: Span[] = [], acct = new Map<string, number>();
  async function flat(nodes: Node[], parent: string | null, depth: number) {
    for (const { kids, agent: a, title, acct: ac, ...s } of nodes) {
      const at = out.push({ ...s, parent, n_children: kids.length }) - 1, f = a && depth < 3 ? agent(a) : null;
      if (ac && s.usd) acct.set(ac, (acct.get(ac) ?? 0) + s.usd);
      if (s.usd) out[at].lim = limText(s.usd, ac) || undefined;
      await flat(kids, s.id, depth);
      if (f) { // the Agent call becomes a subagent span: its first to last row, its own spans beneath it
        const S = await parse(sk, [f], true, `${a}/`);
        Object.assign(out[at], { kind: 'subagent', name: title || desc(f) || a, target: '', t0: S.t0 || s.t0, t1: S.t1 || s.t1, ms: (S.t1 || s.t1) - (S.t0 || s.t0), n_children: S.roots.length });
        await flat(S.roots, s.id, depth + 1);
      }
    }
  }
  await flat(roots, null, 0);
  // containers: the dollars, tokens and end time of everything beneath them (children come after their parent, so one pass from the end rolls up)
  const by = new Map(out.map((s) => [s.id, s]));
  for (const s of out) if (s.kind !== 'model' && s.kind !== 'tool') Object.assign(s, { usd: 0, tokens: { in: 0, out: 0, cache_read: 0, cache_create: 0 } });
  for (let i = out.length - 1; i >= 0; i--) {
    const s = out[i], p = s.parent && by.get(s.parent);
    if (!p) continue;
    if (s.usd) p.usd = (p.usd ?? 0) + s.usd;
    for (const k in s.tokens ?? {}) if (p.tokens) p.tokens[k as keyof Tok] += s.tokens![k as keyof Tok];
    if (p.kind !== 'subagent' && s.kind !== 'subagent') { p.t1 = Math.max(p.t1, s.t1); p.ms = p.t1 - p.t0; } // a subagent may run long after the turn that started it
  }
  const started = out.reduce((a, s) => (s.t0 && s.t0 < a ? s.t0 : a), Infinity);
  const ms = out.filter((s) => s.kind === 'model'), usd = ms.reduce((a, s) => a + (s.usd ?? 0), 0), top = [...acct].sort((a, b) => b[1] - a[1])[0]?.[0];
  const title = one('select name from brain_sessions where session_key = ?', unit)?.name ?? (id && !seg ? one('select name from agents where agent_id = ?', id)?.name : null)
    ?? one('select title from sessions where session_key = ?', sk)?.title ?? unit;
  return { unit_id: unit, title: clip(title, 80), kind: seg ? 'segment' : id ? 'subagent' : 'session', mode: 'full', started: started === Infinity ? 0 : started,
    ended: out.reduce((a, s) => Math.max(a, s.t1), 0), usd, lim: limText(usd, top), last_ts: lastTs(unit)!, counts: counts(out), spans: out,
    tokens: ms.reduce((a, s) => ({ in: a.in + s.tokens!.in, out: a.out + s.tokens!.out, cache_read: a.cache_read + s.tokens!.cache_read, cache_create: a.cache_create + s.tokens!.cache_create }), { in: 0, out: 0, cache_read: 0, cache_create: 0 }) };
}
// steps = what the agent did: tool calls and subagent runs (model calls and prompts are not steps)
const counts = (s: Span[]): Counts => ({ steps: s.filter((x) => x.kind === 'tool' || x.kind === 'subagent').length, tool_calls: s.filter((x) => x.kind === 'tool').length,
  failed: s.filter((x) => x.ok === false).length, subagents: s.filter((x) => x.kind === 'subagent').length, models: s.filter((x) => x.kind === 'model').length });
const children = (spans: Span[]) => { const k = new Map<string | null, Span[]>(); for (const s of spans) (k.get(s.parent) ?? k.set(s.parent, []).get(s.parent)!).push(s); return k; };

// ---- the minimal trace: deterministic pruning, in this order ----
//  1. drop failed tool spans, and an unanswered attempt that a later successful call of the same family supersedes
//  2. collapse runs of consecutive read-only exploration into one `explored N files` span (the 3 largest targets are kept)
//  3. of the writes to one path keep the last (`edits: n`)
//  4. of the successful Bash commands of one family (commandKeys) keep the last (`runs: n`)
//  5. keep every prompt and segment, every subagent span (pruned the same way, on its own), and the unit's final model call (its report)
// Model calls carry no content, so every other one is dropped (counted). Rules 3 and 4 look across the whole transcript they run on.
export function minimal(t: Trace): Trace {
  const kids = children(t.spans), pruned: Record<string, number> = {}, out: Span[] = [], add = (k: string, n = 1) => void (n && (pruned[k] = (pruned[k] ?? 0) + n));
  function scope(roots: Span[]) {
    const tools: Span[] = [], models: Span[] = [], lists: Span[][] = [];
    const walk = (xs: Span[]) => xs.forEach((s) => { if (s.kind === 'tool') tools.push(s); else if (s.kind === 'model') models.push(s); else if (s.kind !== 'subagent') { const k = kids.get(s.id) ?? []; if (s.kind === 'prompt') lists.push(k); walk(k); } });
    walk(roots);
    const final = models.at(-1), gone = new Set<Span>(), into = new Map<Span, Span>(), absorbed = new Set<Span>(), note = new Map<Span, Partial<Span>>();
    // 1
    const lastOk = new Map<string, number>();
    tools.forEach((s, i) => { if (s.ok) lastOk.set(famKey(s), i); });
    tools.forEach((s, i) => { if (s.ok === false || (s.ok === null && (lastOk.get(famKey(s)) ?? -1) > i)) gone.add(s); });
    add('failed_or_superseded', gone.size);
    // 2, in each prompt's own list: dropped spans and model calls do not break a run, anything else does
    for (const xs of lists) {
      let run: Span[] = [];
      const flush = () => {
        if (run.length > 1) {
          const top = [...run].sort((a, b) => (b.out_tokens_est ?? 0) - (a.out_tokens_est ?? 0)).slice(0, 3), last = run.at(-1)!;
          into.set(run[0], { ...run[0], name: `explored ${run.length} files`, target: top.map((x) => x.target.slice(0, 70)).filter(Boolean).join(', '), t1: last.t1, ms: last.t1 - run[0].t0, ok: true, out_tokens_est: run.reduce((a, x) => a + (x.out_tokens_est ?? 0), 0) });
          run.forEach((x) => absorbed.add(x)); add('collapsed', run.length); add('collapsed_into');
        }
        run = [];
      };
      for (const s of xs) if (s.kind === 'tool' && !gone.has(s) && readOnly(s)) run.push(s); else if (s.kind !== 'model' && !gone.has(s)) flush();
      flush();
    }
    // 3 and 4, over what is left
    const left = tools.filter((s) => !gone.has(s) && !absorbed.has(s));
    const group = (key: (s: Span) => string | null, k: 'edits' | 'runs', reason: string) => {
      const g = new Map<string, Span[]>();
      for (const s of left) { const v = key(s); if (v) (g.get(v) ?? g.set(v, []).get(v)!).push(s); }
      for (const xs of g.values()) { xs.slice(0, -1).forEach((x) => gone.add(x)); add(reason, xs.length - 1); if (xs.length > 1) note.set(xs.at(-1)!, { [k]: xs.length }); }
    };
    group((s) => (WRITE.test(s.name) && s.ok && s.target ? s.target : null), 'edits', 'overwritten_writes');
    group((s) => (s.name === 'Bash' && s.ok ? famKey(s) : null), 'runs', 'repeated_commands');
    // 5, and the output in the original order
    const emit = (xs: Span[]) => {
      for (const s of xs) {
        if (s.kind === 'model') { if (s === final) out.push({ ...s }); else add('model_calls'); }
        else if (s.kind === 'subagent') { out.push({ ...s }); scope(kids.get(s.id) ?? []); }
        else if (s.kind !== 'tool') { out.push({ ...s }); emit(kids.get(s.id) ?? []); }
        else if (into.has(s)) out.push({ ...into.get(s)! });
        else if (!gone.has(s) && !absorbed.has(s)) out.push({ ...s, ...note.get(s) });
      }
    };
    emit(roots);
  }
  scope(kids.get(null) ?? []);
  const k = children(out);
  for (const s of out) s.n_children = k.get(s.id)?.length ?? 0;
  return { ...t, mode: 'minimal', spans: out, counts: counts(out), full: t.counts, pruned };
}

// ---- the outline the writer reads ----
const MD_MAX = 24_000; // ponytail: ~6,000 tokens at 4 characters each
const dur = (ms: number | null) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
// A numbered outline of a (minimal) trace: step, tool, target, outcome, duration; a subagent's steps are a nested list. Over `max` characters it keeps
// every prompt, segment, subagent and write, drops `explored` spans first, then the middle of the other steps (the first 25% and the last 55% stay,
// a "… N steps omitted …" line marks the gap): the setup and the end of a run say more than its long middle, and the oldest steps are the setup.
export function md(t: Trace, max = MD_MAX): string {
  type Item = { text: string; kids: Item[]; prio: number; gone?: boolean };
  const k = children(t.spans), steps = (id: string): number => (k.get(id) ?? []).reduce((a, x) => a + (x.kind === 'tool' || x.kind === 'subagent' ? 1 : 0) + steps(x.id), 0);
  const text = (s: Span) => s.kind === 'segment' ? `Segment: ${s.name}` : s.kind === 'prompt' ? `Prompt: ${s.name}`
    : s.kind === 'subagent' ? `Subagent: ${s.name} — ${steps(s.id)} step${steps(s.id) === 1 ? '' : 's'}, ${dur(s.ms)}`
    : /^explored /.test(s.name) ? `${s.name}${s.target ? `: ${s.target}` : ''}`
    : `${s.name}${s.target ? ` ${code(s.target)}` : ''} — ${s.ok === false ? 'failed' : 'ok'}${s.edits ? `, edits: ${s.edits}` : ''}${s.runs ? `, runs: ${s.runs}` : ''}${s.ms ? `, ${dur(s.ms)}` : ''}`;
  const items = (p: string | null): Item[] => (k.get(p) ?? []).filter((s) => s.kind !== 'model').map((s) => ({ text: text(s), kids: items(s.id),
    prio: s.kind === 'tool' && !WRITE.test(s.name) ? (/^explored /.test(s.name) ? 2 : 1) : 0 }));
  const tree = items(null), flat: Item[] = [], depth = new Map<Item, number>();
  const walk = (xs: Item[], d: number) => xs.forEach((x) => { flat.push(x); depth.set(x, d); walk(x.kids, d + 1); });
  walk(tree, 0);
  const w = (x: Item) => x.text.length + 3 * depth.get(x)! + 6;
  let size = flat.reduce((a, x) => a + w(x), 0), omitted = 0, cut = 0;
  for (const x of flat.filter((x) => x.prio === 2)) { if (size <= max) break; x.gone = true; omitted++; size -= w(x); }
  // the other steps, middle out: from the point 35% of the way along (the middle of the 20% between "first 25%" and "last 55%") until it fits
  const mid = flat.filter((x) => x.prio === 1), c = mid.length * 0.35;
  for (const [, x] of mid.map((x, i) => [Math.abs(i - c), x] as const).sort((a, b) => a[0] - b[0])) { if (size <= max) break; x.gone = true; omitted++; cut++; size -= w(x); }
  const gap = flat.find((x) => x.gone && x.prio === 1);
  const lines = (xs: Item[], d: number): string[] => xs.filter((x) => !x.gone || x === gap).flatMap((x, i) => x === gap ? [`${'   '.repeat(d)}… ${cut} steps omitted …`] : [`${'   '.repeat(d)}${i + 1}. ${x.text}`, ...lines(x.kids, d + 1)]);
  return [`## Trace — ${t.title} (${t.kind}) · ${t.full ? `${t.full.steps} steps → ${t.counts.steps} after pruning` : `${t.counts.steps} steps`}${omitted ? `; ${omitted} more left out to fit` : ''}`, ...lines(tree, 0)].join('\n');
}
