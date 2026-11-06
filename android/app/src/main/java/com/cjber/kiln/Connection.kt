package com.cjber.kiln

import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class Connection(
    private val client: OkHttpClient =
        OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(10, TimeUnit.SECONDS)
            .callTimeout(15, TimeUnit.SECONDS)
            .pingInterval(15, TimeUnit.SECONDS)
            .build(),
    private val unreachable: () -> String = {
        "Cannot reach the machine. Check Tailscale and kiln serve."
    },
) {
    private var socket: WebSocket? = null
    private var call: Call? = null
    @Volatile private var generation = 0

    fun pair(origin: String, code: String, name: String, done: (Host?, String) -> Unit) {
        close()
        val current = generation
        val body =
            JSONObject()
                .put("code", code)
                .put("name", name)
                .toString()
                .toRequestBody("application/json".toMediaType())
        val request = Request.Builder().url("${httpsOrigin(origin)}/v1/pair").post(body).build()
        call =
            client.newCall(request).also {
                it.enqueue(
                    object : Callback {
                        override fun onFailure(call: Call, e: java.io.IOException) {
                            if (current == generation && !call.isCanceled())
                                done(null, unreachable())
                        }

                        override fun onResponse(call: Call, response: Response) {
                            response.use {
                                if (current != generation) return
                                if (!it.isSuccessful) {
                                    done(
                                        null,
                                        if (it.code == 401) "Pairing code expired or already used"
                                        else "Pairing failed (${it.code})",
                                    )
                                    return
                                }
                                try {
                                    val json = JSONObject(it.body!!.string())
                                    val token = json.getString("token")
                                    val name = json.getString("host")
                                    require(
                                        token.matches(Regex("[A-Za-z0-9_-]{43}")) &&
                                            name.isNotBlank() &&
                                            name.length <= 255
                                    )
                                    done(Host(origin, name, token), "")
                                } catch (_: Exception) {
                                    done(null, "Invalid pairing response")
                                }
                            }
                        }
                    }
                )
            }
    }

    /**
     * One authenticated request that a write route answers. `done` gets the body, or null and the
     * machine's own error message.
     */
    private fun call(
        host: Host,
        method: String,
        path: String,
        body: JSONObject?,
        done: (String?, String) -> Unit,
    ) {
        val request =
            Request.Builder()
                .url(host.origin + path)
                .header("Authorization", "Bearer ${host.token}")
                .method(method, body?.toString()?.toRequestBody("application/json".toMediaType()))
                .build()
        client
            .newCall(request)
            .enqueue(
                object : Callback {
                    override fun onFailure(call: Call, e: java.io.IOException) {
                        done(null, unreachable())
                    }

                    override fun onResponse(call: Call, response: Response) {
                        response.use {
                            val text = it.body?.string().orEmpty()
                            if (it.isSuccessful) done(text, "")
                            else
                                done(
                                    null,
                                    runCatching { JSONObject(text).getString("error") }
                                        .getOrDefault("Request failed (${it.code})"),
                                )
                        }
                    }
                }
            )
    }

    fun startOptions(host: Host, done: (StartOptions?, String) -> Unit) =
        call(host, "GET", "/v1/directories", null) { body, problem ->
            val options = body?.let { runCatching { parseStartOptions(it) }.getOrNull() }
            done(
                options,
                if (body != null && options == null) "Invalid directory list" else problem,
            )
        }

    fun startSession(
        host: Host,
        agent: Agent,
        directory: String,
        prompt: String,
        done: (String?, String) -> Unit,
    ) =
        call(
            host,
            "POST",
            "/v1/sessions",
            JSONObject().put("agent", agent.id).put("directory", directory).put("prompt", prompt),
        ) { body, problem ->
            val terminal = body?.let { runCatching { parseStarted(it) }.getOrNull() }
            done(terminal, if (body != null && terminal == null) "Invalid response" else problem)
        }

    /** Starts a stopped session again; `done` gets its tmux name, or why it did not start. */
    fun resume(host: Host, id: String, done: (String?, String) -> Unit) =
        call(
            host,
            "POST",
            "/v1/sessions/${java.net.URLEncoder.encode(id, "UTF-8")}/resume",
            JSONObject(),
        ) { body, problem ->
            val terminal = body?.let { runCatching { parseStarted(it) }.getOrNull() }
            done(terminal, if (body != null && terminal == null) "Invalid response" else problem)
        }

    /** `done` gets the line the send box shows. */
    fun send(host: Host, id: String, text: String, done: (String) -> Unit) =
        call(
            host,
            "POST",
            "/v1/sessions/${java.net.URLEncoder.encode(id, "UTF-8")}/messages",
            JSONObject().put("text", text),
        ) { body, problem ->
            done(
                body?.let { runCatching { parseSent(it) }.getOrDefault("Invalid response") }
                    ?: problem
            )
        }

    fun connect(
        host: Host,
        snapshot: (Snapshot) -> Unit,
        state: (ConnectionState) -> Unit,
        revoked: () -> Unit,
    ) {
        close()
        val current = generation
        val request =
            Request.Builder()
                .url(host.origin.replaceFirst("https://", "wss://") + "/v1/events")
                .header("Authorization", "Bearer ${host.token}")
                .build()
        socket =
            client.newWebSocket(
                request,
                object : WebSocketListener() {
                    private var previous: Snapshot? = null

                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        if (current != generation) return
                        state(ConnectionState.CONNECTED)
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (current != generation) return
                        if (text.length > 2_000_000) {
                            webSocket.close(1009, "List too large")
                            state(ConnectionState.INVALID)
                            return
                        }
                        try {
                            val next = parseSnapshot(text, host.origin)
                            val old = previous
                            if (
                                old == null ||
                                    old.instance != next.instance ||
                                    next.sequence > old.sequence
                            ) {
                                previous = next
                                snapshot(next)
                            }
                        } catch (_: Exception) {
                            webSocket.close(1008, "Invalid list")
                            state(ConnectionState.INVALID)
                        }
                    }

                    override fun onFailure(
                        webSocket: WebSocket,
                        t: Throwable,
                        response: Response?,
                    ) {
                        if (current != generation) return
                        if (response?.code == 401) revoked()
                        else state(ConnectionState.DISCONNECTED)
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        if (current != generation) return
                        if (code == 4001) revoked() else state(ConnectionState.DISCONNECTED)
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(code, reason)
                    }
                },
            )
    }

    fun close() {
        generation++
        socket?.cancel()
        call?.cancel()
    }
}
