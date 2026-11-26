package com.yancey.cleftassist

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** The assistant card's link to Android (AssistBus): its screenshot, closing it, and going on in the app. */
class CleftAssistModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CleftAssist")
    Events("onScreen", "onInvoke")

    OnCreate { AssistBus.listener = { name, body -> try { sendEvent(name, body) } catch (_: Exception) {} } }
    OnDestroy { AssistBus.listener = null }

    Function("state") { AssistBus.state() }

    /** The person took the screenshot off the card: delete it. */
    Function("dropScreenshot") { AssistBus.dropScreenshot() }

    /** While the card opens the camera or the photo picker it must not close itself. */
    Function("keepOpen") { on: Boolean -> AssistBus.keepOpen = on }

    Function("close") { AssistBus.close() }

    /** Opens the app itself on a link (src/quick.ts), then closes the card. */
    Function("openApp") { url: String ->
      val ctx = appContext.reactContext ?: return@Function false
      val i = Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(ctx.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try { ctx.startActivity(i) } catch (e: Exception) {
        ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let { ctx.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
      }
      AssistBus.close()
      true
    }

    /** Android's assistant settings (where "Use screenshot" is). */
    Function("openSettings") {
      val ctx = appContext.reactContext ?: return@Function false
      for (action in listOf(Settings.ACTION_VOICE_INPUT_SETTINGS, Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)) {
        try { ctx.startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); AssistBus.close(); return@Function true } catch (_: Exception) {}
      }
      false
    }

    /** Whether the gesture reaches this app's card (Android 10+ can say), and whether through the service. */
    Function("serviceActive") {
      val ctx = appContext.reactContext ?: return@Function null
      val cur = try { Settings.Secure.getString(ctx.contentResolver, "voice_interaction_service") } catch (_: Exception) { null }
      if (cur.isNullOrEmpty()) return@Function false
      ComponentName.unflattenFromString(cur)?.packageName == ctx.packageName
    }
  }
}
