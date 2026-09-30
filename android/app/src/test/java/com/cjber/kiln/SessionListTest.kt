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
        parent.copy(
            id = "child",
            title = "Review retry",
            url = null,
            where = "elsewhere",
            parent = "parent",
        )

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
    fun localPiTasksStayVisibleWithoutHandoffLinks() {
        val pi = parent.copy(id = "pi", agent = "pi", url = null)
        assertEquals(
            listOf("pi"),
            ids(sessionItems(listOf(pi), SessionOrder.PROJECT, "", emptySet())),
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

    @Test
    fun elapsedMatchesTerminalUnits() {
        assertEquals("unknown", elapsed(0, 10_000))
        assertEquals("0s", elapsed(20_000, 10_000))
        assertEquals("59s", elapsed(1_000, 60_000))
        assertEquals("2m", elapsed(1_000, 121_000))
        assertEquals("3h", elapsed(1_000, 3 * 3_600_000 + 1_000))
        assertEquals("2d", elapsed(1_000, 2 * 86_400_000 + 1_000))
    }

    @Test
    fun tildePathShortensHome() {
        assertEquals("~/code/atlas", tildePath("/home/demo/code/atlas"))
        assertEquals("/srv/atlas", tildePath("/srv/atlas"))
    }
}
