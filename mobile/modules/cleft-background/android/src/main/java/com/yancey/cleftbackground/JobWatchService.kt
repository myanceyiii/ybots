package com.yancey.cleftbackground

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * A foreground service that follows slow jobs on the YBots server while the app is in the
 * background, and posts a notification when each one is done. It only reads (GET); it never answers
 * an approval or changes anything. It stops itself when no job is left, and gives up on a job after
 * 20 minutes.
 */
class JobWatchService : Service() {
  companion object {
    const val ACTION_WATCH = "com.yancey.cleftbackground.WATCH"
    const val ACTION_STOP = "com.yancey.cleftbackground.STOP"
    private const val CHANNEL_WORKING = "cleft-working"
    private const val CHANNEL_DONE = "cleft-done"
    private const val ONGOING_ID = 7301
    private const val POLL_MS = 4000L
    private const val GIVE_UP_MS = 20 * 60_000L
  }

  private class Job(val id: String, val url: String, val headers: Map<String, String>, val working: String,
                    val doneTitle: String, val doneBody: String, val failTitle: String, val started: Long = System.currentTimeMillis())

  private val jobs = ConcurrentHashMap<String, Job>()
  private val main = Handler(Looper.getMainLooper())
  private val pool = Executors.newSingleThreadExecutor()
  private var polling = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    channels()
    // Every start must be answered with startForeground, even a stop, or Android ends the app.
    goForeground()
    when (intent?.action) {
      ACTION_WATCH -> {
        val id = intent.getStringExtra("id")
        val url = intent.getStringExtra("url")
        if (id != null && url != null) {
          val names = intent.getStringArrayExtra("headerNames") ?: emptyArray()
          val values = intent.getStringArrayExtra("headerValues") ?: emptyArray()
          jobs[id] = Job(id, url, names.zip(values).toMap(), intent.getStringExtra("working") ?: "Working…",
            intent.getStringExtra("doneTitle") ?: "Done", intent.getStringExtra("doneBody") ?: "",
            intent.getStringExtra("failTitle") ?: "It did not work")
          goForeground()
        }
      }
      ACTION_STOP -> intent.getStringExtra("id")?.let { jobs.remove(it) }
    }
    if (jobs.isEmpty()) { finish(); return START_NOT_STICKY }
    if (!polling) { polling = true; main.postDelayed(::tick, POLL_MS) }
    return START_NOT_STICKY
  }

  // Android 15+: a dataSync service that ran too long is told to stop.
  override fun onTimeout(startId: Int) { jobs.clear(); finish() }
  override fun onTimeout(startId: Int, fgsType: Int) { jobs.clear(); finish() }

  override fun onDestroy() { main.removeCallbacksAndMessages(null); pool.shutdownNow(); super.onDestroy() }

  private fun tick() {
    if (jobs.isEmpty()) { finish(); return }
    val now = System.currentTimeMillis()
    val todo = jobs.values.toList()
    pool.execute {
      for (job in todo) {
        val state = if (now - job.started > GIVE_UP_MS) "gone" else ask(job)
        if (state == "making" || state == null) continue
        if (jobs.remove(job.id) == null) continue
        if (state == "done") post(job.id, job.doneTitle, job.doneBody)
        else if (state == "failed") post(job.id, job.failTitle, "Open YBots to try again.")
      }
      main.post { if (jobs.isEmpty()) finish() else { goForeground(); main.postDelayed(::tick, POLL_MS) } }
    }
  }

  /** The job's state, or null when the server could not be reached (asked again next time). A 404 means it is gone. */
  private fun ask(job: Job): String? = try {
    val c = URL(job.url).openConnection() as HttpURLConnection
    c.connectTimeout = 15_000; c.readTimeout = 20_000
    c.setRequestProperty("accept", "application/json")
    job.headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
    try {
      when (c.responseCode) {
        200 -> JSONObject(c.inputStream.bufferedReader().use { it.readText() }).optString("state", "making")
        404 -> "failed"
        else -> null
      }
    } finally { c.disconnect() }
  } catch (e: Exception) { null }

  private fun openApp(): PendingIntent? {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun channels() {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(NotificationChannel(CHANNEL_WORKING, "Working in the background", NotificationManager.IMPORTANCE_LOW).apply {
      description = "Shown while YBots follows slow work, such as drawing pictures."
    })
    nm.createNotificationChannel(NotificationChannel(CHANNEL_DONE, "Finished work", NotificationManager.IMPORTANCE_DEFAULT).apply {
      description = "Says when slow work, such as drawing pictures, is done."
    })
  }

  private fun ongoing(): Notification {
    val text = jobs.values.firstOrNull()?.working ?: "Finishing up…"
    return NotificationCompat.Builder(this, CHANNEL_WORKING)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(text)
      .setContentText("You can leave the app. You'll get a note when it's done.")
      .setOngoing(true)
      .setProgress(0, 0, true)
      .setContentIntent(openApp())
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }

  private fun goForeground() {
    try {
      ServiceCompat.startForeground(this, ONGOING_ID, ongoing(),
        if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0)
    } catch (e: Exception) {
      // Not allowed to start now (for example Android's daily limit for this kind of work): stop quietly.
      jobs.clear(); finish()
    }
  }

  private fun post(id: String, title: String, body: String) {
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
    val n = NotificationCompat.Builder(this, CHANNEL_DONE)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(title)
      .setContentText(body)
      .setAutoCancel(true)
      .setContentIntent(openApp())
      .build()
    try { NotificationManagerCompat.from(this).notify(id.hashCode(), n) } catch (e: SecurityException) { /* permission taken back */ }
  }

  private fun finish() {
    main.removeCallbacksAndMessages(null)
    polling = false
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }
}
