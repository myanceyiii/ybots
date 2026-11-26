package com.yancey.cleftbackground

import android.app.role.RoleManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import java.io.File
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Keeping slow work going while YBots is in the background:
 *  - watchJob: a short foreground service ("Drawing pictures for Leonard…") that asks the server about
 *    one job until it is done, then posts "Leonard's pictures are ready". Android keeps an app with a
 *    foreground service running, so the job is followed even when the person switches apps.
 *  - the battery settings: whether Android's battery optimisation is off for this app, and the system
 *    screens to change it. Only opened when the person asks (Settings > Background), never on its own.
 */
class CleftBackgroundModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("no context")

  private fun launch(intent: Intent): Boolean = try {
    context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true
  } catch (e: Exception) { false }

  override fun definition() = ModuleDefinition {
    Name("CleftBackground")

    // Share to the app from another app (text or a link). The words wait in Shared until the app asks.
    OnNewIntent { intent -> Shared.keep(intent) }
    Function("takeShared") {
      appContext.currentActivity?.intent?.let { Shared.keep(it) }
      Shared.take()
    }

    // The phone's assistant gesture opened the app (this app is the default digital assistant). Read once.
    Function("takeAssist") {
      appContext.currentActivity?.intent?.let { Shared.keep(it) }
      Shared.takeAssist()
    }
    // Whether this app is the phone's default digital assistant. Android 10+ can say; older phones answer null.
    Function("assistantHeld") {
      if (Build.VERSION.SDK_INT < 29) return@Function null
      try {
        val rm = context.getSystemService(RoleManager::class.java)
        if (rm == null || !rm.isRoleAvailable(RoleManager.ROLE_ASSISTANT)) null else rm.isRoleHeld(RoleManager.ROLE_ASSISTANT)
      } catch (e: Exception) { null }
    }
    // Android's own "Default digital assistant app" screen. The assistant role can't be asked for with a
    // pop-up (apps may not request it), so the person picks the app there.
    Function("openAssistantSettings") {
      launch(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS))
        || launch(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
        || launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
    }

    // Phone timers and alarms (PhoneActions.kt): Android lets an app start the Clock app from the background
    // only with "Display over other apps"; without it each one waits for a tap on a notification.
    Function("canStartInBackground") { Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(context) }
    Function("openOverlaySettings") {
      Build.VERSION.SDK_INT >= 23 && (launch(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}")))
        || launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))))
    }

    Function("status") {
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      mapOf(
        "ignoringBatteryOptimizations" to (Build.VERSION.SDK_INT < 23 || pm.isIgnoringBatteryOptimizations(context.packageName)),
        "notificationsAllowed" to NotificationManagerCompat.from(context).areNotificationsEnabled(),
        "manufacturer" to Build.MANUFACTURER.orEmpty(),
        "sdk" to Build.VERSION.SDK_INT,
      )
    }

    // The system's own "Let app always run in background?" question for this app.
    Function("requestBatteryExemption") {
      if (Build.VERSION.SDK_INT < 23) return@Function true
      launch(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")))
        || launch(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }

    // The list of apps and their battery optimisation (to turn it back on).
    Function("openBatterySettings") {
      launch(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        || launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
    }

    // This app's page in Settings (Battery: Unrestricted on Samsung and Pixel; Notifications).
    Function("openAppSettings") {
      launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
    }

    // Download: put a copy of a file the app already fetched (in its own cache) into the phone's Downloads
    // folder, where the Files app and every other app can find it. Android 10+ files it through MediaStore,
    // which needs no storage permission; Android renames it "name (1).md" when the name is taken.
    // The type comes from Android's own list for the extension, so Android never adds a second extension.
    AsyncFunction("saveToDownloads") { src: String, name: String ->
      if (Build.VERSION.SDK_INT < 29) throw IllegalStateException("This needs Android 10 or later.")
      val from = File(Uri.parse(src).path ?: src)
      if (!from.isFile) throw IllegalStateException("The download did not arrive.")
      val ext = name.substringAfterLast('.', "").lowercase()
      val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
      val resolver = context.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(MediaStore.MediaColumns.MIME_TYPE, mime)
        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IllegalStateException("Android would not make the file in Downloads.")
      try {
        (resolver.openOutputStream(uri) ?: throw IllegalStateException("Android would not open the file in Downloads."))
          .use { out -> from.inputStream().use { it.copyTo(out) } }
        resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
      } catch (e: Exception) {
        try { resolver.delete(uri, null, null) } catch (_: Exception) {}
        throw e
      }
      var saved = name
      resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) saved = c.getString(0) ?: name
      }
      mapOf("uri" to uri.toString(), "name" to saved, "mime" to mime)
    }

    // Open a file saved by saveToDownloads in the app the person picks (Android's "Open with").
    Function("openDownload") { uri: String, mime: String ->
      val view = Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(uri), mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      launch(Intent.createChooser(view, null))
    }

    // Follow one job on the server while the app is in the background. `url` answers JSON with a
    // `state` of making, done or failed; `headers` are sent with each ask (sign-in, Cloudflare Access).
    Function("watchJob") { opts: Map<String, Any?> ->
      val intent = Intent(context, JobWatchService::class.java).apply {
        action = JobWatchService.ACTION_WATCH
        putExtra("id", opts["id"] as? String ?: return@Function false)
        putExtra("url", opts["url"] as? String ?: return@Function false)
        putExtra("working", opts["working"] as? String ?: "Working…")
        putExtra("doneTitle", opts["doneTitle"] as? String ?: "Done")
        putExtra("doneBody", opts["doneBody"] as? String ?: "")
        putExtra("failTitle", opts["failTitle"] as? String ?: "It did not work")
        val h = (opts["headers"] as? Map<*, *>) ?: emptyMap<String, String>()
        putExtra("headerNames", h.keys.map { it.toString() }.toTypedArray())
        putExtra("headerValues", h.values.map { it.toString() }.toTypedArray())
      }
      try { ContextCompat.startForegroundService(context, intent); true } catch (e: Exception) { false }
    }

    // The notification link (NotifyService). `server` and `headers` are the app's own sign-in; they are kept
    // in this app's private storage so the link can open again after a restart, without the app open.
    Function("notifyStart") { opts: Map<String, Any?> ->
      val server = opts["server"] as? String ?: return@Function false
      val h = (opts["headers"] as? Map<*, *>) ?: emptyMap<String, String>()
      val p = NotifyService.prefs(context)
      val profile = opts["profile"] as? String ?: "main"
      // Who is signed in (server, profile and the account the app names). Another account starts with
      // a fresh cursor and none of the previous account's notifications left on screen.
      val account = "$server|$profile|${opts["account"] as? String ?: ""}"
      val sameAccount = p.getString("account", null) == account
      val headerText = h.entries.joinToString("\n") { "${it.key}\n${it.value}" }
      val sealed = Sealed.seal(headerText) ?: return@Function false
      val sameSignIn = sameAccount && Sealed.open(p.getString("headersSealed", null)) == headerText
      if (!sameAccount) NotificationManagerCompat.from(context).cancelAll()
      val e = p.edit()
      if (!sameAccount) e.putLong("lastId", 0)
      e.putBoolean("enabled", true)
        .putString("server", server)
        .putString("profile", profile)
        .putString("account", account)
        .putString("scheme", opts["scheme"] as? String)
        .putString("appName", opts["appName"] as? String ?: "YBots")
        .remove("headers") // the old plain copy, from before the sign-in was sealed
        .putString("headersSealed", sealed)
        .putBoolean("signedOut", false)
        .commit()
      NotifyService.channels(context)
      NotifyService.start(context, if (sameSignIn) NotifyService.ACTION_START else NotifyService.ACTION_RESTART)
    }

    // Signed out, or turned off in Settings: close the link and forget the sign-in.
    Function("notifyStop") {
      NotifyService.prefs(context).edit().clear().commit()
      // Signed out: nothing from that account stays on screen.
      NotificationManagerCompat.from(context).cancelAll()
      try { context.startService(Intent(context, NotifyService::class.java).setAction(NotifyService.ACTION_STOP)) } catch (_: Exception) {}
      true
    }

    // What is on screen: a message for the chat that is open while the app is in front is not shown again.
    Function("notifyFocus") { visible: Boolean, openChat: String? ->
      NotifyService.prefs(context).edit().putBoolean("visible", visible).putString("openChat", openChat).apply()
      true
    }

    Function("notifyStatus") {
      val p = NotifyService.prefs(context)
      mapOf("enabled" to p.getBoolean("enabled", false), "signedOut" to p.getBoolean("signedOut", false), "lastId" to p.getLong("lastId", 0).toDouble())
    }

    // Take down notifications the app has dealt with (a chat opened, a card answered in the app).
    Function("notifyCancel") { tags: List<String> ->
      val nm = NotificationManagerCompat.from(context)
      tags.forEach { nm.cancel(it, 0) }
      true
    }

    // Android's own settings for one channel (messages, approvals, jobs, link), or for all of this app's notifications.
    Function("openNotificationSettings") { channel: String? ->
      NotifyService.channels(context)
      val id = when (channel) { null, "" -> null; "link" -> NotifyService.CH_LINK; else -> NotifyService.channelFor(channel) }
      if (Build.VERSION.SDK_INT >= 26) {
        val i = if (id != null) Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_CHANNEL_ID, id)
                else Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        launch(i.putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
      } else launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
    }

    // The app is in front again and follows the job itself.
    Function("stopWatch") { id: String ->
      val intent = Intent(context, JobWatchService::class.java).apply { action = JobWatchService.ACTION_STOP; putExtra("id", id) }
      try { context.startService(intent); true } catch (e: Exception) { false }
    }
  }
}
