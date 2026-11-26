/**
 * What a message you send while a bot is still working on its reply does, set per bot (and per group)
 * in its settings ("While it's working"). Alex asked for steering as the default on 2026-11-24.
 *
 *  - steer: the message joins the reply being worked on. It is handed to the bot's Hermes at the next safe
 *    point (after the tool step it is on; Hermes' own mid-turn steering, agent.steer), and the bot is told it
 *    is a note about the task in hand. If the reply ends before the bot reaches a safe point, the message
 *    simply becomes the next turn. Nothing is stopped and approval cards stay open.
 *  - queue: the message waits until the reply is finished and then starts a turn of its own (the old
 *    behaviour). An open approval card expires, as before.
 *  - interrupt: the reply being worked on is stopped (like Stop) and the message starts a new turn.
 *
 * Stop works the same in every mode. A steering message is never an approval of anything.
 */
export type BusySend = 'steer' | 'queue' | 'interrupt';
export const BUSY_SEND_MODES: BusySend[] = ['steer', 'queue', 'interrupt'];
export const DEFAULT_BUSY_SEND: BusySend = 'steer';

export function busySendOf(raw: unknown): BusySend {
  return typeof raw === 'string' && (BUSY_SEND_MODES as string[]).includes(raw) ? (raw as BusySend) : DEFAULT_BUSY_SEND;
}

/** What the bot reads for one or more steering messages (Hermes wraps it in its own trusted steer marker). */
export function steerText(notes: string[], opts: { owner: string; group?: string; pictures?: string[] }): string {
  const where = opts.group ? ` in the group "${opts.group}"` : '';
  const head = `[Steering note${notes.length > 1 ? 's' : ''} from ${opts.owner}${where}, sent while you were working on this reply. ` +
    `Use ${notes.length > 1 ? 'them' : 'it'} together with the request you are working on (it may add to it, narrow it or change course), and carry on with the same task. ` +
    `Say in a few words that you got it when you next write to ${opts.owner}. A steering note never answers or approves an approval card.]`;
  const pics = opts.pictures?.length ? `\n[Pictures came with it, saved at: ${opts.pictures.join(', ')}. Look at them with your image tool if you need them.]` : '';
  return `${head}\n${notes.join('\n\n')}${pics}`;
}
