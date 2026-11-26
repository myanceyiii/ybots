package com.yancey.cleftassist

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * The assistant card: a see-through screen over whatever app is open, drawing the `assist` React Native
 * component (src/assist/AssistCard.tsx) with the same app code as the main screen. Leaving it (Home, or
 * switching app) closes it, as other assistants do, unless it opened the camera or the photo picker.
 */
class AssistActivity : ReactActivity() {
  companion object { const val EXTRA_FROM_SESSION = "com.yancey.cleftassist.FROM_SESSION" }

  private var inv = 0

  override fun getMainComponentName(): String = "assist"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    inv = AssistBus.attach(this, intent?.getBooleanExtra(EXTRA_FROM_SESSION, false) == true)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    inv = AssistBus.attach(this, intent.getBooleanExtra(EXTRA_FROM_SESSION, false))
  }

  override fun onStop() {
    super.onStop()
    if (!isChangingConfigurations && !isFinishing && !AssistBus.keepOpen) finish()
  }

  override fun onDestroy() {
    AssistBus.detach(this, inv)
    super.onDestroy()
  }
}
