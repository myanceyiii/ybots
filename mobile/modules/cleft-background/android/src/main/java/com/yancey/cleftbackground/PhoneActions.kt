package com.yancey.cleftbackground

import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.AlarmClock
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Timers and alarms a bot sets on this phone (server phone.ts). The server sends a `phone-action` event down
 * the notification link (NotifyService); this runs it with Android's standard AlarmClock intents in the
 * phone's own Clock app, then tells the server what happened (POST /api/phone/actions/<id>/result).
 *
 * Android lets an app open another app's screen from the background only in some cases: the app is on screen,
 * or the person allowed it "Display over other apps" (developer.android.com, "Restrictions on starting
 * activities from the background"). A blocked start fails silently, so this checks first. When it may not,
 * it shows a notification instead; a tap on a notification is always allowed to open it, so the timer or
 * alarm is set on that tap ("needs_tap").
 */
object PhoneActions {
  const val CH_PHONE = "cleft-phone"

  private fun channel(c: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = c.getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(NotificationChannel(CH_PHONE, "Timers and alarms", NotificationManager.IMPORTANCE_HIGH).apply {
      description = "A bot set a timer or alarm while YBots was in the background: tap to finish setting it."; group = "cleft"
    })
  }

  /** Whether Android lets this app start the Clock app right now. */
  fun canStartNow(c: Context): Boolean {
    if (Build.VERSION.SDK_INT >= 23 && Settings.canDrawOverlays(c)) return true
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  /** The Clock app intent for a command, or null when this Android can't do it. */
  fun intentFor(a: JSONObject, skipUi: Boolean): Intent? {
    val label = a.optString("label", "")
    val i = when (a.optString("action")) {
      "set_timer" -> Intent(AlarmClock.ACTION_SET_TIMER).apply {
        putExtra(AlarmClock.EXTRA_LENGTH, a.optInt("seconds"))
        if (label.isNotEmpty()) putExtra(AlarmClock.EXTRA_MESSAGE, label)
        putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi)
      }
      "set_alarm" -> Intent(AlarmClock.ACTION_SET_ALARM).apply {
        putExtra(AlarmClock.EXTRA_HOUR, a.optInt("hour"))
        putExtra(AlarmClock.EXTRA_MINUTES, a.optInt("minute"))
        if (label.isNotEmpty()) putExtra(AlarmClock.EXTRA_MESSAGE, label)
        a.optJSONArray("days")?.let { d ->
          val days = ArrayList<Int>()
          for (k in 0 until d.length()) days.add(d.optInt(k))
          if (days.isNotEmpty()) putExtra(AlarmClock.EXTRA_DAYS, days)
        }
        if (a.has("vibrate")) putExtra(AlarmClock.EXTRA_VIBRATE, a.optBoolean("vibrate", true))
        putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi)
      }
      "cancel_alarm" -> {
        if (Build.VERSION.SDK_INT < 23) return null
        Intent(AlarmClock.ACTION_DISMISS_ALARM).apply {
          if (label.isNotEmpty()) {
            putExtra(AlarmClock.EXTRA_ALARM_SEARCH_MODE, AlarmClock.ALARM_SEARCH_MODE_LABEL)
            putExtra(AlarmClock.EXTRA_MESSAGE, label)
          } else putExtra(AlarmClock.EXTRA_ALARM_SEARCH_MODE, AlarmClock.ALARM_SEARCH_MODE_ALL)
        }
      }
      "show_alarms" -> Intent(AlarmClock.ACTION_SHOW_ALARMS)
      "show_timers" -> if (Build.VERSION.SDK_INT >= 26) Intent(AlarmClock.ACTION_SHOW_TIMERS) else null
      else -> null
    } ?: return null
    return i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  }

  /** Run one command (on the link's thread) and report back on a thread of its own. */
  fun run(c: Context, a: JSONObject) {
    val id = a.optString("id")
    if (id.isEmpty()) return
    val (state, detail) = try { perform(c, a) } catch (e: Exception) { "failed" to (e.message ?: "error").take(200) }
    Thread({ report(c, id, state, detail) }, "cleft-phone-result").start()
  }

  private fun perform(c: Context, a: JSONObject): Pair<String, String?> {
    val id = a.optString("id")
    val showing = a.optString("action").startsWith("show_") || a.optString("action") == "cancel_alarm"
    val intent = intentFor(a, skipUi = true) ?: return "failed" to "This phone's Android version can't do that"
    if (intent.resolveActivity(c.packageManager) == null) return "failed" to "No clock app on this phone takes it"
    if (canStartNow(c)) {
      c.startActivity(intent)
      return "done" to null
    }
    // Not allowed from the background: a notification the person taps. On that tap the Clock app shows it.
    if (!NotifyService.canPost(c)) return "failed" to "YBots may not show notifications, so it couldn't ask for a tap"
    channel(c)
    val tapIntent = intentFor(a, skipUi = showing) ?: intent
    val code = id.hashCode()
    val pi = PendingIntent.getActivity(c, code, tapIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val title = "${a.optString("by", "A bot")}: ${a.optString("title")}"
    val n = NotificationCompat.Builder(c, CH_PHONE)
      .setSmallIcon(c.applicationInfo.icon)
      .setContentTitle(title)
      .setContentText(if (showing) "Tap to open it in your Clock app." else "Tap to set it in your Clock app.")
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_REMINDER)
      .setAutoCancel(true)
      .setContentIntent(pi)
      .build()
    return try {
      NotificationManagerCompat.from(c).notify("phone:$id", 0, n)
      "needs_tap" to null
    } catch (e: SecurityException) { "failed" to "YBots may not show notifications" }
  }

  private fun report(c: Context, id: String, state: String, detail: String?) {
    val server = NotifyService.prefs(c).getString("server", null) ?: return
    for (attempt in 0 until 3) {
      try {
        val conn = URL("$server/api/phone/actions/${URLEncoder.encode(id, "UTF-8")}/result").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 10_000
        conn.readTimeout = 10_000
        conn.doOutput = true
        conn.setRequestProperty("content-type", "application/json")
        NotifyService.headers(c).forEach { (k, v) -> conn.setRequestProperty(k, v) }
        val body = JSONObject().put("state", state).apply { if (detail != null) put("detail", detail) }.toString()
        conn.outputStream.use { it.write(body.toByteArray()) }
        val code = conn.responseCode
        conn.disconnect()
        if (code < 500) return
      } catch (_: Exception) { /* try again */ }
      try { Thread.sleep(1_000L * (attempt + 1)) } catch (_: InterruptedException) { return }
    }
  }
}
