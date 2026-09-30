package com.cjber.kiln

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class ConnectionTest {
    private fun withServer(test: (MockWebServer, Connection) -> Unit) {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverCertificates =
            HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val clientCertificates =
            HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val server = MockWebServer()
        server.useHttps(serverCertificates.sslSocketFactory(), false)
        server.start()
        val client =
            OkHttpClient.Builder()
                .sslSocketFactory(
                    clientCertificates.sslSocketFactory(),
                    clientCertificates.trustManager,
                )
                .followRedirects(false)
                .followSslRedirects(false)
                .build()
        val connection = Connection(client)
        try {
            test(server, connection)
        } finally {
            connection.close()
            server.close()
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
        }
    }

    @Test
    fun pairingUsesBodyAndNeverFollowsRedirects() = withServer { server, connection ->
        val results = LinkedBlockingQueue<Pair<Host?, String>>()
        val token = "t".repeat(43)
        server.enqueue(MockResponse().setBody("""{"host":"machine","token":"$token"}"""))
        val origin = server.url("/").toString().removeSuffix("/")
        connection.pair(origin, "c".repeat(43), "phone") { host, error ->
            results.add(host to error)
        }
        val result = results.poll(3, TimeUnit.SECONDS)
        assertEquals(token, result?.first?.token)
        val request = server.takeRequest(3, TimeUnit.SECONDS)!!
        assertEquals("/v1/pair", request.path)
        assertNull(request.getHeader("Authorization"))
        assertTrue(request.body.readUtf8().contains("c".repeat(43)))
        server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", "/redirect"))
        connection.pair(origin, "c".repeat(43), "phone") { host, error ->
            results.add(host to error)
        }
        assertNull(results.poll(3, TimeUnit.SECONDS)?.first)
        assertEquals("/v1/pair", server.takeRequest(3, TimeUnit.SECONDS)?.path)
        assertNull(server.takeRequest(100, TimeUnit.MILLISECONDS))
    }

    @Test
    fun streamUsesHeaderIgnoresOldSnapshotsAndReportsRevocation() =
        withServer { server, connection ->
            val snapshots = LinkedBlockingQueue<Snapshot>()
            val revoked = LinkedBlockingQueue<Boolean>()
            val token = "t".repeat(43)
            fun snapshot(sequence: Int) =
                """{"version":1,"instance":"same","sequence":$sequence,"updatedAt":1,"problem":"","sessions":[]}"""
            server.enqueue(
                MockResponse()
                    .withWebSocketUpgrade(
                        object : WebSocketListener() {
                            override fun onOpen(webSocket: WebSocket, response: Response) {
                                webSocket.send(snapshot(2))
                                webSocket.send(snapshot(1))
                                webSocket.send(snapshot(3))
                                webSocket.close(4001, "Revoked")
                            }
                        }
                    )
            )
            connection.connect(
                Host(server.url("/").toString().removeSuffix("/"), "machine", token),
                { snapshots.add(it) },
                {},
                { revoked.add(true) },
            )
            assertEquals(2L, snapshots.poll(3, TimeUnit.SECONDS)?.sequence)
            assertEquals(3L, snapshots.poll(3, TimeUnit.SECONDS)?.sequence)
            assertEquals(true, revoked.poll(3, TimeUnit.SECONDS))
            assertNull(snapshots.poll(100, TimeUnit.MILLISECONDS))
            val request = server.takeRequest(3, TimeUnit.SECONDS)!!
            assertEquals("/v1/events", request.path)
            assertEquals("Bearer $token", request.getHeader("Authorization"))
        }
}
