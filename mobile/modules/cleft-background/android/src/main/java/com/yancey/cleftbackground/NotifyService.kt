package com.yancey.cleftbackground

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * The app's own notification link to the YBots server, with no Google service in between.
 *
 * A foreground service holds one long-lived connection to GET /api/notify/stream (server-sent events,
 * a ping every 25 s) and turns each notice into an Android notification on its channel: Messages,
 * Approvals or Jobs, which the person can set one by one in Android's settings. If the link drops it
 * comes back with growing pauses (2 s up to 1 min) and asks for what it missed (`after=<last id>`).
 * It starts again after a restart of the phone (BootReceiver) and when Android ends it (START_STICKY).
 *
 * It is a "specialUse" foreground service: Android 15 limits dataSync services to 6 hours a day,
 * and this one has to stay on. Its own "Connected" notice sits on a silent channel of its own.
 *
 * The server does the filtering (mutes, quiet hours, hidden bots). The
 * service only skips a message for the chat that is open on screen right now.
 */
class NotifyService : Service() {
  companion object {
    const val PREFS = "cleft-notify"
    const val ACTION_START = "com.yancey.cleftbackground.NOTIFY_START"
    const val ACTION_STOP = "com.yancey.cleftbackground.NOTIFY_STOP"
    /** The sign-in or account changed: drop the running connection and open a new one with it. */
    const val ACTION_RESTART = "com.yancey.cleftbackground.NOTIFY_RESTART"
    const val CH_LINK = "cleft-link"
    const val CH_MESSAGES = "cleft-messages"
    const val CH_APPROVALS = "cleft-approvals"
    const val CH_JOBS = "cleft-jobs"
    private const val ONGOING_ID = 7302

    fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun channelFor(ch: String) = when (ch) { "approvals" -> CH_APPROVALS; "jobs" -> CH_JOBS; else -> CH_MESSAGES }

    /** The notification channels, made once; names are what the person sees in Android's settings. */
    fun channels(c: Context) {
      if (Build.VERSION.SDK_INT < 26) return
      val nm = c.getSystemService(NotificationManager::class.java)
      nm.createNotificationChannelGroup(NotificationChannelGroup("cleft", "Notifications"))
      nm.createNotificationChannel(NotificationChannel(CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Replies from your bots and messages in your groups."; group = "cleft"
      })
      nm.createNotificationChannel(NotificationChannel(CH_APPROVALS, "Approvals", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "A bot is waiting on you to allow something or answer a question."; group = "cleft"
      })
      nm.createNotificationChannel(NotificationChannel(CH_JOBS, "Jobs", NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = "Slow work finished: pictures, new looks, documents."; group = "cleft"
      })
      nm.createNotificationChannel(NotificationChannel(CH_LINK, "Connection", NotificationManager.IMPORTANCE_MIN).apply {
        description = "The quiet notice that keeps the link to your server open. You can hide it here."; setShowBadge(false)
      })
    }

    fun canPost(c: Context) = Build.VERSION.SDK_INT < 33 ||
      ContextCompat.checkSelfPermission(c, android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun start(c: Context, action: String = ACTION_START): Boolean = try {
      ContextCompat.startForegroundService(c, Intent(c, NotifyService::class.java).setAction(action)); true
    } catch (e: Exception) { false }

    /** Headers saved by the app: sign-in token and Cloudflare Access, as "name\nvalue\n…", sealed (Sealed.kt). */
    fun headers(c: Context): List<Pair<String, String>> {
      val raw = Sealed.open(prefs(c).getString("headersSealed", null)) ?: ""
      if (raw.isEmpty()) return emptyList()
      val parts = raw.split('\n')
      return (0 until parts.size / 2).map { parts[it * 2] to parts[it * 2 + 1] }
    }
  }

  @Volatile private var running = false
  @Volatile private var restart = false
  @Volatile private var conn: HttpURLConnection? = null
  private var thread: Thread? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    channels(this)
    if (!goForeground()) return START_NOT_STICKY
    val p = prefs(this)
    if (intent?.action == ACTION_STOP || !p.getBoolean("enabled", false) || p.getString("server", null) == null) {
      shutdown(); return START_NOT_STICKY
    }
    if (intent?.action == ACTION_RESTART && thread?.isAlive == true) {
      // New sign-in: the old connection (and any wait, such as the 10 minutes after a 401) ends now,
      // and the loop opens a new one with the new headers and cursor.
      restart = true
      try { conn?.disconnect() } catch (_: Exception) {}
      thread?.interrupt()
    }
    if (thread?.isAlive != true) {
      running = true
      thread = Thread(::loop, "cleft-notify").apply { isDaemon = true; start() }
    }
    return START_STICKY
  }

