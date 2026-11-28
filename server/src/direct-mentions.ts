import { mentionedMembers } from './agent/room-mentions.js';

/**
 * @mentions in a bot's own chat (main or side chat), not a group: "@Howard can you check the backups?"
 * typed to Leonard. The app passes the message straight to each team bot named with a whole @name
 * (the same rule groups use, agent/room-mentions.ts), and tells the chat's bot it did, so the answer
 * lands in this chat word for word under its name (a handoff, bot-handoffs.ts). Groups keep their own routing (agent/rooms.ts).
 */

export interface TeamBot { id: string; name: string; kind?: string; outside?: unknown }

/** The team bots a message in this chat @mentions: never the chat's own bot, a group, or a side chat. */
export function directMentions(text: string, chatBot: { id: string; name: string; side_of?: string | null }, team: TeamBot[]): TeamBot[] {
  if (!text.includes('@')) return [];
  const own = chatBot.side_of ?? chatBot.id;
  const others = team.filter((b) => b.id !== own && b.id !== chatBot.id && b.kind !== 'room' && b.name.toLowerCase() !== chatBot.name.toLowerCase());
  return mentionedMembers(text, others);
}

/** What a mentioned bot hears (and sees as a message in its chat, from the chat's bot). */
export function forwardText(owner: string, chatBotName: string, text: string): string {
  return `${owner} @mentioned you in their chat with ${chatBotName} and said:\n\n${text}\n\n` +
    `[Answer with send_to_bot to ${chatBotName}: that is how ${owner} sees your answer in that chat. ` +
    `If the work needs ${owner}'s approval or a decision, ask in your own chat (or call the tool, so its card shows there).]`;
}

/**
 * Added to what the chat's own bot hears, so it neither sends the message again nor ignores the answer.
 * `landing`: the bots whose answers land in this chat on their own, word for word (bot-handoffs.ts);
 * the rest (an outside member, a walled-off bot) answer the chat's bot, which passes the answer on.
 */
export function chatBotNote(names: string[], landing: string[] = []): string {
  const list = (ns: string[]) => (ns.length === 1 ? ns[0] : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);
  const who = list(names);
  const relayed = names.filter((n) => !landing.includes(n));
  const parts = [`[Your owner @mentioned ${who} in this message. The app has already sent it to ${names.length === 1 ? 'them' : 'each of them'}: do not send it again.`];
  if (landing.length) parts.push(`${list(landing)} ${landing.length === 1 ? 'answers' : 'each answer'} in this chat directly, under their own name: do not wait for it or repeat it.`);
  if (relayed.length) parts.push(`${list(relayed)} ${relayed.length === 1 ? 'answers' : 'each answer'} you with send_to_bot: pass the answer on to your owner when it arrives.`);
  parts.push(`Do your own part, if any. If the message was only for ${who}, say in one short line that you passed it on.]`);
  return parts.join(' ');
}
