package com.yancey.cleftvoice

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** PCM16 WAV files: writing what the microphone heard, and finding the samples in what the server sends. */
object Wav {
  fun write(file: File, pcm: ByteArray, rate: Int) {
    val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    h.put("RIFF".toByteArray()); h.putInt(36 + pcm.size); h.put("WAVE".toByteArray())
    h.put("fmt ".toByteArray()); h.putInt(16); h.putShort(1); h.putShort(1)
    h.putInt(rate); h.putInt(rate * 2); h.putShort(2); h.putShort(16)
    h.put("data".toByteArray()); h.putInt(pcm.size)
    file.outputStream().use { it.write(h.array()); it.write(pcm) }
  }

  class Info(val rate: Int, val channels: Int, val bits: Int, val dataStart: Long, val dataLength: Long)

  /**
   * Where the samples are. A speech server that streams its answer may leave the data size as 0 or
   * 0xFFFFFFFF, so the data then runs to the end of the file.
   */
  fun read(file: File): Info? {
    RandomAccessFile(file, "r").use { f ->
      val len = f.length()
      if (len < 44) return null
      val four = ByteArray(4)
      f.readFully(four)
      if (String(four) != "RIFF") return null
      f.seek(8)
      f.readFully(four)
      if (String(four) != "WAVE") return null
      var pos = 12L
      var rate = 0; var channels = 0; var bits = 0
      while (pos + 8 <= len) {
        f.seek(pos)
        f.readFully(four)
        val id = String(four)
        val size = Integer.toUnsignedLong(Integer.reverseBytes(f.readInt()))
        val body = pos + 8
        if (id == "fmt ") {
          val b = ByteArray(16)
          f.readFully(b)
          val bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN)
          bb.short // format
          channels = bb.short.toInt()
          rate = bb.int
          bb.int; bb.short
          bits = bb.short.toInt()
        } else if (id == "data") {
          if (rate == 0) return null
          val dataLen = if (size == 0L || size == 0xFFFFFFFFL || body + size > len) len - body else size
          return Info(rate, channels, bits, body, dataLen)
        }
        pos = body + size + (size and 1L)
      }
      return null
    }
  }
}
