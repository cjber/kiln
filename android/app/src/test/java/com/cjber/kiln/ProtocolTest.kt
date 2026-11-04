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
        val path = "/opencode/" + "a".repeat(32)
        assertEquals("$origin$path", safeLink(Agent.OPENCODE, path, origin))
        assertEquals("$origin$path", safeLink(Agent.OPENCODE, path, "$origin/"))
        assertNull(safeLink(Agent.OPENCODE, path))
        assertNull(safeLink(Agent.OPENCODE, path, "http://machine.example.ts.net"))
        for (value in
            listOf(
                "https://evil.example$path",
                "//evil.example$path",
                "$path?x=1",
                "/opencode/" + "a".repeat(31),
                "/opencode/../" + "a".repeat(29),
            )) assertNull(safeLink(Agent.OPENCODE, value, origin))
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
    fun pullRequestsKeepOnlyGithubLinksAndTheirChecks() {
        fun row(extra: String) =
            parseSnapshot(
                    """{"version":1,"instance":"i","sequence":1,"updatedAt":1,"problem":"","sessions":[
                    {"id":"claude:a","agent":"claude","title":"t","cwd":"/w","where":"kiln",
                    "startedAt":1,"handoff":{}$extra}]}"""
                )
                .rows
                .single()
        val failing =
            row(
                ""","stage":"failing","pr":{"number":212,"url":"https://github.com/o/r/pull/212",
                "state":"OPEN","draft":false,"queued":true,"checks":{"passed":9,"failed":2,"running":0}}"""
            )
        assertEquals(Stage.FAILING, failing.stage)
        assertEquals(
            PullInfo(212, "https://github.com/o/r/pull/212", false, true, 9, 2, 0),
            failing.pr,
        )
        assertNull(
            row(""","stage":"green","pr":{"number":1,"url":"https://evil.example/o/r/pull/1"}""").pr
        )
        assertNull(row(""","stage":"later"""").stage)
        assertNull(row("").stage)
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

    @Test
    fun invalidInvitationsReportOnTheirField() {
        val message = "Paste a valid kiln invitation with an HTTPS server URL"
        assertEquals(message, invitationError("not-a-link"))
        assertEquals(message, invitationError("kiln://pair?server=http%3A%2F%2Fmachine&code=x"))
        assertEquals(
            "",
            invitationError(
                "kiln://pair?server=https%3A%2F%2Fmachine.example&code=${"a".repeat(43)}"
            ),
        )
    }
}
