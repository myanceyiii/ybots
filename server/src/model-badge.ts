import type { LiveModel, ModelTier } from './types.js';

/**
 * The small model badge the apps show on a bot's picture while it works: which model is answering this
 * turn and at what reasoning effort. The server names the model once here, so web, Android and Windows
 * all show the same words without their own copy of these rules.
 *
 * Only the model id, provider and effort go out: no keys, accounts or prompt text.
 */

type Effort = LiveModel['effort'];

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Claude', 'openai-codex': 'ChatGPT', 'openai-api': 'OpenAI', openai: 'OpenAI', xai: 'xAI', 'xai-oauth': 'xAI',
  openrouter: 'OpenRouter', nous: 'Nous', gemini: 'Google', google: 'Google',
};

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "4-5", "4-5-20251001" -> "4.5" (a trailing 8-digit date is a snapshot stamp, not part of the name). */
function version(parts: string[]): string {
  const nums = parts.filter((p) => /^\d{1,3}(\.\d+)?$/.test(p));
  return nums.join('.');
}

/** A short name (fits on a picture) and a full name for one model id. */
export function nameModel(id: string | null, provider: string | null): { short: string; name: string } {
  if (!id || id === 'hermes-agent') {
    const p = provider ? PROVIDER_NAMES[provider] ?? cap(provider) : null;
    return { short: p ?? 'Default', name: p ? `${p} (its default model)` : 'The engine’s default model' };
  }
  // "anthropic/claude-opus-5-5" and "openrouter:x/y" name the model last.
  const bare = id.split(/[/:]/).pop()!.toLowerCase();
  const parts = bare.split(/[-_\s]+/).filter(Boolean);

  const claude = parts.find((p) => p === 'opus' || p === 'sonnet' || p === 'haiku' || p === 'fable');
  if (claude) {
    const v = version(parts.filter((p) => p !== claude));
    return { short: cap(claude), name: `Claude ${cap(claude)}${v ? ` ${v}` : ''}` };
  }

  const gpt = bare.match(/^(?:gpt|chatgpt)-?(\d+(?:\.\d+)?)(?:-(.+))?$/);
  if (gpt) {
    const v = gpt[1];
    const variant = (gpt[2] ?? '').split('-').filter((p) => p && !/^\d{4}/.test(p)).join(' ');
    if (!variant) return { short: `GPT-${v}`, name: `GPT-${v}` };
    // "mini" and "nano" read as sizes; named variants ("sol", "pro", "codex") lead.
    const short = /^(mini|nano)$/.test(variant) ? `${v} ${variant}` : `${v} ${cap(variant.split(' ')[0])}`;
    return { short, name: `GPT-${v} ${variant.split(' ').map(cap).join(' ')}` };
  }

  if (/^o\d/.test(bare)) return { short: bare.split('-')[0], name: `OpenAI ${bare}` };

  const family = parts[0];
  const v = version(parts.slice(1));
  const known: Record<string, string> = { grok: 'Grok', gemini: 'Gemini', hermes: 'Hermes', llama: 'Llama', mistral: 'Mistral', qwen: 'Qwen', deepseek: 'DeepSeek', kimi: 'Kimi' };
  if (known[family]) {
    const rest = parts.slice(1).filter((p) => !/^\d/.test(p)).map(cap).join(' ');
    return { short: v ? `${known[family]} ${v.split('.')[0]}` : known[family], name: `${known[family]}${v ? ` ${v}` : ''}${rest ? ` ${rest}` : ''}` };
  }
  const short = cap(family).slice(0, 8);
  return { short, name: id };
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh'];
export function cleanBadgeEffort(e: unknown): Effort {
  return EFFORTS.includes(e as Effort) ? (e as Effort) : 'medium';
}

/** The live badge for a turn on `model`/`provider` at `effort`. */
export function liveModel(p: { model: string | null; provider: string | null; effort: unknown; tier: ModelTier | null; mode: 'manual' | 'auto'; fallback?: boolean }): LiveModel {
  const { short, name } = nameModel(p.model, p.provider);
  return {
    id: p.model && p.model !== 'hermes-agent' ? p.model : null,
    provider: p.provider,
    effort: cleanBadgeEffort(p.effort),
    tier: p.tier,
    mode: p.mode,
    fallback: !!p.fallback,
    short,
    name,
  };
}

/**
 * Hermes' notice when it gives up on the turn's model and moves to a fallback, e.g.
 * "🔄 Switched to fallback model: claude-opus-5-5 via anthropic → claude-sonnet-5 via anthropic".
 * Returns the model it moved to, or null for any other status line.
 */
export function parseFallback(text: string): { model: string; provider: string | null } | null {
  const m = text.match(/fallback(?: model)?[^:]*:.*?(?:→|->)\s*(\S+)(?:\s+(?:via|on)\s+(\S+))?/i);
  if (!m) return null;
  return { model: m[1].replace(/[.,;)]+$/, ''), provider: m[2] ? m[2].replace(/[.,;)]+$/, '') : null };
}
