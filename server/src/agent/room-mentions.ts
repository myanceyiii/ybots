/** Match whole @names. Prefer the longest member name when names share words. */
export function mentionedMembers<T extends { name: string }>(text: string, members: T[]): T[] {
  const names = [...new Set(members.map((member) => member.name.toLowerCase()).filter(Boolean))];
  if (!names.length) return [];
  const escaped = names.sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp('(?<![\\p{L}\\p{M}\\p{N}_@.+/-])@(' + escaped.join('|') + ')(?![\\p{L}\\p{M}\\p{N}_-])', 'giu');
  const matched = new Set(Array.from(text.matchAll(pattern), (match) => match[1].toLowerCase()));
  return members.filter((member) => matched.has(member.name.toLowerCase()));
}