  override fun onTimeout(startId: Int) { shutdown() }
  override fun onTimeout(startId: Int, fgsType: Int) { shutdown() }

  override fun onDestroy() { running = false; try { conn?.disconnect() } catch (_: Exception) {}; thread?.interrupt(); super.onDestroy() }

  private fun shutdown() {
    running = false
    try { conn?.disconnect() } catch (_: Exception) {}
    thread?.interrupt() // also ends a long wait, so no old worker outlives the service
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun goForeground(): Boolean = try {
    val name = prefs(this).getString("appName", null) ?: "YBots"
    val n = NotificationCompat.Builder(this, CH_LINK)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle("$name is connected")
      .setContentText("You'll hear about replies and approvals. Hold to hide this notice.")
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setContentIntent(openApp(null, null, 0))
      .build()
    ServiceCompat.startForeground(this, ONGOING_ID, n,
      if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
    true
  } catch (e: Exception) {
    // Android would not let it start now (for example from the background): the app starts it next time it opens.
    stopSelf(); false
  }

  private fun loop() {
    var wait = 2_000L
    while (running) {
      val opened = System.currentTimeMillis()
      try { listen() } catch (_: Exception) { /* dropped (or interrupted for a restart): come back below */ }
      if (!running) break
      if (restart) { restart = false; Thread.interrupted(); wait = 2_000L; continue }
      // A link that stayed up a while starts again quickly; one that keeps failing backs off to a minute.
      wait = if (System.currentTimeMillis() - opened > 60_000) 2_000L else minOf(wait * 2, 60_000L)
      try { Thread.sleep(wait) } catch (_: InterruptedException) { if (!running) break; restart = false; continue }
    }
  }

  private fun listen() {
    val p = prefs(this)
    val server = p.getString("server", null) ?: return
    val profile = p.getString("profile", "main") ?: "main"
    val after = p.getLong("lastId", 0)
    // caps=phone1: this app can set timers and alarms (PhoneActions.kt), so the server may send them.
    val url = "$server/api/notify/stream?profile=${URLEncoder.encode(profile, "UTF-8")}&after=$after&caps=phone1"
    val c = URL(url).openConnection() as HttpURLConnection
    conn = c
    c.connectTimeout = 20_000
    c.readTimeout = 70_000 // the server pings every 25 s
    c.setRequestProperty("accept", "text/event-stream")
    headers(this).forEach { (k, v) -> c.setRequestProperty(k, v) }
    try {
      if (c.responseCode == 401) { p.edit().putBoolean("signedOut", true).apply(); Thread.sleep(10 * 60_000L); return }
      if (c.responseCode != 200) return
      c.inputStream.bufferedReader().use { r ->
        var data = StringBuilder()
        while (running) {
          val line = r.readLine() ?: break
          if (line.startsWith("data:")) data.append(line.removePrefix("data:").trimStart())
          else if (line.isEmpty() && data.isNotEmpty()) {
            try { handle(JSONObject(data.toString())) } catch (_: Exception) {}
            data = StringBuilder()
          }
        }
      }
    } finally { c.disconnect(); conn = null }
  }

  private fun handle(ev: JSONObject) {
    val p = prefs(this)
    when (ev.optString("type")) {
      "hello" -> {
        // First connection: start from now, not from a day of old notices.
        if (p.getLong("lastId", 0) == 0L) p.edit().putLong("lastId", ev.optLong("last", 0)).apply()
      }
      "notify" -> {
        val n = ev.optJSONObject("notify") ?: ev.optJSONObject("n") ?: return
        val id = n.optLong("id")
        if (id > p.getLong("lastId", 0)) p.edit().putLong("lastId", id).apply()
        show(n)
      }
      // A bot set a timer or alarm (server phone.ts): run it in the Clock app and answer.
      "phone-action" -> { ev.optJSONObject("a")?.let { PhoneActions.run(this, it) } }
      "notify-clear" -> {
        val tags = ev.optJSONArray("tags") ?: return
        val nm = NotificationManagerCompat.from(this)
        for (i in 0 until tags.length()) { nm.cancel(tags.optString(i), 0); synchronized(history) { history.remove(tags.optString(i)) } }
      }
    }
  }

  private fun show(n: JSONObject) {
    if (!canPost(this)) return
    val p = prefs(this)
    val botId = n.optString("botId")
    // A side chat's notice names its bot (botId) and the side chat (chatId); the chat is what is on screen or opened.
    val chatId = n.optString("chatId").ifEmpty { botId }
    val channel = n.optString("channel", "messages")
    // The person is looking at this chat right now: the message is already on screen.
    if (channel == "messages" && p.getBoolean("visible", false) && p.getString("openChat", null) == chatId) return
    val tag = n.optString("tag", "n${n.optLong("id")}")
    val title = n.optString("title")
    val body = n.optString("body")
    val seq = n.optInt("seq", 0)
    // The bot's own face: who wrote it (in a group, the member who posted), else the group's picture.
    val sender = Faces.parse(n.optJSONObject("sender"))
    val room = Faces.parse(n.optJSONObject("room"))
    val face = (sender ?: room)?.let { try { Faces.bitmap(this, it) } catch (_: Exception) { null } }
    val b = NotificationCompat.Builder(this, channelFor(channel))
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setAutoCancel(true)
      .setWhen(n.optLong("createdAt", System.currentTimeMillis()))
      .setShowWhen(true)
      .setSilent(n.optBoolean("silent", false))
      .setOnlyAlertOnce(n.optBoolean("catchUp", false))
      .setCategory(if (channel == "approvals") NotificationCompat.CATEGORY_REMINDER else if (channel == "messages") NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_STATUS)
      .setGroup("cleft-$channel")
      .setContentIntent(openApp(botId, if (seq > 0) seq else null, tag.hashCode(), if (chatId != botId) chatId else null))
    if (face != null) b.setLargeIcon(face)
    // A message is a conversation with that bot: its face beside the message, the chat as a conversation
    // (Android 11+ shows it in Conversations with the bot's picture), the last few messages kept together.
    if (channel == "messages" && (sender ?: room) != null) {
      try { conversation(b, n, tag, chatId, botId, title, body, sender ?: room!!, face, room) } catch (_: Exception) { /* plain notice as before */ }
    }
    // Allow and Deny right here, only for a low-risk card (the server sends `approval` for those alone).
    // Never "Always allow": that stays on the card in the app.
    n.optJSONObject("approval")?.let { a ->
      val aid = a.optString("id"); val digest = a.optString("digest")
      if (aid.isNotEmpty() && digest.isNotEmpty()) {
        b.addAction(0, "Allow", answer(aid, digest, "allow", tag, title))
        b.addAction(0, "Deny", answer(aid, digest, "deny", tag, title))
      }
    }
    // Choice buttons (server choices.ts): each answer is a button that sends it as your chat reply.
    // A chat reply only, never an approval; the server shows the bot's question in the chat with the pick.
    n.optJSONObject("choices")?.let { c ->
      val opts = c.optJSONArray("options")
      val cseq = c.optInt("seq", 0)
      if (opts != null && cseq > 0) {
        for (i in 0 until minOf(opts.length(), 3)) {
          val label = opts.optString(i)
          if (label.isNotEmpty()) b.addAction(0, label, choose(chatId, cseq, c.optInt("generation", 0), c.optString("block"), i, label, tag, title))
        }
      }
    }
    try { NotificationManagerCompat.from(this).notify(tag, 0, b.build()) } catch (_: SecurityException) {}
  }

  /** The last few messages of each chat notification (by tag), so a new one adds to it instead of replacing it. */
  private val history = HashMap<String, ArrayList<Triple<Person, String, Long>>>()

  private fun conversation(
    b: NotificationCompat.Builder, n: JSONObject, tag: String, chatId: String, botId: String,
    title: String, body: String, who: Faces.Face, face: android.graphics.Bitmap?, room: Faces.Face?,
  ) {
    val group = room != null
    val person = Person.Builder().setKey("bot:${who.id}").setName(who.name)
      .apply { if (face != null) setIcon(IconCompat.createWithBitmap(face)) }.build()
    // A group's body reads "Leonard: Dinner at 6"; in a conversation the name is already beside the message.
    val text = if (group && body.startsWith("${who.name}: ")) body.removePrefix("${who.name}: ") else body
    val at = n.optLong("createdAt", System.currentTimeMillis())
    val lines = synchronized(history) {
      val l = history.getOrPut(tag) { ArrayList() }
      // A notice sent again (catch-up after a dropped link) is not added twice.
      if (l.none { it.second == text && it.third == at }) l.add(Triple(person, text, at))
      // Messages from hours ago (a notification swiped away and never read) are not brought back.
      l.removeAll { at - it.third > 6 * 3600_000L }
      while (l.size > 5) l.removeAt(0)
      if (history.size > 40) history.keys.firstOrNull { it != tag }?.let { history.remove(it) }
      l.toList()
    }
    val me = Person.Builder().setName("You").setKey("me").build()
    val style = NotificationCompat.MessagingStyle(me)
    if (group) style.setConversationTitle(title).setGroupConversation(true)
    for ((p, t, w) in lines) style.addMessage(NotificationCompat.MessagingStyle.Message(t, w, p))
    b.setStyle(style)
    // The conversation's shortcut: what lets Android show it as a conversation with this picture.
    val scheme = prefs(this).getString("scheme", null) ?: return
    val chatFace = if (group) room?.let { Faces.bitmap(this, it) } else face
    val shortcutId = "chat-$chatId"
    val label = if (group) title else who.name
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("$scheme://open?bot=${Uri.encode(botId)}${if (chatId != botId) "&chat=${Uri.encode(chatId)}" else ""}")).setPackage(packageName)
    val sc = ShortcutInfoCompat.Builder(this, shortcutId)
      .setShortLabel(label.take(24).ifEmpty { "Chat" })
      .setLongLabel(label.ifEmpty { "Chat" })
      .setLongLived(true)
      .setIntent(intent)
      .apply {
        if (chatFace != null) setIcon(IconCompat.createWithBitmap(chatFace))
        if (!group) setPerson(person)
      }
      .build()
    ShortcutManagerCompat.pushDynamicShortcut(this, sc)
    b.setShortcutInfo(sc)
  }

  private fun choose(chatId: String, seq: Int, generation: Int, block: String, index: Int, label: String, tag: String, title: String): PendingIntent {
    val i = Intent(this, NotifyActionReceiver::class.java).apply {
      action = "com.yancey.cleftbackground.CHOOSE.$chatId.$seq.$index"
      putExtra("kind", "choice"); putExtra("chatId", chatId); putExtra("seq", seq); putExtra("generation", generation)
      putExtra("block", block); putExtra("index", index); putExtra("label", label); putExtra("tag", tag); putExtra("title", title)
    }
    return PendingIntent.getBroadcast(this, "$chatId:$seq:$index".hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun answer(aid: String, digest: String, decision: String, tag: String, title: String): PendingIntent {
    val i = Intent(this, NotifyActionReceiver::class.java).apply {
      action = "com.yancey.cleftbackground.ANSWER.$decision.$aid"
      putExtra("approvalId", aid); putExtra("digest", digest); putExtra("decision", decision); putExtra("tag", tag); putExtra("title", title)
    }
    return PendingIntent.getBroadcast(this, (aid + decision).hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  /** Opens the app on the bot's chat: `<scheme>://open?bot=<id>&seq=<row>[&chat=<side chat id>]`, read by App.tsx. */
  private fun openApp(botId: String?, seq: Int?, code: Int, chatId: String? = null): PendingIntent? {
    val scheme = prefs(this).getString("scheme", null)
    val intent = if (scheme != null && botId != null) {
      Intent(Intent.ACTION_VIEW, Uri.parse("$scheme://open?bot=${Uri.encode(botId)}${if (seq != null) "&seq=$seq" else ""}${if (chatId != null) "&chat=${Uri.encode(chatId)}" else ""}")).setPackage(packageName)
    } else packageManager.getLaunchIntentForPackage(packageName) ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(this, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }
}
