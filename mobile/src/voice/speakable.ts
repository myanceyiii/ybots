// What a reply sounds like when read out (calls, the quick-ask card). web/src/voice/speakable.ts and mobile/src/voice/speakable.ts are the same file.

/** No markdown, links or code. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*|__|~~|\*|_(?=\S)|(?<=\S)_/g, '')
    .replace(/\|/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Where the last complete sentence in `text` ends (for text still streaming in), or -1. */
export function lastSentenceEnd(text: string): number {
  let end = -1;
  const re = /[.!?…:;](?=\s|$)|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) end = m.index + m[0].length;
  return end;
}
