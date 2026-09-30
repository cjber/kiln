package com.cjber.kiln

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionListTest {
    private val parent =
        Row(
            "parent",
            "codex",
            "Fix retry",
            "/z/atlas",
            "main",
            "idle",
            "kiln",
            1,
            20,
            "https://chatgpt.com/codex",
            "Choose thread",
            false,
        )
    private val child =
        parent.copy(id = "child", title = "Review retry", url = null, parent = "parent")

    private fun ids(items: List<SessionItem>) =
        items.filterIsInstance<SessionItem.Entry>().map { it.row.id }

    @Test
    fun collapseAndFilterKeepParentContextButHideOrphans() {
        val rows = listOf(child, child.copy(id = "orphan", parent = null), parent)
        assertEquals(
            listOf("parent"),
            ids(sessionItems(rows, SessionOrder.PROJECT, "", emptySet())),
        )
        assertEquals(
            listOf("parent", "child"),
            ids(sessionItems(rows, SessionOrder.PROJECT, "", setOf("parent"))),
        )
        assertEquals(
            listOf("parent", "child"),
            ids(sessionItems(rows, SessionOrder.PROJECT, "Review", emptySet())),
        )
    }

    @Test
    fun groupsUseNamesAndRecentUpdates() {
        val items =
            sessionItems(
                listOf(
                    parent.copy(id = "blog", cwd = "/a/blog", active = 100),
                    parent,
                    parent.copy(id = "recent", active = 30),
                ),
                SessionOrder.PROJECT,
                "",
                emptySet(),
            )
        assertEquals(
            listOf("atlas", "blog"),
            items.filterIsInstance<SessionItem.Header>().map { it.name },
        )
        assertEquals(listOf("recent", "parent", "blog"), ids(items))
    }
}
