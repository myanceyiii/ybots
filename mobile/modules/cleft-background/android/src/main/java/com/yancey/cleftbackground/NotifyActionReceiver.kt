package com.yancey.cleftbackground

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Allow or Deny tapped on a low-risk approval notification. Sends the same answer the app's card
 * sends (POST /api/approvals/:id with the card's digest), so the server binds it to that exact
 * action and refuses it if the card was already answered or has changed. Then says what happened.
 */
class NotifyActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.getStringExtra("kind") == "choice") { onChoice(context, intent); return }
    val aid = intent.getStringExtra("approvalId") ?: return
    val digest = intent.getStringExtra("digest") ?: return
    val decision = intent.getStringExtra("decision")?.takeIf { it == "allow" || it == "deny" } ?: return
    val tag = intent.getStringExtra("tag") ?: "apr:$aid"
    val title = intent.getStringExtra("title") ?: ""
    val pending = goAsync()
    Thread {
      val result = try { send(context, aid, digest, decision) } catch (e: Exception) { "Couldn't reach your server. Open the app to answer." }
      tell(context, tag, title, result)
      pending.finish()
    }.start()
  }

  private fun send(c: Context, aid: String, digest: String, decision: String): String {
    val server = NotifyService.prefs(c).getString("server", null) ?: return "Open the app to answer."
    val conn = URL("$server/api/approvals/${java.net.URLEncoder.encode(aid, "UTF-8")}").openConnection() as HttpURLConnection
    conn.requestMethod = "POST"
    conn.connectTimeout = 15_000; conn.readTimeout = 20_000
    conn.doOutput = true
    conn.setRequestProperty("content-type", "application/json")
    conn.setRequestProperty("accept", "application/json")
    // So the card records that it was answered from a notification (shown as "phone notification").
    conn.setRequestProperty("x-cleft-via", "notification")
    NotifyService.headers(c).forEach { (k, v) -> conn.setRequestProperty(k, v) }
    try {
      conn.outputStream.use { it.write(JSONObject().put("decision", decision).put("digest", digest).toString().toByteArray()) }
      val code = conn.responseCode
      return when {
        code in 200..299 -> if (decision == "allow") "Allowed." else "Denied."
        code == 409 -> {
          val st = try { JSONObject(conn.errorStream.bufferedReader().use { it.readText() }).optJSONObject("approval")?.optString("status") } catch (_: Exception) { null }
          when (st) { "allowed", "always" -> "It was already allowed."; "denied" -> "It was already denied."; "expired" -> "This request ran out of time."; else -> "This card changed. Open the app to see it." }
        }
        code == 404 -> "This request is gone."
        else -> "The server said no ($code). Open the app to answer."
      }
    } finally { conn.disconnect() }
  }

  /**
   * An answer tapped on a choice-buttons notice: the same pick the chat's buttons send, posted as the
   * person's own chat reply. It carries no approval id or digest, so it can't approve anything.
   */
  private fun onChoice(context: Context, intent: Intent) {
    val chatId = intent.getStringExtra("chatId") ?: return
    val seq = intent.getIntExtra("seq", 0).takeIf { it > 0 } ?: return
    val generation = intent.getIntExtra("generation", 0)
    val block = intent.getStringExtra("block") ?: return
    val index = intent.getIntExtra("index", -1).takeIf { it >= 0 } ?: return
    val label = intent.getStringExtra("label") ?: ""
    val tag = intent.getStringExtra("tag") ?: "chat:$chatId"
    val title = intent.getStringExtra("title") ?: ""
    val pending = goAsync()
    Thread {
      val result = try { sendChoice(context, chatId, seq, generation, block, index, label) } catch (e: Exception) { "Couldn't reach your server. Open the app to answer." }
      tell(context, tag, title, result, NotifyService.CH_MESSAGES)
      pending.finish()
    }.start()
  }

  private fun sendChoice(c: Context, chatId: String, seq: Int, generation: Int, block: String, index: Int, label: String): String {
    val server = NotifyService.prefs(c).getString("server", null) ?: return "Open the app to answer."
    val conn = URL("$server/api/bots/${java.net.URLEncoder.encode(chatId, "UTF-8")}/cards/$seq/view?generation=$generation").openConnection() as HttpURLConnection
    conn.requestMethod = "POST"
    conn.connectTimeout = 15_000; conn.readTimeout = 20_000
    conn.doOutput = true
    conn.setRequestProperty("content-type", "application/json")
    conn.setRequestProperty("accept", "application/json")
    conn.setRequestProperty("x-cleft-via", "notification")
    NotifyService.headers(c).forEach { (k, v) -> conn.setRequestProperty(k, v) }
    try {
      val body = JSONObject().put("op", "pick").put("block", block).put("picked", org.json.JSONArray().put(index))
      conn.outputStream.use { it.write(body.toString().toByteArray()) }
      val code = conn.responseCode
      return when {
        code in 200..299 -> "Sent: $label"
        code == 409 -> "Already answered. Open the app to see it."
        code == 404 -> "This chat is gone."
        else -> "The server said no ($code). Open the app to answer."
      }
    } finally { conn.disconnect() }
  }

  private fun tell(c: Context, tag: String, title: String, text: String, channel: String = NotifyService.CH_APPROVALS) {
    if (!NotifyService.canPost(c)) return
    val n = NotificationCompat.Builder(c, channel)
      .setSmallIcon(c.applicationInfo.icon)
      .setContentTitle(title)
      .setContentText(text)
      .setSilent(true)
      .setAutoCancel(true)
      .setTimeoutAfter(8_000)
      .build()
    try { NotificationManagerCompat.from(c).notify(tag, 0, n) } catch (_: SecurityException) {}
  }
}
