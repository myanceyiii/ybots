package com.yancey.cleftassist

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.app.assist.AssistContent
import android.app.assist.AssistStructure
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService

/**
 * Android's assistant service. It does nothing by itself: each press of the assistant gesture opens a
 * session (AssistSession), which shows the card (AssistActivity) over the app on screen.
 */
class AssistService : VoiceInteractionService()

class AssistSessionService : VoiceInteractionSessionService() {
  override fun onNewSession(args: Bundle?): VoiceInteractionSession = AssistSession(this)
}

/**
 * One press of the gesture. Android's own session window is turned off: the card is our own screen,
 * opened with startAssistantActivity, which Android shows above the app the person was using
 * (developer.android.com/reference/android/service/voice/VoiceInteractionSession#startAssistantActivity).
 * Android then hands over a screenshot of that app if the person allows it; it is kept on the phone
 * until they choose to share it (AssistBus).
 */
class AssistSession(context: Context) : VoiceInteractionSession(context) {
  private var inv = 0

  override fun onPrepareShow(args: Bundle?, showFlags: Int) {
    super.onPrepareShow(args, showFlags)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) setUiEnabled(false)
  }

  override fun onShow(args: Bundle?, showFlags: Int) {
    super.onShow(args, showFlags)
    inv = AssistBus.begin(context, this, (showFlags and SHOW_WITH_SCREENSHOT) != 0)
    val intent = Intent(context, AssistActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
      .putExtra(AssistActivity.EXTRA_FROM_SESSION, true)
    try {
      startAssistantActivity(intent)
    } catch (e: Exception) {
      try { context.startActivity(intent) } catch (_: Exception) { finish() }
    }
  }

  override fun onHandleScreenshot(screenshot: Bitmap?) {
    AssistBus.gotScreenshot(context, inv, screenshot)
  }

  // Only the page address is kept (a browser says which page is open); the screen's text is not read.
  @Deprecated("Android 10+ calls this through onHandleAssist(AssistState) for the app in front.")
  override fun onHandleAssist(data: Bundle?, structure: AssistStructure?, content: AssistContent?) {
    AssistBus.gotPage(inv, content?.webUri)
  }
}
