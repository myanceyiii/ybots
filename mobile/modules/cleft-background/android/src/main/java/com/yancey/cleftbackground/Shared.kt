package com.yancey.cleftbackground

import android.content.Intent

/**
 * Words another app shared to this one (Android's Share sheet, ACTION_SEND with text/plain). The app
 * asks for them when it opens or comes to the front (CleftBackgroundModule.takeShared) and puts them in a
 * chat's message box. Nothing is sent from here. The text is taken off the intent once read, so the same
 * share is never handed over twice (an activity that is rebuilt keeps its launch intent).
 */
internal object Shared {
  @Volatile private var text: String? = null
  @Volatile private var assist = false

  fun keep(intent: Intent) {
    // The phone's assistant gesture (hold the power or home button, or swipe from a bottom corner) when this
    // app is the default digital assistant. Marked once, then the action is changed so it is not seen again.
    if (intent.action == Intent.ACTION_ASSIST) {
      assist = true
      intent.action = Intent.ACTION_MAIN
      return
    }
    if (intent.action != Intent.ACTION_SEND) return
    val body = (intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: "").trim()
    val subject = (intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: "").trim()
    intent.removeExtra(Intent.EXTRA_TEXT)
    intent.removeExtra(Intent.EXTRA_SUBJECT)
    val both = if (subject.isNotEmpty() && !body.contains(subject)) (subject + "\n" + body).trim() else body
    if (both.isNotEmpty()) text = both.take(8000)
  }

  fun takeAssist(): Boolean {
    val a = assist
    assist = false
    return a
  }

  fun take(): String? {
    val t = text
    text = null
    return t
  }
}
