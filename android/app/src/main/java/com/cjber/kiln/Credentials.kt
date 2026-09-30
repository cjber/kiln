package com.cjber.kiln

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

/** Host credentials stay encrypted with a key that never leaves Android Keystore. */
class Credentials(context: Context) {
    private val preferences = context.getSharedPreferences("hosts", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("kiln-hosts", null) as? SecretKey)?.let {
            return it
        }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                    "kiln-hosts",
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return generator.generateKey()
    }

    fun read(): List<Host> {
        val stored = preferences.getString("encrypted", null) ?: return emptyList()
        val fields = stored.split(':')
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            GCMParameterSpec(128, Base64.decode(fields[0], Base64.NO_WRAP)),
        )
        val array =
            JSONArray(
                String(cipher.doFinal(Base64.decode(fields[1], Base64.NO_WRAP)), Charsets.UTF_8)
            )
        return (0 until array.length()).map { i ->
            array.getJSONObject(i).let {
                val token = it.getString("token")
                require(token.matches(Regex("[A-Za-z0-9_-]{43}")))
                Host(httpsOrigin(it.getString("origin")), it.getString("name"), token)
            }
        }
    }

    fun write(hosts: List<Host>) {
        val array = JSONArray()
        hosts.forEach {
            array.put(
                JSONObject().put("origin", it.origin).put("name", it.name).put("token", it.token)
            )
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ciphertext = cipher.doFinal(array.toString().toByteArray(Charsets.UTF_8))
        check(
            preferences
                .edit()
                .putString(
                    "encrypted",
                    Base64.encodeToString(cipher.iv, Base64.NO_WRAP) +
                        ":" +
                        Base64.encodeToString(ciphertext, Base64.NO_WRAP),
                )
                .commit()
        ) {
            "Could not save paired machines"
        }
    }
}
