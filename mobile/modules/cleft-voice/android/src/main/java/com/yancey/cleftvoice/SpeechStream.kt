package com.yancey.cleftvoice

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * One sentence of the bot's speech arriving from the server as it is made (a WAV whose header says
 * "length unknown", then the samples in pieces). The fetch thread put()s pieces; the player takes
 * them, so the first words play while the rest of the sentence is still being made.
 */
class SpeechStream {
  private val pieces = LinkedBlockingQueue<ByteArray>()
  @Volatile var done = false
    private set
  @Volatile var cancelled = false
    private set
  /** Called once when the fetch is cut off by cancel() (closes the connection). */
  @Volatile var onCancel: (() -> Unit)? = null

  fun put(b: ByteArray) { if (!cancelled && b.isNotEmpty()) pieces.offer(b) }
  fun finish() { done = true }
  fun cancel() {
    if (cancelled) return
    cancelled = true
    done = true
    pieces.clear()
    try { onCancel?.invoke() } catch (_: Exception) {}
  }

  /** The next piece, or null once the stream is over (or after waiting a while with nothing new). */
  fun take(): ByteArray? {
    while (!cancelled) {
      val b = pieces.poll(100, TimeUnit.MILLISECONDS)
      if (b != null) return b
      if (done && pieces.isEmpty()) return null
    }
    return null
  }

  class Format(val rate: Int, val channels: Int)

  /**
   * Read the WAV header off the front of the stream: the format and whatever samples came with it.
   * Null if it is not 16-bit PCM (or ended first).
   */
  fun readHeader(): Pair<Format, ByteArray>? {
    val head = ByteArrayOutputStream()
    while (true) {
      val b = take() ?: return null
      head.write(b)
      val bytes = head.toByteArray()
      when (val r = parse(bytes)) {
        null -> continue
        is Format -> return r to bytes.copyOfRange(dataStart, bytes.size)
        else -> return null
      }
    }
  }

  private var dataStart = 0

  /** Format when the header is complete, null for "need more bytes", false when it is not 16-bit PCM. */
  private fun parse(b: ByteArray): Any? {
    if (b.size < 12) return null
    if (String(b, 0, 4) != "RIFF" || String(b, 8, 4) != "WAVE") return false
    val bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN)
    var pos = 12
    var fmt: Format? = null
    while (pos + 8 <= b.size) {
      val id = String(b, pos, 4)
      val size = Integer.toUnsignedLong(bb.getInt(pos + 4))
      if (id == "data") {
        dataStart = pos + 8
        return fmt ?: false
      }
      if (pos + 8 + size > b.size) return null
      if (id == "fmt ") {
        val format = bb.getShort(pos + 8).toInt()
        val channels = bb.getShort(pos + 10).toInt()
        val rate = bb.getInt(pos + 12)
        val bits = bb.getShort(pos + 22).toInt()
        if (format != 1 || bits != 16 || channels !in 1..2) return false
        fmt = Format(rate, channels)
      }
      pos += 8 + size.toInt() + (size and 1L).toInt()
    }
    return null
  }
}
