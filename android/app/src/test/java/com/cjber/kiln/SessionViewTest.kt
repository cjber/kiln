package com.cjber.kiln

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionViewTest {
    private val abilities = """"abilities":{"read":true,"stop":true}"""

    @Test
    fun resultsAttachToTheirCallAcrossPages() {
        val first =
            parseView(
                """{$abilities,"reset":true,"cursor":"1:10","items":[
                {"id":"u1","kind":"you","text":"run it"},
                {"id":"t1","kind":"tool","tool":"Bash","text":"Run tests"}]}"""
            )
        assertEquals(listOf(ItemKind.YOU, ItemKind.TOOL), first.lines.map { it.kind })
        assertNull(first.abilities.reply)
        val next =
            parseView(
                """{$abilities,"reset":false,"cursor":"1:20","items":[
                {"id":"r1","kind":"result","of":"t1","text":"1 failed","error":true},
                {"id":"a1","kind":"agent","text":"One test fails"}]}""",
                first.lines,
            )
        assertEquals("1:20", next.cursor)
        assertEquals(3, next.lines.size)
        assertEquals("1 failed", next.lines[1].result)
        assertEquals(true, next.lines[1].error)
    }

    @Test
    fun aResetReplacesWhatWasHeld() {
        val held = listOf(Line("old", ItemKind.AGENT, "stale"))
        val page =
            parseView(
                """{"abilities":{"read":true,"reply":"kiln can only type into Claude sessions it started","stop":false},
                "reset":true,"cursor":"2:5","items":[{"id":"u1","kind":"you","text":"hi"}]}""",
                held,
            )
        assertEquals(listOf("hi"), page.lines.map { it.text })
        assertEquals("kiln can only type into Claude sessions it started", page.abilities.reply)
    }
}
