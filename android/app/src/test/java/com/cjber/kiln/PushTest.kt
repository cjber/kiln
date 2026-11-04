package com.cjber.kiln

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PushTest {
    private val body =
        """{"v":1,"host":"desk","machine":"https://desk.example","session":"claude:1","title":"Fix retry","agent":"claude","cwd":"/home/me/atlas","transition":"finished","at":42}"""

    @Test
    fun parsesTheMachinesAlert() {
        assertEquals(
            PushAlert(
                "https://desk.example",
                TurnAlert("claude:1", Agent.CLAUDE, "Fix retry", "/home/me/atlas", false, 42),
            ),
            parsePushAlert(body),
        )
        assertTrue(parsePushAlert(body.replace("finished", "input"))!!.alert.waiting)
    }

    @Test
    fun rejectsWhatThisVersionDoesNotKnow() {
        assertNull(parsePushAlert("not json"))
        assertNull(parsePushAlert(body.replace("\"v\":1", "\"v\":2")))
        assertNull(parsePushAlert(body.replace("finished", "started")))
        assertNull(parsePushAlert(body.replace("claude\",\"cwd", "gemini\",\"cwd")))
        assertNull(parsePushAlert(body.replace(",\"at\":42", "")))
        assertNull(parsePushAlert(body.replace("\"machine\"", "\"other\"")))
        assertNull(parsePushAlert(body.replace("claude:1", "")))
    }

    @Test
    fun theSameTransitionIsShownOnce() {
        val alert = TurnAlert("claude:1", Agent.CLAUDE, "", "/", false, 42)
        val recent = RecentAlerts("")
        assertTrue(recent.add(RecentAlerts.key("https://a", alert)))
        assertFalse(recent.add(RecentAlerts.key("https://a", alert)))
        // Another machine, or a later turn of the same session, is new.
        assertTrue(recent.add(RecentAlerts.key("https://b", alert)))
        assertTrue(recent.add(RecentAlerts.key("https://a", alert.copy(at = 43))))
        // The record survives a restart and keeps only the newest keys.
        val restored = RecentAlerts(recent.toString(), limit = 2)
        assertFalse(restored.add(RecentAlerts.key("https://a", alert.copy(at = 43))))
        assertTrue(restored.add(RecentAlerts.key("https://c", alert)))
        assertTrue(restored.add(RecentAlerts.key("https://a", alert)))
    }
}
