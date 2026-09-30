package com.cjber.kiln

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PiRemoteTest {
    private fun state(): JSONObject =
        JSONObject()
            .put("instance", "bridge")
            .put("sequence", 2)
            .put("title", "Named session")
            .put("activity", "idle")
            .put("updatedAt", 123L)
            .put("localAction", "Use the local terminal for dialogs")
            .put(
                "messages",
                JSONArray().put(JSONObject().put("role", "user").put("text", "Existing prompt")),
            )

    @Test
    fun reconnectSnapshotsRetainTextAndWriterState() {
        val json = state().put("writer", "another-phone").put("ownWriter", false)
        val snapshot = parsePiSnapshot(json.toString())
        assertEquals("Named session", snapshot.title)
        assertEquals(123L, snapshot.updated)
        assertEquals(listOf(PiMessage("user", "Existing prompt")), snapshot.messages)
        assertTrue(snapshot.blocked)
        assertFalse(parsePiSnapshot(json.put("ownWriter", true).toString()).blocked)
    }

    @Test
    fun unknownActivityAndOversizedTextAreRejected() {
        for (json in
            listOf(
                state().put("activity", "guess"),
                state()
                    .put(
                        "messages",
                        JSONArray()
                            .put(JSONObject().put("role", "user").put("text", "x".repeat(4001))),
                    ),
            )) {
            assertThrows(IllegalArgumentException::class.java) { parsePiSnapshot(json.toString()) }
        }
    }
}
