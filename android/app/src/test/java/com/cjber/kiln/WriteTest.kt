package com.cjber.kiln

import org.junit.Assert.*
import org.junit.Test

class WriteTest {
    private fun snapshot(extra: String, row: String = "") =
        parseSnapshot(
            """{"version":1,"instance":"i","sequence":1,"updatedAt":1,"problem":""$extra,"sessions":[
            {"id":"claude:a","agent":"claude","title":"t","cwd":"/w","where":"kiln",
            "startedAt":1,"handoff":{"reason":"r"}$row}]}"""
        )

    @Test
    fun anOlderServerIsReadOnlyAndRowsCarryTheirTerminal() {
        assertFalse(snapshot("").write)
        assertTrue(snapshot(""","write":true""").write)
        assertNull(snapshot("").rows.single().terminal)
        assertEquals(
            "claude-1",
            snapshot("", ""","terminal":"claude-1"""").rows.single().terminal,
        )
    }

    @Test
    fun onlyRowsTheMachineMarksResumableOfferResume() {
        assertFalse(snapshot("").rows.single().resumable)
        assertTrue(snapshot("", ""","resumable":true""").rows.single().resumable)
    }

    @Test
    fun startOptionsKeepTheMachineOrderAndDropUnknownAgents() {
        val options =
            parseStartOptions("""{"directories":["/b","/a"],"agents":["codex","gemini","pi"]}""")
        assertEquals(listOf("/b", "/a"), options.directories)
        assertEquals(listOf(Agent.CODEX, Agent.PI), options.agents)
        assertEquals(
            listOf("/home/me/kiln"),
            matchingDirectories(listOf("/home/me/kiln", "/home/me/notes"), "Me KI"),
        )
    }

    @Test
    fun startedSessionsNameAKilnTerminal() {
        assertEquals("claude-abc-1", parseStarted("""{"terminal":"claude-abc-1"}"""))
        assertThrows(IllegalArgumentException::class.java) {
            parseStarted("""{"terminal":"../../x"}""")
        }
    }

    @Test
    fun theSendBoxUsesKilnMsgWording() {
        assertEquals("Delivered", parseSent("""{"delivered":true}"""))
        assertEquals(
            "Waiting: Claude is working",
            parseSent("""{"delivered":false,"reason":"Claude is working"}"""),
        )
        val row = snapshot("").rows.single()
        assertTrue(canMessage(row))
        assertFalse(canMessage(row.copy(where = Place.CLOUD)))
        assertFalse(canMessage(row.copy(activity = Activity.COMPLETED)))
    }
}
