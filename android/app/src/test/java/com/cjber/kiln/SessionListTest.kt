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

    @Test
    fun liveKeepsLocalAndBusyCloudSessionsButSeparatesOlderHistory() {
        val now = 10 * 86_400_000L
        val recent = parent.copy(id = "recent", where = "cloud", active = now - 1000)
        val boundary = recent.copy(id = "boundary", active = now - 86_400_000)
        val working = boundary.copy(id = "working", activity = "working")
        val waiting = boundary.copy(id = "waiting", activity = "waiting")
        val unknown = boundary.copy(id = "unknown", activity = "unknown")
        val noTimestamp = boundary.copy(id = "undated", active = 0, started = 0)
        val created = boundary.copy(id = "created", active = 0, started = now - 1000)
        val rows = listOf(parent, recent, boundary, working, waiting, unknown, noTimestamp, created)
        assertEquals(
            setOf("parent", "recent", "working", "waiting", "created"),
            ids(sessionItems(rows, SessionOrder.RECENT, "", emptySet(), SessionScope.LIVE, now))
                .toSet(),
        )
        assertEquals(
            setOf("boundary", "unknown", "undated"),
            ids(sessionItems(rows, SessionOrder.RECENT, "", emptySet(), SessionScope.HISTORY, now))
                .toSet(),
        )
    }

    @Test
    fun activityAndAgentFiltersRevealMatchingChildrenWithTheirParent() {
        val waitingChild = child.copy(activity = "waiting", agent = "claude")
        assertEquals(
            listOf("parent", "child"),
            ids(
                sessionItems(
                    listOf(parent, waitingChild),
                    SessionOrder.RECENT,
                    "",
                    emptySet(),
                    SessionScope.LIVE,
                    100,
                    "claude",
                    "waiting",
                )
            ),
        )
        assertEquals(
            emptyList<String>(),
            ids(
                sessionItems(
                    listOf(parent, waitingChild),
                    SessionOrder.RECENT,
                    "",
                    emptySet(),
                    SessionScope.LIVE,
                    100,
                    "pi",
                    "waiting",
                )
            ),
        )
    }

    @Test
    fun hiddenChildrenDoNotResurrectTheirVisibleParentAndTreesRestoreTogether() {
        val rows = listOf(parent, child)
        val hidden = sessionTreeIds(rows, "parent")
        assertEquals(setOf("parent", "child"), hidden)
        assertEquals(
            emptyList<String>(),
            ids(
                sessionItems(
                    rows,
                    SessionOrder.RECENT,
                    "",
                    emptySet(),
                    SessionScope.LIVE,
                    100,
                    hiddenIds = hidden,
                )
            ),
        )
        assertEquals(
            listOf("parent", "child"),
            ids(
                sessionItems(
                    rows,
                    SessionOrder.RECENT,
                    "",
                    setOf("parent"),
                    SessionScope.HIDDEN,
                    100,
                    hiddenIds = hidden,
                )
            ),
        )
        assertEquals(
            listOf("child"),
            ids(
                sessionItems(
                    rows,
                    SessionOrder.RECENT,
                    "",
                    emptySet(),
                    SessionScope.HIDDEN,
                    100,
                    hiddenIds = setOf("child"),
                )
            ),
        )
        assertEquals(
            listOf("parent"),
            ids(
                sessionItems(
                    rows,
                    SessionOrder.RECENT,
                    "",
                    setOf("parent"),
                    SessionScope.LIVE,
                    100,
                    hiddenIds = setOf("child"),
                )
            ),
        )
        assertEquals(
            listOf("parent", "child"),
            ids(
                sessionItems(
                    rows,
                    SessionOrder.RECENT,
                    "",
                    setOf("parent"),
                    SessionScope.LIVE,
                    100,
                    hiddenIds = hidden - sessionTreeIds(rows, "parent"),
                )
            ),
        )
    }

    @Test
    fun newChildrenStayHiddenAndRestoringThemRestoresTheirAncestor() {
        val rows = listOf(parent, child)
        val hidden = hiddenSessionIds(rows, setOf("parent"))
        assertEquals(setOf("parent", "child"), hidden)
        assertEquals(
            emptyList<String>(),
            ids(
                sessionItems(
                    rows,
                    SessionOrder.RECENT,
                    "",
                    emptySet(),
                    SessionScope.LIVE,
                    100,
                    hiddenIds = setOf("parent"),
                )
            ),
        )
        assertEquals(setOf("parent", "child"), sessionRestoreIds(rows, "child"))
        assertEquals(emptySet<String>(), hidden - sessionRestoreIds(rows, "child"))
    }
}
