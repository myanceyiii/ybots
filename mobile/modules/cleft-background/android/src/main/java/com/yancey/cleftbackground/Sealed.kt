package com.yancey.cleftbackground

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The notification link's sign-in (bearer token, Cloudflare Access headers) is kept sealed with an
 * AES key that lives in the Android Keystore and never leaves it, so the copy in this app's private
 * preferences is useless on its own: not readable from a backup, a copied data folder or another
 * device. (Keystore keys are not backed up, so a restored copy simply fails to open and the app asks
 * for nothing: it starts the link again with the sign-in it holds in SecureStore.)
 */
object Sealed {
  private const val ALIAS = "cleft-notify-signin"
  private const val PROVIDER = "AndroidKeyStore"

  private fun key(): SecretKey {
    val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
    (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return gen.generateKey()
  }

  fun seal(plain: String): String? = try {
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.ENCRYPT_MODE, key())
    val out = c.iv + c.doFinal(plain.toByteArray(Charsets.UTF_8))
    Base64.encodeToString(out, Base64.NO_WRAP)
  } catch (e: Exception) { null }

  fun open(sealed: String?): String? = try {
    if (sealed.isNullOrEmpty()) null else {
      val raw = Base64.decode(sealed, Base64.NO_WRAP)
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
      String(c.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
    }
  } catch (e: Exception) { null }
}
