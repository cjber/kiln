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
