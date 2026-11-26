package com.yancey.cleftvoice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Plays the bot's speech (WAV files from the server, or speech arriving as it is made) one after another without gaps, on the
 * voice-communication stream so the phone's echo cancellation knows what it is playing.
 * clear() drops what is playing and queued at once (you talked over the bot).
 */
class Player(private val onPlaying: (Boolean) -> Unit) {
  /** A file's path, or a SpeechStream. */
  private val queue = LinkedBlockingQueue<Any>()
  private val lock = Object()
  @Volatile private var gen = 0
  @Volatile private var alive = true
  @Volatile var playing = false
    private set
  @Volatile var level = 0f
    private set

  private var track: AudioTrack? = null
  private var trackRate = 0
  private var trackChannels = 0
  private var written = 0L // frames written to the current track
  @Volatile private var current: SpeechStream? = null

  /**
   * False (calls): the voice-communication stream, which the echo canceller follows. True (Listen in a chat):
   * the media stream, so a reply read aloud comes out of the speaker at the media volume like any other audio.
   * Changing it drops whatever is playing; the next speech opens a track of the new kind.
   */
  @Volatile var media = false
    set(v) {
      if (field == v) return
      clear()
      synchronized(lock) {
        field = v
        try { track?.release() } catch (_: Exception) {}
        track = null
        trackRate = 0
        trackChannels = 0
      }
    }

  private val worker = Thread({ loop() }, "cleft-voice-play").apply { start() }

  fun enqueue(path: String) {
    if (!playing) setPlaying(true)
    queue.offer(path)
  }

  /** Speech still arriving: queued now (so it keeps its place), "playing" once its first samples are written. */
  fun enqueue(stream: SpeechStream) {
    queue.offer(stream)
  }

  fun clear() {
    synchronized(lock) {
      gen++
      val dropped = ArrayList<Any>()
      queue.drainTo(dropped)
      dropped.forEach { if (it is SpeechStream) it.cancel() else File(it as String).delete() }
      current?.cancel()
      track?.let { try { it.pause(); it.flush() } catch (_: Exception) {} }
    }
    level = 0f
    if (playing) setPlaying(false)
  }

  fun release() {
    alive = false
    clear()
    worker.interrupt()
    try { worker.join(500) } catch (_: InterruptedException) {}
    synchronized(lock) { track?.release(); track = null }
  }

  private fun setPlaying(p: Boolean) {
    playing = p
    try { onPlaying(p) } catch (_: Exception) {}
  }

  private fun loop() {
    while (alive) {
      val item = try { queue.poll(250, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) { null } ?: continue
      val g = gen
      if (item is SpeechStream) {
        current = item
        try { playStream(item, g) } catch (_: Exception) { /* a broken stream is skipped */ }
        current = null
        if (g != gen) item.cancel()
      } else {
        val path = item as String
        try { playFile(File(path), g) } catch (_: Exception) { /* a broken file is skipped */ }
        File(path).delete()
      }
      if (queue.isEmpty() && g == gen) {
        drain(g)
        if (queue.isEmpty() && g == gen && playing) { level = 0f; setPlaying(false) }
      }
    }
  }

  private fun trackFor(rate: Int, channels: Int): AudioTrack {
    val t = track
    if (t != null && rate == trackRate && channels == trackChannels) return t
    t?.release()
    val mask = if (channels == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
    val min = AudioTrack.getMinBufferSize(rate, mask, AudioFormat.ENCODING_PCM_16BIT)
    val made = AudioTrack.Builder()
      .setAudioAttributes(AudioAttributes.Builder().setUsage(if (media) AudioAttributes.USAGE_MEDIA else AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
      .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(mask).build())
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(max(min, rate / 5 * 2 * channels))
      .build()
    track = made
    trackRate = rate
    trackChannels = channels
    written = 0
    return made
  }

  private fun playFile(file: File, g: Int) {
    val info = Wav.read(file) ?: return
    if (info.bits != 16 || info.channels !in 1..2) return
    val t = synchronized(lock) { if (g != gen) return; trackFor(info.rate, info.channels) }
    if (t.playState != AudioTrack.PLAYSTATE_PLAYING) {
      // After a clear(): drop anything a write still in progress left behind, and count frames from there.
      if (t.playState == AudioTrack.PLAYSTATE_PAUSED) try { t.flush() } catch (_: Exception) {}
      written = t.playbackHeadPosition.toLong() and 0xffffffffL
      t.play()
    }
    RandomAccessFile(file, "r").use { f ->
      f.seek(info.dataStart)
      val buf = ByteArray(4096)
      var left = info.dataLength
      while (left > 0 && g == gen && alive) {
        val n = f.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
        if (n <= 0) break
        left -= n
        val even = n and 1.inv()
        level = rms(buf, even)
        var off = 0
        while (off < even && g == gen && alive) {
          val w = t.write(buf, off, even - off)
          if (w <= 0) break
          off += w
        }
        written += (off / (2 * info.channels)).toLong()
      }
    }
  }

  private fun start(t: AudioTrack) {
    if (t.playState != AudioTrack.PLAYSTATE_PLAYING) {
      if (t.playState == AudioTrack.PLAYSTATE_PAUSED) try { t.flush() } catch (_: Exception) {}
      written = t.playbackHeadPosition.toLong() and 0xffffffffL
      t.play()
    }
  }

  /** Write PCM16 bytes (a whole number of frames) to the track, unless cleared meanwhile. */
  private fun write(t: AudioTrack, buf: ByteArray, n: Int, channels: Int, g: Int) {
    level = rms(buf, n)
    var off = 0
    while (off < n && g == gen && alive) {
      val w = t.write(buf, off, n - off)
      if (w <= 0) break
      off += w
    }
    written += (off / (2 * channels)).toLong()
  }

  private fun playStream(s: SpeechStream, g: Int) {
    val (fmt, first) = s.readHeader() ?: return
    if (g != gen) return
    val t = synchronized(lock) { if (g != gen) return; trackFor(fmt.rate, fmt.channels) }
    val frame = 2 * fmt.channels
    var carry = ByteArray(0)
    var piece: ByteArray? = first
    while (piece != null && g == gen && alive) {
      val b = if (carry.isEmpty()) piece else carry + piece
      val n = b.size - (b.size % frame)
      carry = b.copyOfRange(n, b.size)
      if (n > 0) {
        if (!playing) setPlaying(true)
        start(t)
        write(t, b, n, fmt.channels, g)
      }
      piece = s.take()
    }
  }

  /** Wait until what was written has been heard (or something new arrives, or it was cleared). */
  private fun drain(g: Int) {
    val t = track ?: return
    val deadline = System.currentTimeMillis() + 30_000
    while (alive && g == gen && queue.isEmpty() && System.currentTimeMillis() < deadline) {
      val head = t.playbackHeadPosition.toLong() and 0xffffffffL
      if (head >= written) break
      level *= 0.85f
      try { Thread.sleep(20) } catch (_: InterruptedException) { return }
    }
  }

  private fun rms(b: ByteArray, n: Int): Float {
    if (n < 2) return 0f
    var sum = 0.0
    var i = 0
    while (i + 1 < n) {
      val v = ((b[i + 1].toInt() shl 8) or (b[i].toInt() and 0xff)).toShort().toInt()
      sum += (v * v).toDouble()
      i += 2
    }
    return minOf(1f, (sqrt(sum / (n / 2)) / 32768.0 * 4).toFloat())
  }
}
