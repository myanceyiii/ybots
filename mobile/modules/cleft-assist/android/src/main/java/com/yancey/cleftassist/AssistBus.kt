package com.yancey.cleftassist

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import java.io.File
import java.io.FileOutputStream
import java.lang.ref.WeakReference

/**
 * What one press of the assistant gesture has to hand: the session Android opened, the card's screen,
 * and the screenshot Android took of the app underneath (only if the person allows screenshots for the
 * assistant in Android's settings). The screenshot stays on the phone, in this app's cache, until the
 * person taps Share screen on the card; it is deleted when the card closes or the gesture is used again.
 */
object AssistBus {
  /** Bumped every time the card is asked for. */
  @Volatile var invocation = 0
    private set
  /** none: no screenshot was asked for (Android's "Use screenshot" is off, or the card was opened another way).
   *  waiting: Android is taking it. ready: `screenshot` holds it. blocked: the app on screen does not allow it. */
  @Volatile var screen = "none"
    private set
  @Volatile var screenshot: String? = null
    private set
  /** The web page on screen, when the app underneath said (a browser usually does). */
  @Volatile var pageUrl: String? = null
    private set
  /** The card is opening another screen of ours (the camera, the photo picker): it is not being left. */
  @Volatile var keepOpen = false

  private var session: WeakReference<AssistSession>? = null
  private var activity: WeakReference<Activity>? = null
  private var sessionInvocation = -1
  var listener: ((String, Map<String, Any?>) -> Unit)? = null

  private fun dir(ctx: Context) = File(ctx.cacheDir, "assist").apply { mkdirs() }

  /** A new press of the gesture (from the session). Throws away the last one's screenshot. */
  @Synchronized fun begin(ctx: Context, s: AssistSession?, wantsScreenshot: Boolean): Int {
    invocation += 1
    dir(ctx).listFiles()?.forEach { it.delete() }
    screenshot = null
    pageUrl = null
    screen = if (wantsScreenshot) "waiting" else "none"
    session = s?.let { WeakReference(it) }
    sessionInvocation = if (s != null) invocation else -1
    return invocation
  }

  @Synchronized fun gotScreenshot(ctx: Context, inv: Int, bmp: Bitmap?) {
    if (inv != invocation) return
    if (bmp == null) { screen = "blocked"; tellScreen(); return }
    try {
      // Big enough to read, small enough to send quickly.
      val longest = maxOf(bmp.width, bmp.height)
      val scaled = if (longest > 1600) {
        val f = 1600f / longest
        Bitmap.createScaledBitmap(bmp, (bmp.width * f).toInt(), (bmp.height * f).toInt(), true)
      } else bmp
      val f = File(dir(ctx), "screen-$inv.jpg")
      FileOutputStream(f).use { scaled.compress(Bitmap.CompressFormat.JPEG, 85, it) }
      screenshot = f.absolutePath
      screen = "ready"
    } catch (e: Exception) {
      screen = "blocked"
    }
    tellScreen()
  }

  @Synchronized fun gotPage(inv: Int, uri: Uri?) {
    if (inv != invocation || uri == null) return
    val s = uri.toString()
    if (s.startsWith("http://") || s.startsWith("https://")) { pageUrl = s; tellScreen() }
  }

  /** The person took the screenshot off the card (or the card closed): delete it. */
  @Synchronized fun dropScreenshot() {
    screenshot?.let { File(it).delete() }
    screenshot = null
    if (screen == "ready") screen = "dropped"
    tellScreen()
  }

  /** The card's screen opened (or was opened again). Opened without the session (the plain assist intent): a new press. */
  @Synchronized fun attach(a: Activity, fromSession: Boolean): Int {
    if (!fromSession) begin(a.applicationContext, null, false)
    activity = WeakReference(a)
    keepOpen = false
    listener?.invoke("onInvoke", mapOf("invocation" to invocation))
    return invocation
  }

  /** The card's screen is gone. Only ends the session if no newer press has started since. */
  @Synchronized fun detach(a: Activity, inv: Int) {
    if (activity?.get() === a) activity = null
    if (inv == invocation) {
      dropScreenshotQuietly()
      if (sessionInvocation == inv) {
        try { session?.get()?.finish() } catch (_: Exception) {}
        session = null
      }
    }
  }

  fun close() {
    val a = activity?.get()
    if (a != null) a.runOnUiThread { a.finish() } else try { session?.get()?.finish() } catch (_: Exception) {}
  }

  fun currentActivity(): Activity? = activity?.get()

  private fun dropScreenshotQuietly() {
    screenshot?.let { File(it).delete() }
    screenshot = null
  }

  fun state(): Map<String, Any?> = mapOf(
    "invocation" to invocation,
    "screen" to screen,
    "screenshot" to screenshot?.let { "file://$it" },
    "pageUrl" to pageUrl,
  )

  private fun tellScreen() { listener?.invoke("onScreen", state()) }
}
