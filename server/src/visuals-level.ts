/**
 * How often a bot reaches for answer views, calculators, tap choices and Pages, set per bot in its
 * settings ("Visuals in replies"). It only changes the guidance in the bot's prompt (agent/prompt.ts and
 * the group brief in agent/rooms.ts); the tools stay available at every level.
 *
 * This is separate from the app's own "Answer visuals: Rich / Simple" switch, which only changes how
 * a device draws views that arrive (Simple shows them as text). That one is per device; this one is per bot.
 *
 * The text must not depend on the clock: it sits in the cached part of the prompt.
 */
export type VisualsLevel = 'minimal' | 'balanced' | 'rich';
export const VISUALS_LEVELS: VisualsLevel[] = ['minimal', 'balanced', 'rich'];
/** New and existing bots start here (Alex asked for more visuals by default, 2026-11-23). */
export const DEFAULT_VISUALS: VisualsLevel = 'rich';

export function isVisualsLevel(v: unknown): v is VisualsLevel {
  return typeof v === 'string' && (VISUALS_LEVELS as string[]).includes(v);
}
export function visualsOf(raw: unknown): VisualsLevel {
  return isVisualsLevel(raw) ? raw : DEFAULT_VISUALS;
}

/** The "## Visuals" section of a bot's own prompt for its level. */
export function visualsGuidance(level: VisualsLevel, owner: string): string {
  const tail = `Keep your text to a sentence or two that stands on its own, and don't repeat the view's content in it. A tap on a view or button is a chat reply, never an approval.`;
  if (level === 'minimal') {
    return `## Visuals (set to Minimal by ${owner})
Reply in plain text. Use show_view, calculators or Pages only when ${owner} asks for a chart, table, calculator, tracker or similar. Still use offer_choices for yes-or-no and short set-answer questions, since a tap saves typing. ${tail}`;
  }
  if (level === 'balanced') {
    return `## Visuals (set to Balanced by ${owner})
Use a view when it is clearly easier than text: comparing three or more things, a what-if money question (calc block), several key numbers, a long checklist, or work with several steps (a progress bar you move with update_view). Use offer_choices for questions with 2 to 4 set answers, and a Page for anything you will keep building on together. Otherwise reply in text. ${tail}`;
  }
  return `## Visuals (set to Rich by ${owner})
Show it, don't just say it. Before each reply, ask whether a view, buttons or a Page would make it quicker to read or act on, and use one whenever it would. Look for these:
- Comparing options, prices, plans or before and after: a table; a chart when numbers change over time or between items.
- Money, budgets, loans, splits, savings or any what-if: a calc block with sliders for the numbers ${owner} might change.
- A few key numbers (balances, totals, counts, due dates): key stats.
- Steps, to-dos, shopping or packing lists: a checklist; a Page instead if it will be kept or added to.
- Work with several steps or that takes a while: show a progress bar early and move it with update_view.
- A question with 2 to 4 set answers: offer_choices.
- Plans, trackers, research, schedules or anything you'll build on together: a Page.
- An obvious next action: a next-step button.
- A screen with several parts that blocks can't lay out (cards side by side, tabs, a form with checks, an order or booking screen): show_a2ui.
Skip views for greetings, small talk and one-line facts. ${tail}`;
}

/** The sentence about views in a member's group brief (agent/rooms.ts), by that member's level. */
export function groupVisualsLine(level: VisualsLevel): string {
  const choices = `When you ask the user something with a few set answers (yes or no, this or that, up to 4 options), pass post_to_group's choices so they get tap buttons. `;
  if (level === 'minimal') return `Reply in plain text; add post_to_group's view (same blocks as show_view) only if the user asked for a chart, table or calculator. ` + choices;
  const base = `put them in post_to_group's view (same blocks as show_view) with a sentence or two of text, instead of a long Markdown list or table. `;
  if (level === 'balanced') return `When a table, chart, key numbers, steps, a pick or a what-if calculator would clearly read better, ` + base + choices;
  return `Look for chances to show rather than tell: comparisons as a table or chart, money and what-ifs as a calculator, key numbers as stats, steps as a checklist. ` +
    `When any of those fit, ` + base + choices;
}
