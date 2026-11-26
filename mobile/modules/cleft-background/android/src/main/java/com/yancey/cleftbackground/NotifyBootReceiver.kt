package com.yancey.cleftbackground

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** After the phone restarts (or the app is updated), open the notification link again if it was on. */
class NotifyBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    if (NotifyService.prefs(context).getBoolean("enabled", false)) NotifyService.start(context)
  }
}
