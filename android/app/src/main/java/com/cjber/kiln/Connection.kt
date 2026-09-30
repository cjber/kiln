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
            .build()
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
                                done(
                                    null,
                                    "Cannot reach the machine. Check Tailscale and kiln serve.",
                                )
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

    fun connect(
        host: Host,
        snapshot: (Snapshot) -> Unit,
        state: (String) -> Unit,
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
                        state("Connected")
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (current != generation) return
                        if (text.length > 2_000_000) {
                            webSocket.close(1009, "List too large")
                            state("Invalid session list")
                            return
                        }
                        try {
                            val next = parseSnapshot(text)
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
                            state("Invalid session list")
                        }
                    }

                    override fun onFailure(
                        webSocket: WebSocket,
                        t: Throwable,
                        response: Response?,
                    ) {
                        if (current != generation) return
                        if (response?.code == 401) revoked()
                        else state("Disconnected; reconnecting")
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        if (current != generation) return
                        if (code == 4001) revoked() else state("Disconnected; reconnecting")
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
