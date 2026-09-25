// P3: join Claude Code transcripts to the ledger on requestId. Same process as the router.
// One API response is written as several `assistant` rows (one per content block), each carrying the full usage;
// the UPDATE is idempotent, so re-applying it per row is harmless.
import { watch, readdirSync, statSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { db } from './ledger.ts';

const ROOT = process.env.CLAUDE_PROJECTS_DIR ?? `${homedir()}/.claude/projects`;
const CHUNK = 4 << 20; // read in 4 MB slices and yield between them so a big first scan never stalls proxying

const upd = db.prepare(`update requests set in_tok = :in_tok, out_tok = :out_tok, cache_read = :cache_read, cache_create = :cache_create,
  cache_1h = :cache_1h, cache_5m = :cache_5m, thinking_tok = :thinking_tok, jsonl_path = :jsonl_path, session_id = :session_id,
  api_block_index = :api_block_index, model_from_transcript = :model, agent_id = :agent_id where request_id = :rid`);
const sess = db.prepare(`update sessions set cwd = coalesce(:cwd, cwd), last_ts = max(coalesce(last_ts, 0), :ts)
  where session_key = (select session_key from requests where request_id = :rid)`);
// Titles are upserted: the first prompt hits the transcript before the router has logged (and created) the session.
const title = db.prepare(`insert into sessions (session_key, created_ts, title, cwd) values (:sid, :ts, :title, :cwd) on conflict (session_key)
  do update set title = iif(:force, excluded.title, coalesce(title, excluded.title)), cwd = coalesce(cwd, excluded.cwd)`);
const agent = db.prepare(`insert into agents values (:id, :sk, coalesce(:force, :name), :ts, :ts) on conflict (agent_id)
  do update set name = coalesce(:force, name, :name), last_ts = max(last_ts, :ts)`);
const SUB = /([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/; // <session>/subagents/agent-<id>.jsonl
const typed = (c: any) => typeof c === 'string' ? c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
// the desktop's short subagent label ("description") lives next to the transcript in agent-<id>.meta.json
const desc = (path: string) => { try { return JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8')).description || null; } catch { return null; } };
const named = new Set<string>(); // files whose first typed prompt was already used this run
const tool = db.prepare('insert or ignore into tool_uses (id, request_id, name) values (?, ?, ?)');
const getOff = db.prepare('select offset from tail_offsets where path = ?');
const setOff = db.prepare('insert into tail_offsets values (?, ?) on conflict (path) do update set offset = excluded.offset');

// The CLI writes a response's rows while it streams; the router logs the request row only when the stream ends
// (observed: up to minutes later). Unmatched recent rows wait here until the router calls joined(requestId).
const pending = new Map<string, { at: number; p: Record<string, any>; s: Record<string, any> }>();
function apply(p: Record<string, any>, s: Record<string, any>) {
  if (!upd.run(p).changes) return false;
  sess.run(s);
  return true;
}
export function joined(rid: string | null) {
  const x = rid && pending.get(rid);
  if (x) { pending.delete(rid!); apply(x.p, x.s); }
}

function line(l: string, path: string) {
  const meta = l.includes('"custom-title"') || l.includes('"agent-name"') || (!named.has(path) && l.includes('"type":"user"'));
  if (!meta && (!l.includes('"requestId"') || !l.includes('"assistant"'))) return; // cheap prefilter; most lines are user/tool rows
  let r: any, t: string;
  try { r = JSON.parse(l); } catch { return; }
  const sub = path.match(SUB), ts = Date.parse(r.timestamp) || Date.now();
  if (r.type === 'custom-title' && !sub && r.sessionId && r.customTitle) title.run({ sid: r.sessionId, ts, title: r.customTitle, force: 1, cwd: null });
  if (r.type === 'agent-name' && sub && r.agentName) agent.run({ id: sub[2], sk: sub[1], ts, force: r.agentName, name: null });
  if (r.type === 'user' && !named.has(path) && (t = typed(r.message?.content))) {
    named.add(path);
    if (sub) agent.run({ id: sub[2], sk: sub[1], ts, force: null, name: desc(path) ?? t });
    else if (r.sessionId) title.run({ sid: r.sessionId, ts, title: t, force: 0, cwd: r.cwd ?? null });
  }
  if (r.type !== 'assistant' || !r.requestId || !r.message) return;
  if (sub) agent.run({ id: sub[2], sk: sub[1], ts, force: null, name: null });
  const u = r.message.usage ?? {}, rid = r.requestId;
  for (const b of r.message.content ?? []) if (b?.type === 'tool_use' && b.id && b.name) tool.run(b.id, rid, b.name);
  const p = {
    rid, in_tok: u.input_tokens ?? null, out_tok: u.output_tokens ?? null, cache_read: u.cache_read_input_tokens ?? null,
    cache_create: u.cache_creation_input_tokens ?? null, cache_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? null,
    cache_5m: u.cache_creation?.ephemeral_5m_input_tokens ?? null, thinking_tok: u.output_tokens_details?.thinking_tokens ?? null,
    jsonl_path: path, session_id: r.sessionId ?? null, api_block_index: r.apiBlockIndex ?? null, model: r.message.model ?? null, agent_id: sub?.[2] ?? null,
  };
  const s = { rid, cwd: r.cwd ?? null, ts };
  if (!apply(p, s) && Date.now() - ts < 30 * 60_000) pending.set(rid, { at: Date.now(), p, s });
}

async function tail(path: string) {
  let size: number;
  try { size = statSync(path).size; } catch { return; }
  let off = (getOff.get(path) as any)?.offset ?? 0;
  if (size < off) off = 0; // truncated or replaced: start over
  if (size === off) return;
  const fh = await open(path, 'r');
  try {
    while (off < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - off));
      const { bytesRead } = await fh.read(buf, 0, buf.length, off);
      const end = buf.lastIndexOf(10, bytesRead - 1); // only whole lines; a partial last line is read next time
      if (end < 0) break;
      db.exec('begin');
      try {
        for (const l of buf.subarray(0, end).toString('utf8').split('\n')) line(l, path);
        setOff.run(path, (off += end + 1));
        db.exec('commit');
      } catch (e) { db.exec('rollback'); throw e; }
      await new Promise((r) => setImmediate(r));
    }
  } finally { await fh.close(); }
}

// Serialised work queue: fs.watch fires many events per append; each file is tailed once per burst.
const dirty = new Set<string>();
let running: Promise<void> | null = null;
function kick(path: string) {
  dirty.add(path);
  running ??= (async () => {
    for (const p of dirty) {
      dirty.delete(p);
      await tail(p).catch((e) => console.error('tailer:', e.code ?? e.message));
    }
    running = null;
    for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60_000) pending.delete(k);
  })();
}
export const idle = async () => { while (running) await running; }; // tests

export function startTailer() {
  let files: string[];
  try { files = (readdirSync(ROOT, { recursive: true }) as string[]).filter((f) => f.endsWith('.jsonl')).map((f) => `${ROOT}/${f}`); }
  catch { return console.log(`tailer off (no ${ROOT})`); }
  const known = new Set((db.prepare('select path from tail_offsets').all() as any[]).map((r) => r.path));
  for (const f of files) {
    // first sight of a file: only the last 7 days are worth joining; older ones start at their end
    if (known.has(f) || Date.now() - statSync(f).mtimeMs < 7 * 864e5) kick(f);
    else setOff.run(f, statSync(f).size);
  }
  watch(ROOT, { recursive: true }, (_, f) => { if (f?.endsWith('.jsonl')) kick(`${ROOT}/${f}`); })
    .on('error', (e: any) => console.error('tailer watch:', e.code));
  console.log(`tailer on (${files.length} transcripts)`);
}
