// The Needs you board's rows (needs-you.ts), read by the web app and the phone as @shared/needs-you-types.
// Types only, so the apps can import it without the server.

export type NeedsKind =
  | 'approval' | 'email' | 'secret' | 'purchase' | 'screen' | 'plan'
  | 'question' | 'choice' | 'form' | 'connect' | 'plugin' | 'look' | 'skill' | 'draft'
  | 'task' | 'stalled' | 'handoff';

export interface NeedsItem {
  /** Stable for as long as the item waits: `<chatId>:<seq>` for a card, `task:<id>` for a task. */
  id: string;
  kind: NeedsKind;
  /** A short word for the kind, shown as the row's tag ("Approval", "Question", "Stalled"). */
  label: string;
  /** What is waiting, in a line. */
  title: string;
  /** A second line when there is one (the email's subject, the task's last note). */
  detail: string;
  /** The bot (or group) whose list row this belongs to, and the chat the card is in (a side chat's own id). */
  botId: string;
  chatId: string;
  /** The card's row in the open conversation; absent for a task. */
  seq?: number;
  /** A task's id, for a task or stalled row (they open the bot's tasks). */
  taskId?: string;
  /** The side chat's title, when the card is in one. */
  sideTitle: string | null;
  /** Since when it has waited. */
  at: number;
}

