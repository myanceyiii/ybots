# Phone timers, alarms and reminders

Alex, 2026-11-26: "Can I give it the ability to control my phone by setting timers and alarms, etc?"

## Phone timers and alarms (`phone_action`)

- Server: `server/src/phone.ts`. A bot calls `phone_action` (set_timer, set_alarm, cancel_alarm, show_alarms, show_timers). It runs with no card (low risk) and puts a line in the chat ("⏰ Set a 10 min timer on your phone").
- Who: `bots.phone_actions` (1 on, 0 off, NULL = on for Leonard only). Switch: bot settings > "Phone timers and alarms" on web, Windows and Android. Silo and outside bots never get it.
- Delivery: the Android app's always-on notification link (`GET /api/notify/stream?caps=phone1`). Only apps that send `caps=phone1` get commands.
- Android (`mobile/modules/cleft-background/.../PhoneActions.kt`): the standard `android.provider.AlarmClock` intents with `EXTRA_SKIP_UI`, in the phone's own Clock app. Android only lets an app open another app's screen from the background when it is on screen or has "Display over other apps" (developer.android.com, "Restrictions on starting activities from the background"). Without that, the app posts a "tap to set it" notification on the "Timers and alarms" channel. Settings > bot > "Allow without a tap" opens that Android setting.
- The phone answers `POST /api/phone/actions/:id/result` with done, needs_tap or failed; the bot waits up to 20 s.
- Cancelling: `cancel_alarm` with the alarm's label (`ACTION_DISMISS_ALARM`, label search). A running timer is stopped from the Clock app's timers (`show_timers`); there is no "cancel this timer" intent.

## Reminders and Google Tasks

Handled by `server/src/reminders.ts` (PR 274): a bot with a Google Tasks tool puts "remind me" into Google Tasks, and a set time also gets a one-time app reminder (`create_routine` with `once: true`), which notifies every app. That one-time reminder is also the Windows and web stand-in for a phone timer; the phone prompt (`phoneGuidance` in `server/src/agent/prompt.ts`) points bots to it when the phone is not connected.

## Not tested on a real phone

Clock app behaviour (Google Clock vs Samsung Clock), the background-start check, the tap notification, and `cancel_alarm` by label.
