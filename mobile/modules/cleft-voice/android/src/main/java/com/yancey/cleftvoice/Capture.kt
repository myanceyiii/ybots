package com.yancey.cleftvoice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.media.audiofx.AudioEffect
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.max
import kotlin.math.sqrt

/**
 * The microphone, as 16 kHz mono PCM16 in 40 ms frames.
 *
 * On a call, speech is detected the way the web app does it (web/src/voice/call.ts, class Vad): an
 * energy bar over an adaptive noise floor, set higher while the bot is talking so its own voice is not
 * taken for yours. 120 ms of speech starts an utterance (with 320 ms kept from before), 800 ms of quiet
 * ends it, and less than 240 ms of speech is a noise. Each utterance is written as a WAV file.
 *
 * Dictation keeps everything (up to two minutes) until finish().
 */
class Capture(
  private val dir: File,
  private val call: Boolean,
  private val botTalking: () -> Boolean,
  private val onSpeechStart: () -> Unit,
  private val onUtterance: (String, Long) -> Unit,
  private val onError: (String) -> Unit,
) {
  companion object {
    const val RATE = 16_000
    const val FRAME = RATE * 40 / 1000 // 640 samples, 40 ms
    const val START_FRAMES = 3
    const val END_FRAMES = 20
    const val PREROLL_FRAMES = 8
    const val MIN_VOICED = 6
    const val MAX_FRAMES = 30_000 / 40
    const val DICTATE_MAX_FRAMES = 120_000 / 40
  }

  @Volatile var muted = false
    set(value) { field = value; if (value) level = 0f }
  @Volatile var level = 0f
    private set
  @Volatile private var running = false

  private var rec: AudioRecord? = null
  private var worker: Thread? = null
  private val effects = mutableListOf<AudioEffect>()

  // Speech detection (call) state, only touched on the worker thread.
  private var floor = 0.004
  private var above = 0
  private var quiet = 0
  private var voiced = 0
  private var inSpeech = false
  private var frames = ArrayList<ShortArray>()
  private val preroll = ArrayDeque<ShortArray>()
  private var dropSpeech = false

  // Dictation: every frame's samples, and its loudness (RMS 0..1) for live text (dictationLevels/Clip).
  private val all = ByteArrayOutputStream()
  private var allFrames = 0
  private val allRms = ArrayList<Double>()

  @SuppressLint("MissingPermission")
  fun start() {
    val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val source = if (call) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION
    val r = try {
      AudioRecord(source, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(min, FRAME * 2 * 8))
    } catch (e: SecurityException) {
      throw IllegalStateException("Microphone access is off for this app. Allow it in Android settings.")
    }
    if (r.state != AudioRecord.STATE_INITIALIZED) {
      r.release()
      throw IllegalStateException("Could not open the microphone.")
    }
    if (call) {
      // Most phones switch these on for the voice-communication source already; ask anyway.
      try { if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(r.audioSessionId)?.let { it.enabled = true; effects.add(it) } } catch (_: Exception) {}
      try { if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(r.audioSessionId)?.let { it.enabled = true; effects.add(it) } } catch (_: Exception) {}
      try { if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(r.audioSessionId)?.let { it.enabled = true; effects.add(it) } } catch (_: Exception) {}
    }
    r.startRecording()
    if (r.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
      r.release()
      effects.forEach { try { it.release() } catch (_: Exception) {} }
      effects.clear()
      throw IllegalStateException("Your microphone is in use by another app.")
    }
    rec = r
    running = true
    worker = Thread({ loop(r) }, "cleft-voice-mic").apply { start() }
  }

  private fun loop(r: AudioRecord) {
    val buf = ShortArray(FRAME)
    while (running) {
      var n = 0
      while (n < FRAME && running) {
        val got = r.read(buf, n, FRAME - n)
        if (got < 0) {
          if (running) onError("The microphone stopped ($got).")
          running = false
          return
        }
        n += got
      }
      if (!running) break
      frame(buf.copyOf())
    }
  }

  private fun frame(pcm: ShortArray) {
    var sum = 0.0
    var peak = 0
    for (s in pcm) {
      val v = s.toInt()
      sum += (v * v).toDouble()
      val a = if (v < 0) -v else v
      if (a > peak) peak = a
    }
    if (muted) {
      level = 0f
      if (inSpeech) { dropSpeech = true; finishUtterance() }
      above = 0
      preroll.clear()
      return
    }
    level = level * 0.6f + (peak / 32768f) * 0.4f
    val rms = sqrt(sum / pcm.size) / 32768.0
    if (!call) {
      synchronized(all) {
        if (allFrames < DICTATE_MAX_FRAMES) { all.write(toBytes(pcm)); allFrames++; allRms.add(rms) }
      }
      return
    }
    val bar = max(0.012, floor * 3) * (if (botTalking()) 2.5 else 1.0)
    if (!inSpeech) {
      preroll.addLast(pcm)
      if (preroll.size > PREROLL_FRAMES) preroll.removeFirst()
      if (rms > bar) {
        above++
        if (above >= START_FRAMES) {
          inSpeech = true
          frames = ArrayList(preroll)
          voiced = above
          quiet = 0
          onSpeechStart()
        }
      } else {
        above = 0
        floor = floor * 0.95 + minOf(rms, 0.05) * 0.05
      }
      return
    }
    frames.add(pcm)
    if (rms > bar * 0.7) { quiet = 0; voiced++ } else quiet++
    if (quiet >= END_FRAMES || frames.size >= MAX_FRAMES) finishUtterance()
  }

  private fun finishUtterance() {
    val got = frames
    val v = voiced
    val drop = dropSpeech
    inSpeech = false
    frames = ArrayList()
    above = 0
    preroll.clear()
    dropSpeech = false
    if (drop || v < MIN_VOICED) { onUtterance("", 0); return }
    val bytes = ByteArrayOutputStream(got.size * FRAME * 2)
    for (f in got) bytes.write(toBytes(f))
    val file = File(dir, "turn-${System.currentTimeMillis()}.wav")
    try {
      Wav.write(file, bytes.toByteArray(), RATE)
      onUtterance(file.absolutePath, got.size * 40L)
    } catch (e: Exception) {
      onError("Could not keep what you said (${e.message}).")
    }
  }

  /** Dictation: the loudness of each 40 ms frame from `from` on (live text, see liveDictation.ts). */
  fun levelsFrom(from: Int): DoubleArray = synchronized(all) {
    val start = from.coerceIn(0, allRms.size)
    DoubleArray(allRms.size - start) { allRms[start + it] }
  }

  /** Dictation: frames from `from` on as base64 PCM16 (16 kHz mono), for streaming to the live service. */
  fun pcmFrom(from: Int): String = synchronized(all) {
    val a = from.coerceIn(0, allFrames)
    if (a >= allFrames) return ""
    val buf = all.toByteArray()
    android.util.Base64.encodeToString(buf, a * FRAME * 2, (allFrames - a) * FRAME * 2, android.util.Base64.NO_WRAP)
  }

  /** Dictation: frames [from, to) as a WAV file (null when empty), while still listening. */
  fun clip(from: Int, to: Int): String? {
    val bytes = synchronized(all) {
      val a = from.coerceIn(0, allFrames)
      val b = to.coerceIn(a, allFrames)
      if (b <= a) return null
      val buf = all.toByteArray()
      buf.copyOfRange(a * FRAME * 2, b * FRAME * 2)
    }
    val file = File(dir, "clip-${System.nanoTime()}.wav")
    Wav.write(file, bytes, RATE)
    return file.absolutePath
  }

  /** Stop. Dictation: the WAV of everything said, or null when it was under a quarter second. */
  fun finish(): String? {
    if (!running && rec == null) return null
    running = false
    try { worker?.join(400) } catch (_: InterruptedException) {}
    worker = null
    try { rec?.stop() } catch (_: Exception) {}
    rec?.release()
    rec = null
    effects.forEach { try { it.release() } catch (_: Exception) {} }
    effects.clear()
    level = 0f
    if (call || allFrames < 7) return null
    val file = File(dir, "dictation-${System.currentTimeMillis()}.wav")
    Wav.write(file, all.toByteArray(), RATE)
    return file.absolutePath
  }

  private fun toBytes(pcm: ShortArray): ByteArray {
    val out = ByteArray(pcm.size * 2)
    for (i in pcm.indices) {
      val v = pcm[i].toInt()
      out[i * 2] = (v and 0xff).toByte()
      out[i * 2 + 1] = ((v shr 8) and 0xff).toByte()
    }
    return out
  }
}
