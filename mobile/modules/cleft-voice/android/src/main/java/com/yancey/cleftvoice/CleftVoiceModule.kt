package com.yancey.cleftvoice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Voice on the phone, the same way the web app does it (web/src/voice): the microphone is listened to
 * here, each thing you say goes to the server as a WAV file to be transcribed, and the bot's replies
 * come back from the server's speech voice as WAV files that are played in order.
 *
 *  - Calls use Android's voice-communication path (the same one phone and video-call apps use), so the
 *    phone's own echo cancellation keeps the bot's voice from the speaker out of the microphone, and
 *    the volume keys change the call volume. A headset or Bluetooth earpiece is used when one is on.
 *  - Dictation records everything until stop() and hands back one WAV file.
 *
 * Nothing here talks to a voice service: files go only to the app's own server (fetchAudio, and the
 * app's upload of each utterance).
 */
class CleftVoiceModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("no context")

  private var capture: Capture? = null
  private var player: Player? = null
  private var routed = false
  private var savedMode = AudioManager.MODE_NORMAL
  private var focus: AudioFocusRequest? = null
  private var said = 0

  private val dir: File
    get() = File(context.cacheDir, "voice").apply { mkdirs() }

  private fun audio() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  /** Calls: communication mode, the speaker (or a headset), audio focus, and the volume keys on the call volume. */
  private fun route(on: Boolean) {
    val am = audio()
    if (on && !routed) {
      routed = true
      savedMode = am.mode
      try { am.mode = AudioManager.MODE_IN_COMMUNICATION } catch (_: Exception) {}
      if (Build.VERSION.SDK_INT >= 31) {
        val devices = am.availableCommunicationDevices
        val personal = setOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET)
        val pick = devices.firstOrNull { it.type in personal } ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
        if (pick != null) try { am.setCommunicationDevice(pick) } catch (_: Exception) {}
      } else {
        val outs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val headset = outs.any { it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        @Suppress("DEPRECATION")
        am.isSpeakerphoneOn = !headset
      }
      if (Build.VERSION.SDK_INT >= 26) {
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
          .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
          .build()
        try { am.requestAudioFocus(req); focus = req } catch (_: Exception) {}
      }
      appContext.currentActivity?.runOnUiThread { appContext.currentActivity?.volumeControlStream = AudioManager.STREAM_VOICE_CALL }
    } else if (!on && routed) {
      routed = false
      if (Build.VERSION.SDK_INT >= 31) {
        try { am.clearCommunicationDevice() } catch (_: Exception) {}
      } else {
        @Suppress("DEPRECATION")
        am.isSpeakerphoneOn = false
      }
      try { am.mode = savedMode } catch (_: Exception) {}
      if (Build.VERSION.SDK_INT >= 26) focus?.let { try { am.abandonAudioFocusRequest(it) } catch (_: Exception) {} }
      focus = null
      appContext.currentActivity?.runOnUiThread { appContext.currentActivity?.volumeControlStream = AudioManager.USE_DEFAULT_STREAM_TYPE }
    }
  }

  private fun ensurePlayer(): Player =
    player ?: Player { playing -> sendEvent("onPlayback", mapOf("playing" to playing)) }.also { player = it }

  private fun endAll() {
    capture?.finish()
    capture = null
    player?.release()
    player = null
    route(false)
  }

  override fun definition() = ModuleDefinition {
    Name("CleftVoice")
    Events("onSpeechStart", "onUtterance", "onPlayback", "onError")

    // mode "call": speech detection; each thing said arrives as onUtterance { path, ms } (a WAV file).
    // mode "dictate": everything until stop() becomes one WAV file, which stop() returns.
    Function("start") { mode: String ->
      capture?.finish()
      capture = null
      val call = mode == "call"
      // A reply being read aloud (Listen) stops when a call or dictation starts; calls play on the call stream.
      player?.media = false
      if (call) {
        // A new call starts with an empty folder of call audio.
        dir.listFiles()?.forEach { it.delete() }
        route(true)
      }
      val c = Capture(
        dir, call,
        botTalking = { player?.playing == true },
        onSpeechStart = { sendEvent("onSpeechStart", mapOf<String, Any>()) },
        onUtterance = { path, ms -> sendEvent("onUtterance", mapOf("path" to path, "ms" to ms)) },
        onError = { msg -> sendEvent("onError", mapOf("message" to msg)) },
      )
      try { c.start() } catch (e: Exception) { if (call) route(false); throw e }
      capture = c
      true
    }

    // Stop listening. Dictation: the WAV file of what was said (null when it was too short).
    Function("stop") {
      val path = capture?.finish()
      capture = null
      path
    }

    // Live dictation text: the loudness of each 40 ms frame heard since frame `from`, and a WAV of
    // frames [from, to) to send to the speech server while still listening (null when there are none).
    Function("dictationLevels") { from: Int -> capture?.levelsFrom(from) ?: DoubleArray(0) }
    Function("dictationClip") { from: Int, to: Int -> capture?.clip(from, to) }
    // Live dictation service: frames from `from` on, as base64 PCM16 16 kHz (streamed over the socket).
    Function("dictationPcm") { from: Int -> capture?.pcmFrom(from) ?: "" }

    Function("setMuted") { muted: Boolean -> capture?.muted = muted }

    // Levels 0..1 for the speaking animation: the microphone, and what is being played.
    Function("levels") {
      mapOf("mic" to (capture?.level ?: 0f).toDouble(), "out" to (player?.level ?: 0f).toDouble())
    }

    // POST `body` (JSON) to `url` and keep the audio that comes back in a file; its path.
    AsyncFunction("fetchAudio") { url: String, headers: Map<String, String>, body: String, promise: Promise ->
      val out = File(dir, "say-${System.currentTimeMillis()}-${said++}.wav")
      thread(name = "cleft-voice-fetch") {
        var conn: HttpURLConnection? = null
        try {
          conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 60_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            headers.forEach { (k, v) -> setRequestProperty(k, v) }
          }
          conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
          val code = conn.responseCode
          if (code !in 200..299) {
            val text = (conn.errorStream ?: conn.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
            val msg = try { JSONObject(text).optString("error") } catch (_: Exception) { "" }
            promise.reject("ERR_SPEECH", msg.ifBlank { "Speech unavailable ($code)" }, null)
            return@thread
          }
          conn.inputStream.use { input -> out.outputStream().use { input.copyTo(it) } }
          promise.resolve(out.absolutePath)
        } catch (e: Exception) {
          out.delete()
          promise.reject("ERR_SPEECH", "Couldn't reach the server for speech (${e.message ?: e.javaClass.simpleName}).", e)
        } finally {
          conn?.disconnect()
        }
      }
    }

    // POST `body` (JSON, with stream: true) to `url` and play the speech as it arrives, after anything
    // already queued. Resolves true once the first audio has arrived, false if it was dropped first
    // (you talked over the bot); rejects if the server could not speak.
    AsyncFunction("playStream") { url: String, headers: Map<String, String>, body: String, promise: Promise ->
      val stream = SpeechStream()
      ensurePlayer().enqueue(stream)
      thread(name = "cleft-voice-stream") {
        var conn: HttpURLConnection? = null
        var settled = false
        fun settle(ok: Boolean) { if (!settled) { settled = true; promise.resolve(ok) } }
        try {
          conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 60_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            headers.forEach { (k, v) -> setRequestProperty(k, v) }
          }
          val c = conn
          stream.onCancel = { try { c?.disconnect() } catch (_: Exception) {} }
          if (stream.cancelled) { settle(false); return@thread }
          conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
          val code = conn.responseCode
          if (code !in 200..299) {
            val text = (conn.errorStream ?: conn.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
            val msg = try { JSONObject(text).optString("error") } catch (_: Exception) { "" }
            stream.cancel()
            settled = true
            promise.reject("ERR_SPEECH", msg.ifBlank { "Speech unavailable ($code)" }, null)
            return@thread
          }
          var total = 0
          conn.inputStream.use { input ->
            val buf = ByteArray(4096)
            while (!stream.cancelled) {
              val n = input.read(buf)
              if (n < 0) break
              if (n == 0) continue
              stream.put(buf.copyOf(n))
              total += n
              if (total > 44) settle(true)
            }
          }
          stream.finish()
          settle(!stream.cancelled && total > 44)
        } catch (e: Exception) {
          val wasCancelled = stream.cancelled
          stream.cancel()
          if (wasCancelled) settle(false)
          else if (!settled) { settled = true; promise.reject("ERR_SPEECH", "Couldn't reach the server for speech (${e.message ?: e.javaClass.simpleName}).", e) }
        } finally {
          conn?.disconnect()
        }
      }
    }

    // Queue a WAV file to be played after anything already queued (the file is deleted once played).
    Function("play") { path: String -> ensurePlayer().enqueue(path) }

    // Listen (a reply read aloud in a chat) plays as media; calls play on the voice-communication stream.
    Function("setMedia") { on: Boolean -> ensurePlayer().media = on }

    // Stop playing and drop everything queued (you started talking over the bot).
    Function("clear") { player?.clear() }

    Function("isPlaying") { player?.playing == true }

    Function("discard") { path: String -> File(path).delete() }

    // Hang up: stop listening and playing, and give the phone's audio back.
    Function("end") { endAll() }

    OnDestroy { endAll() }
  }
}
