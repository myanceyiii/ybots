/** The call brain's reply format (calls.ts). Pure module: no database, so tests can load it on its own. */
export interface Turn { who: 'bot' | 'them'; text: string }
export interface CallReply { say: string; action: 'talk' | 'hang_up' | 'press_keys'; keys?: string; note?: string; invalid?: boolean }

/** The model's answer turned into a reply the call service can act on. Anything that is not the JSON turn is marked invalid and never spoken. */
export function parseReply(raw: string): CallReply {
  const text = (raw ?? '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      const action = ['talk', 'hang_up', 'press_keys'].includes(o.action) ? o.action : 'talk';
      const say = typeof o.say === 'string' ? o.say.trim().slice(0, 600) : '';
      const keys = typeof o.keys === 'string' ? o.keys.replace(/[^0-9*#]/g, '').slice(0, 20) : '';
      const note = typeof o.note === 'string' ? o.note.trim().slice(0, 500) : '';
      if (action === 'press_keys' && !keys) return { say, action: 'talk', ...(note ? { note } : {}) };
      return { say, action, ...(action === 'press_keys' ? { keys } : {}), ...(note ? { note } : {}) };
    } catch { /* fall through */ }
  }
  // Not the JSON turn we asked for (often an engine error such as "credits exhausted"): never spoken.
  return { say: '', action: 'talk', invalid: true };
}

/**
 * The call as chat turns: their words as user messages, the bot's as its own earlier JSON turns. Small models
 * follow this much better than one block of transcript, and Ollama reuses the work on everything said before.
 */
export function localMessages(instructions: string, turns: Turn[]): { role: string; content: string }[] {
  const msgs = [{ role: 'system', content: instructions }];
  for (const t of turns.slice(-40)) {
    const text = String(t.text ?? '').slice(0, 800);
    if (t.who === 'bot') msgs.push({ role: 'assistant', content: JSON.stringify({ say: text, action: 'talk' }) });
    else msgs.push({ role: 'user', content: `Them: ${text}` });
  }
  if (msgs[msgs.length - 1].role !== 'user') msgs.push({ role: 'user', content: '(silence: nobody has said anything yet)' });
  return msgs;
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Why a turn must not be spoken, or null. The bot never claims to be the person it calls for (named in its
 * introduction, "calling for <name>") or a human, and never repeats its introduction or its last line.
 */
export function turnProblem(say: string, turns: Turn[]): string | null {
  const text = norm(say);
  if (!text) return null;
  const intro = turns.find((t) => t.who === 'bot')?.text ?? '';
  const m = intro.match(/calling (?:for|on behalf of) ([A-Z][\w'.-]*(?: [A-Z][\w'.-]*){0,3})/);
  if (m) {
    const name = norm(m[1]);
    const first = name.split(' ')[0];
    const claim = new RegExp(`\\b(i am|i m|im|this is|my name is|it s|speaking is)( mr| mister)? (${name}|${first})\\b`);
    if (claim.test(text)) return `it claimed to be ${m[1]}, but you are an AI assistant calling for them`;
  }
  if (/\b(i am|i m) (a )?(human|real person|real|alive|a person|not an? ai)\b/.test(text)) return 'it claimed to be a person, but you are an AI assistant';
  const said = turns.filter((t) => t.who === 'bot').map((t) => norm(t.text));
  const grams = (t: string) => { const w = t.split(' '); const g = new Set<string>(); for (let i = 0; i + 2 < w.length; i++) g.add(w.slice(i, i + 3).join(' ')); return g; };
  const mine = grams(text);
  for (const s of said) {
    if (!s) continue;
    if (s === text) return 'it repeated something you already said';
    if (mine.size >= 4) {
      const theirs = grams(s);
      let same = 0;
      for (const g of mine) if (theirs.has(g)) same++;
      if (same / mine.size >= 0.6) return 'it repeated something you already said';
    }
  }
  return null;
}
