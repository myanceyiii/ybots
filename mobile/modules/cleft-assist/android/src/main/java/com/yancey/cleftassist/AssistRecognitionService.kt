package com.yancey.cleftassist

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

/**
 * Android makes an assistant app name a speech recognizer too, and while the app is the assistant it
 * becomes the phone's default one. This one does no recognition itself: every request goes on to the
 * phone's own recognizer (Google's on a Pixel), and its answers come straight back, so voice typing
 * and voice search in other apps work as before.
 */
class AssistRecognitionService : RecognitionService() {
  private var inner: SpeechRecognizer? = null

  private fun target(): ComponentName? {
    val found = packageManager.queryIntentServices(Intent(SERVICE_INTERFACE), 0)
      .mapNotNull { it.serviceInfo }
      .filter { it.packageName != packageName }
      .map { ComponentName(it.packageName, it.name) }
    val preferred = listOf("com.google.android.as", "com.google.android.tts", "com.google.android.googlequicksearchbox")
    return preferred.firstNotNullOfOrNull { p -> found.firstOrNull { it.packageName == p } } ?: found.firstOrNull()
  }

  override fun onStartListening(recognizerIntent: Intent, listener: Callback) {
    inner?.destroy()
    inner = null
    val to = target()
    if (to == null) { safe { listener.error(SpeechRecognizer.ERROR_CLIENT) }; return }
    val r = try { SpeechRecognizer.createSpeechRecognizer(this, to) } catch (e: Exception) { null }
    if (r == null) { safe { listener.error(SpeechRecognizer.ERROR_CLIENT) }; return }
    inner = r
    r.setRecognitionListener(object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) = safe { listener.readyForSpeech(params ?: Bundle()) }
      override fun onBeginningOfSpeech() = safe { listener.beginningOfSpeech() }
      override fun onRmsChanged(rmsdB: Float) = safe { listener.rmsChanged(rmsdB) }
      override fun onBufferReceived(buffer: ByteArray?) = safe { if (buffer != null) listener.bufferReceived(buffer) }
      override fun onEndOfSpeech() = safe { listener.endOfSpeech() }
      override fun onError(error: Int) = safe { listener.error(error) }
      override fun onResults(results: Bundle?) = safe { listener.results(results ?: Bundle()) }
      override fun onPartialResults(partialResults: Bundle?) = safe { listener.partialResults(partialResults ?: Bundle()) }
      override fun onEvent(eventType: Int, params: Bundle?) {}
    })
    try { r.startListening(recognizerIntent) } catch (e: Exception) { safe { listener.error(SpeechRecognizer.ERROR_CLIENT) } }
  }

  override fun onStopListening(listener: Callback) { try { inner?.stopListening() } catch (_: Exception) {} }

  override fun onCancel(listener: Callback) { try { inner?.cancel() } catch (_: Exception) {} }

  override fun onDestroy() {
    try { inner?.destroy() } catch (_: Exception) {}
    inner = null
    super.onDestroy()
  }

  private inline fun safe(f: () -> Unit) { try { f() } catch (_: Exception) {} }
}
