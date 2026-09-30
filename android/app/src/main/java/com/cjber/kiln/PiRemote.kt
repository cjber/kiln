package com.cjber.kiln

import androidx.compose.runtime.*
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

data class PiMessage(val role: String, val text: String)

data class PiSnapshot(
    val instance: String,
    val sequence: Long,
    val title: String,
    val activity: String,
    val messages: List<PiMessage>,
    val blocked: Boolean,
    val notice: String,
    val updated: Long = 0,
)

fun parsePiSnapshot(source: String): PiSnapshot {
    val json = JSONObject(source)
    require(json.getString("activity") in listOf("working", "idle"))
    val messages = json.getJSONArray("messages")
    require(messages.length() <= 40)
    return PiSnapshot(
        json.getString("instance"),
        json.getLong("sequence"),
        json.optString("title", "Pi session"),
        json.getString("activity"),
        (0 until messages.length()).map { index ->
            val message = messages.getJSONObject(index)
            val text = message.getString("text")
            require(text.length <= 4000)
            PiMessage(message.getString("role"), text)
        },
        json.has("writer") && !json.optBoolean("ownWriter"),
        json.getString("localAction"),
        json.optLong("updatedAt"),
    )
}

class PiConnection {
    private val client =
        OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .callTimeout(3, TimeUnit.SECONDS)
            .build()

    fun close() {
        client.dispatcher.cancelAll()
        client.connectionPool.evictAll()
    }

    suspend fun request(host: Host, row: Row, body: JSONObject? = null): String =
        withContext(Dispatchers.IO) {
            val id = row.id.removePrefix("pi:")
            require(id.matches(Regex("[A-Za-z0-9_-]{1,128}")))
            val builder =
                Request.Builder()
                    .url("${httpsOrigin(host.origin)}/v1/pi/$id")
                    .header("Authorization", "Bearer ${host.token}")
            if (body != null)
                builder.post(body.toString().toRequestBody("application/json".toMediaType()))
            client.newCall(builder.build()).execute().use { response ->
                val text = response.body?.string().orEmpty()
                require(text.length <= 1_048_576)
                if (!response.isSuccessful) {
                    val problem =
                        if (response.code == 401) "Pairing revoked; reconnect this machine"
                        else JSONObject(text).optString("error", "Pi request failed")
                    throw java.io.IOException(problem)
                }
                text
            }
        }
}

@Composable
fun PiRemoteScreen(host: Host, row: Row, foreground: Boolean, close: () -> Unit) {
    val connection = remember(host.origin, row.id) { PiConnection() }
    var state by remember { mutableStateOf<PiSnapshot?>(null) }
    var connected by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var connectionError by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    DisposableEffect(connection) { onDispose { connection.close() } }
    LaunchedEffect(foreground, host, row.id) {
        connected = false
        while (foreground) {
            try {
                val next = parsePiSnapshot(connection.request(host, row))
                val previous = state
                if (
                    previous == null ||
                        previous.instance != next.instance ||
                        next.sequence >= previous.sequence
                )
                    state = next
                connected = true
                connectionError = ""
            } catch (failure: Exception) {
                if (failure is kotlinx.coroutines.CancellationException) throw failure
                connected = false
                connectionError =
                    if (failure is java.io.IOException) failure.message.orEmpty()
                    else "Invalid Pi session response"
            }
            delay(1000)
        }
    }
    fun command(type: String) {
        busy = true
        scope.launch {
            try {
                val body = JSONObject().put("type", type).put("id", UUID.randomUUID().toString())
                if (type == "prompt") body.put("message", prompt)
                connection.request(host, row, body)
                if (type == "prompt") prompt = ""
                error = ""
            } catch (failure: Exception) {
                if (failure is kotlinx.coroutines.CancellationException) throw failure
                error =
                    if (failure is java.io.IOException) failure.message.orEmpty()
                    else "Pi command failed; check the local terminal"
            } finally {
                busy = false
            }
        }
    }
    PiConversation(
        host.name,
        row.title,
        state,
        connected,
        listOf(connectionError, error).filter { it.isNotEmpty() }.joinToString("\n"),
        prompt,
        { prompt = it },
        busy,
        ::command,
        close,
    )
}
