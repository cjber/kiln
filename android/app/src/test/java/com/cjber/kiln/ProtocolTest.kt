package com.cjber.kiln

import org.junit.Assert.*
import org.junit.Test

class ProtocolTest {
    @Test
    fun rejectsUntrustedHandoffs() {
        assertEquals(
            "https://claude.ai/code/cse_example",
            safeLink(Agent.CLAUDE, "https://claude.ai/code/cse_example"),
        )
        assertEquals(
            "https://chatgpt.com/codex",
            safeLink(Agent.CODEX, "https://chatgpt.com/codex"),
        )
        for (url in
            listOf(
                "http://chatgpt.com/codex",
                "https://chatgpt.com.evil/codex",
                "https://user@chatgpt.com/codex",
                "https://chatgpt.com:444/codex",
                "https://chatgpt.com/codex?token=x",
                "https://chatgpt.com/codex#x",
                "https://chatgpt.com/codex/tasks/../settings",
            )) assertNull(safeLink(Agent.CODEX, url))
        assertNull(safeLink(Agent.PI, "https://chatgpt.com/codex"))
    }

    @Test
    fun opencodeLinksOnlyReachThePairedMachine() {
        val origin = "https://machine.example.ts.net"
        val link =
            "https://machine.example.ts.net:4096/server/" +
                "aHR0cHM6Ly9tYWNoaW5lLmV4YW1wbGUudHMubmV0OjQwOTY/session/ses_abc"
        assertEquals(link, safeLink(Agent.OPENCODE, link, origin))
        assertNull(safeLink(Agent.OPENCODE, link))
        assertNull(safeLink(Agent.OPENCODE, link, "https://other.example.ts.net"))
        for (url in
            listOf(
                link.replace(":4096", ":4097"),
                link.replace("https://", "http://"),
                link.replace("https://", "https://user@"),
                "$link?token=x",
                "$link#x",
                link.replace("ses_abc", "ses_../x"),
                "https://machine.example.ts.net:4096/server/" +
                    "aHR0cHM6Ly9ldmlsLmV4YW1wbGU6NDA5Ng/session/ses_abc",
            )) assertNull(safeLink(Agent.OPENCODE, url, origin))
    }

    @Test
    fun finishedBackgroundJobsShowHowTheyEndedAndLeaveTheLiveList() {
        fun row(extra: String) =
            parseSnapshot(
                    """{"version":1,"instance":"i","sequence":1,"updatedAt":1,"problem":"","sessions":[
                    {"id":"claude:bg","agent":"claude","title":"t","cwd":"/w","where":"background",
                    "startedAt":1,"handoff":{"reason":"Attach in kiln"}$extra}]}"""
                )
                .rows
                .single()
        val done = row(""","lifecycle":"completed"""")
        assertEquals(Activity.COMPLETED, done.activity)
        assertEquals("Completed", activityName(done.activity))
        assertEquals(Activity.STOPPED, row(""","lifecycle":"stopped"""").activity)
        assertEquals(Activity.IDLE, row(""","lifecycle":"other","activity":"idle"""").activity)
        val day = 86_400_000L
        assertFalse(isCurrentSession(done, 2 * day))
        assertTrue(isCurrentSession(done.copy(active = 2 * day - 1000), 2 * day))
        assertTrue(isCurrentSession(done.copy(activity = Activity.IDLE), 2 * day))
    }

    @Test
    fun newerServerValuesAreToleratedButUnknownAgentsAreNot() {
        fun snapshot(agent: String) =
            parseSnapshot(
                """{"version":1,"instance":"i","sequence":1,"updatedAt":1,"problem":"","sessions":[
                {"id":"x:1","agent":"$agent","title":"t","cwd":"/w","where":"orbit",
                "activity":"dreaming","startedAt":1,"handoff":{"reason":"r"}}]}"""
            )
        val row = snapshot("claude").rows.single()
        assertEquals(Place.OTHER, row.where)
        assertEquals(Activity.UNKNOWN, row.activity)
        assertTrue(isCurrentSession(row, 2 * 86_400_000L))
        assertThrows(NoSuchElementException::class.java) { snapshot("gemini") }
    }

    @Test
    fun freshnessUsesThePhoneClockWhenTheMachineLoadsAgain() {
        val first = Snapshot("i", 1, updated = 9_000_000, problem = "", rows = emptyList())
        assertEquals(500L, receivedAt(null, first, 0, 500))
        assertEquals(500L, receivedAt(first, first.copy(sequence = 2), 500, 800))
        assertEquals(
            900L,
            receivedAt(first, first.copy(sequence = 3, updated = 9_000_100), 500, 900),
        )
    }

    @Test
    fun remoteThreadLinksRequireAnExactHostAndThread() {
        val route = "https://chatgpt.com/codex/remote/thread/00000000-0000-0000-0000-000000000001"
        val url = "$route?hostId=slingshot%3Aenv_example%3A8765"
        assertEquals(url, safeLink(Agent.CODEX, url))
        for (invalid in
            listOf(
                route,
                "$route?hostId=env_example",
                "$url&token=private",
                "$url&hostId=other",
                "$url#other",
                "$route?hostId=slingshot%3Aenv_example%3A8888",
                "https://claude.ai/code/cse_example?hostId=slingshot%3Aenv_example%3A8765",
            )) assertNull(
            safeLink(if (invalid.contains("claude.ai")) Agent.CLAUDE else Agent.CODEX, invalid)
        )
    }

    @Test
    fun acceptsOnlyHttpsPairingOrigins() {
        assertEquals("https://machine.example:8443", httpsOrigin("https://machine.example:8443/"))
        for (url in
            listOf(
                "http://localhost",
                "https://user@machine.example",
                "https://machine.example/path",
                "https://machine.example?token=x",
            )) {
            try {
                httpsOrigin(url)
                fail("accepted $url")
            } catch (_: IllegalArgumentException) {}
        }
        val code = "a".repeat(43)
        assertEquals(
            "https://machine.example" to code,
            invitation("kiln://pair?server=https%3A%2F%2Fmachine.example&code=$code"),
        )
    }
}
