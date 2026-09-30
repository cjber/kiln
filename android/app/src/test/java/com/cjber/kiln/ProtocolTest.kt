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
