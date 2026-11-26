package com.yancey.cleftbackground

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.util.LruCache
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Bots' faces for notifications: the bot's own picture, so a notice from Leonard shows Leonard.
 *
 * A notice carries `sender` (and `room` for a group) as { id, name, face, color }. `face` is the server's
 * face-centred crop, and its address has the bot's updated_at in it, so when the bot gets a new look the
 * address changes and the new face is fetched; the old file for that bot is deleted then. Faces are
 * fetched with the app's own sign-in headers, drawn round, and kept in the app's cache folder and in
 * memory. A bot with no picture, or one that does not load, gets its initial on its colour.
 */
object Faces {
  const val SIZE = 192
  private val memory = LruCache<String, Bitmap>(24)

  data class Face(val id: String, val name: String, val url: String?, val color: Int)

  fun parse(o: JSONObject?): Face? {
    if (o == null) return null
    val id = o.optString("id").ifEmpty { return null }
    val color = try { Color.parseColor(o.optString("color", "#3B6FD8")) } catch (_: Exception) { Color.parseColor("#3B6FD8") }
    val url = if (o.isNull("face")) null else o.optString("face").ifEmpty { null }
    return Face(id, o.optString("name", "?"), url, color)
  }

  /** The round face to show. Blocks on a first fetch (at most a few seconds); call off the main thread. */
  fun bitmap(c: Context, f: Face): Bitmap {
    val url = f.url ?: return initial(f)
    val key = "${safe(f.id)}-${sha1(url)}"
    memory.get(key)?.let { return it }
    val dir = File(c.cacheDir, "notify-faces").apply { mkdirs() }
    val file = File(dir, "$key.png")
    if (file.exists()) {
      BitmapFactory.decodeFile(file.path)?.let { memory.put(key, it); return it }
    }
    val fetched = fetch(c, url) ?: return initial(f) // not remembered: the next notice tries again
    val round = round(fetched)
    try {
      // A new look: the old face of this bot goes, so the cache never shows it again.
      dir.listFiles()?.forEach { if (it.name.startsWith("${safe(f.id)}-") && it.name != file.name) it.delete() }
      file.outputStream().use { round.compress(Bitmap.CompressFormat.PNG, 100, it) }
    } catch (_: Exception) {}
    memory.put(key, round)
    return round
  }

  private fun fetch(c: Context, path: String): Bitmap? {
    val server = NotifyService.prefs(c).getString("server", null) ?: return null
    val full = if (path.startsWith("http")) path else server.trimEnd('/') + path
    // Only ever our own server: the sign-in headers go nowhere else.
    if (!full.startsWith(server.trimEnd('/') + "/")) return null
    return try {
      val conn = URL(full).openConnection() as HttpURLConnection
      conn.connectTimeout = 5_000
      conn.readTimeout = 8_000
      NotifyService.headers(c).forEach { (k, v) -> conn.setRequestProperty(k, v) }
      try {
        if (conn.responseCode != 200) return null
        val bytes = conn.inputStream.use { it.readBytes() }
        // Decode small: the picture can be large, the notification needs 192 px.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= SIZE) sample *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
      } finally { conn.disconnect() }
    } catch (_: Exception) { null }
  }

  /** The middle square of the picture (the server already centred it on the face), drawn as a circle. */
  private fun round(src: Bitmap): Bitmap {
    val side = minOf(src.width, src.height)
    val out = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val square = Bitmap.createBitmap(src, (src.width - side) / 2, (src.height - side) / 2, side, side)
    val scaled = Bitmap.createScaledBitmap(square, SIZE, SIZE, true)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { shader = BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP) }
    canvas.drawOval(RectF(0f, 0f, SIZE.toFloat(), SIZE.toFloat()), paint)
    return out
  }

  /** No picture: the bot's initial, white on its colour. */
  fun initial(f: Face): Bitmap {
    val key = "initial:${f.name}:${f.color}"
    memory.get(key)?.let { return it }
    val out = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    canvas.drawOval(RectF(0f, 0f, SIZE.toFloat(), SIZE.toFloat()), Paint(Paint.ANTI_ALIAS_FLAG).apply { color = f.color })
    val text = (f.name.trim().firstOrNull() ?: '?').uppercase()
    val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE; textSize = SIZE * 0.5f; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD); textAlign = Paint.Align.CENTER
    }
    val r = Rect(); p.getTextBounds(text, 0, text.length, r)
    canvas.drawText(text, SIZE / 2f, SIZE / 2f + r.height() / 2f, p)
    memory.put(key, out)
    return out
  }

  private fun safe(s: String) = s.replace(Regex("[^A-Za-z0-9_-]"), "_").take(60)

  private fun sha1(s: String): String =
    MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).take(8).joinToString("") { "%02x".format(it) }
}
