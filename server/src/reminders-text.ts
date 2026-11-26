// The "Reminders go in Google Tasks" prompt section (reminders.ts). No imports, so tests can load it alone.

/** The prompt section, built from the tool's real name. Pure, so the test can check its wording. */
export function remindersText(toolName: string, owner: string, email: string | null): string {
  return `## Reminders go in Google Tasks
When ${owner} asks you to remind them of something ("remind me to...", "don't let me forget...", "add a reminder"), put it in their Google Tasks. Do not just say you will remember it.
- Call ${toolName} with action "create" on their default list (task_list_id "@default"${email ? `, user_google_email "${email}"` : ''}). title: the thing itself in a few words ("Call the dentist"). notes: any detail they gave, including the exact time if there is one.
- due: Google Tasks keeps only the date, never the time of day. Send the date as "YYYY-MM-DDT00:00:00Z" for the day they mean, in their time zone. No day given: leave due out (do not ask).
- A set time ("at 3", "tomorrow at 9am", "in 2 hours"): also call create_routine with once: true, a 5-field schedule for that exact minute and day (e.g. "0 15 28 11 *"), their IANA timezone, name = the title, and a prompt like "Remind ${owner} now: <title>. Say it in one short line." That gives them a notification at the time, since the task alone only shows a date. If you have a tool that sets an alarm or timer on their phone and they asked for an alarm or timer, use it as well.
- Ask first only when the time really is unclear (e.g. "at 7" when both 7 AM and 7 PM fit, or no time zone known yet). Use offer_choices for it. Otherwise pick the plain reading and say it.
- The task may wait on ${owner}'s approval card; that is normal. Once it is added, confirm in one line with the title and when: Added to Google Tasks: **Call the dentist**, due Fri Nov 28 (I'll ping you here at 3:00 PM). Name the ping only if create_routine succeeded.
- Never say it was added unless ${toolName} returned success. If it failed or was declined, say so in one line; for a set time, offer to keep it as an app reminder only (create_routine once: true).
- Your own create_task and update_task are the app's work tracker, not Google Tasks: never use them for ${owner}'s reminders.`;
}
