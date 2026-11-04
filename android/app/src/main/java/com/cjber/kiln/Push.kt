package com.cjber.kiln

import android.content.Context
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/** This phone's UnifiedPush endpoint and the Web Push keys a machine encrypts to. */
data class PushRegistration(val endpoint: String, val p256dh: String, val auth: String)

/** A push from a machine: which session changed, on the machine named [host]. */
data class PushAlert(val host: String, val alert: TurnAlert)

/** The alert in a decrypted push body, or null for anything this version does not understand. */
fun parsePushAlert(source: String): PushAlert? =
    try {
        val json = JSONObject(source)
        require(json.getInt("v") == 1)
        val transition = json.getString("transition")
        require(transition == "finished" || transition == "input")
        val session = json.getString("session")
        require(session.isNotEmpty() && session.length <= 512)
        PushAlert(
            json.getString("host"),
            TurnAlert(
                session,
                json.getString("agent").let { id -> Agent.entries.first { it.id == id } },
                json.optString("title"),
                json.optString("cwd"),
                transition == "input",
                json.getLong("at"),
            ),
        )
    } catch (_: Exception) {
        null
    }

/**
 * Opt-in notifications with the app closed. The phone registers once with the user's UnifiedPush
 * distributor and gives every paired machine the same endpoint; each machine encrypts its alerts to
 * this phone's keys, so the distributor only relays ciphertext.
 */
object Push {
    private const val PREFERENCES = "push"
    private val client =
        OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(10, TimeUnit.SECONDS)
            .callTimeout(15, TimeUnit.SECONDS)
            .build()

    private fun preferences(context: Context) =
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun enabled(context: Context): Boolean = preferences(context).getBoolean("enabled", false)

    /** Watches the switch, which the push service may turn off when the distributor drops kiln. */
    fun listen(context: Context, changed: (Boolean) -> Unit) =
        android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
                // clear() reports a null key.
                if (key == null || key == "enabled") changed(enabled(context))
            }
            .also { preferences(context).registerOnSharedPreferenceChangeListener(it) }

    fun unlisten(
        context: Context,
        listener: android.content.SharedPreferences.OnSharedPreferenceChangeListener,
    ) = preferences(context).unregisterOnSharedPreferenceChangeListener(listener)

    fun registration(context: Context): PushRegistration? {
        val preferences = preferences(context)
        return PushRegistration(
            preferences.getString("endpoint", null) ?: return null,
            preferences.getString("p256dh", null) ?: return null,
            preferences.getString("auth", null) ?: return null,
        )
    }

    private fun hosts(context: Context): List<Host> =
        try {
            Credentials(context).read()
        } catch (_: Exception) {
            emptyList()
        }

    /** Registers with the distributor; the endpoint arrives later in [KilnPushService]. */
    fun enable(context: Context) {
        preferences(context).edit().putBoolean("enabled", true).apply()
        UnifiedPush.register(context, messageForDistributor = "kiln")
    }

    /** Unregisters everywhere: with the distributor and on every paired machine. */
    fun disable(context: Context) {
        preferences(context).edit().clear().apply()
        UnifiedPush.unregister(context)
        hosts(context).forEach { forget(it) }
    }

    /** Gives `host` this phone's endpoint, when notifications with the app closed are on. */
    fun share(context: Context, host: Host) {
        if (!enabled(context)) return
        registration(context)?.let { send(host, it) }
    }

    /** Removes this phone's endpoint from `host`; best effort, since the machine also drops it. */
    fun forget(host: Host) = send(host, null)

    internal fun endpointChanged(context: Context, next: PushRegistration) {
        val preferences = preferences(context)
        preferences
            .edit()
            .putString("endpoint", next.endpoint)
            .putString("p256dh", next.p256dh)
            .putString("auth", next.auth)
            .apply()
        if (enabled(context)) hosts(context).forEach { send(it, next) }
    }

    internal fun dropped(context: Context) {
        val had = enabled(context)
        preferences(context).edit().clear().apply()
        if (had) hosts(context).forEach { forget(it) }
    }

    internal fun received(context: Context, source: String) {
        val push = parsePushAlert(source) ?: return
        val host = hosts(context).firstOrNull { it.name == push.host } ?: return
        if (!notifyEnabled(context, host.origin) || Alerts.visibleOrigin == host.origin) return
        Alerts.show(context, host, push.alert)
    }

    private fun send(host: Host, registration: PushRegistration?) {
        val builder =
            Request.Builder()
                .url("${httpsOrigin(host.origin)}/v1/push")
                .header("Authorization", "Bearer ${host.token}")
        val request =
            if (registration == null) builder.delete().build()
            else
                builder
                    .post(
                        JSONObject()
                            .put("endpoint", registration.endpoint)
                            .put("p256dh", registration.p256dh)
                            .put("auth", registration.auth)
                            .toString()
                            .toRequestBody("application/json".toMediaType())
                    )
                    .build()
        client
            .newCall(request)
            .enqueue(
                object : Callback {
                    // A machine that is off gets the endpoint the next time the app opens.
                    override fun onFailure(call: Call, e: IOException) {}

                    override fun onResponse(call: Call, response: Response) = response.close()
                }
            )
    }
}

/** Receives the endpoint and decrypted messages from the UnifiedPush distributor. */
class KilnPushService : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val keys = endpoint.pubKeySet ?: return
        Push.endpointChanged(this, PushRegistration(endpoint.url, keys.pubKey, keys.auth))
    }

    override fun onMessage(message: PushMessage, instance: String) {
        if (message.decrypted) Push.received(this, String(message.content, Charsets.UTF_8))
    }

    // A network failure is retried when the app next opens; anything else needs the user.
    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        if (reason != FailedReason.NETWORK) Push.dropped(this)
    }

    override fun onUnregistered(instance: String) = Push.dropped(this)
}
