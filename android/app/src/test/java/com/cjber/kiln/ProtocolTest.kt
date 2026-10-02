package com.cjber.kiln

import org.junit.Assert.*
import org.junit.Test

class ProtocolTest {
    @Test
    fun rejectsUntrustedHandoffs() {
        assertEquals(
            "https://claude.ai/code/cse_example",
            safeLink("claude", "https://claude.ai/code/cse_example"),
        )
        assertEquals("https://chatgpt.com/codex", safeLink("codex", "https://chatgpt.com/codex"))
        for (url in
            listOf(
                "http://chatgpt.com/codex",
                "https://chatgpt.com.evil/codex",
                "https://user@chatgpt.com/codex",
                "https://chatgpt.com:444/codex",
                "https://chatgpt.com/codex?token=x",
                "https://chatgpt.com/codex#x",
                "https://chatgpt.com/codex/tasks/../settings",
            )) assertNull(safeLink("codex", url))
        assertNull(safeLink("pi", "https://chatgpt.com/codex"))
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
        assertEquals("completed", done.activity)
        assertEquals("Completed", activityName(done.activity))
        assertEquals("Stopped", activityName(row(""","lifecycle":"stopped"""").activity))
        assertEquals("idle", row(""","lifecycle":"other","activity":"idle"""").activity)
        val day = 86_400_000L
        assertFalse(isCurrentSession(done, 2 * day))
        assertTrue(isCurrentSession(done.copy(active = 2 * day - 1000), 2 * day))
        assertTrue(isCurrentSession(done.copy(activity = "idle"), 2 * day))
    }

    @Test
    fun remoteThreadLinksRequireAnExactHostAndThread() {
        val route = "https://chatgpt.com/codex/remote/thread/00000000-0000-0000-0000-000000000001"
        val url = "$route?hostId=slingshot%3Aenv_example%3A8765"
        assertEquals(url, safeLink("codex", url))
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
            safeLink(if (invalid.contains("claude.ai")) "claude" else "codex", invalid)
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
