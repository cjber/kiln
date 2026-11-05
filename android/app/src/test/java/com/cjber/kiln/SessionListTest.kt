package com.cjber.kiln

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionListTest {
    private val parent =
        Row(
            "parent",
            Agent.CODEX,
            "Fix retry",
            "/z/atlas",
            "main",
            Activity.IDLE,
            Place.KILN,
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
            where = Place.ELSEWHERE,
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
        val pi = parent.copy(id = "pi", agent = Agent.PI, url = null)
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
    fun liveKeepsLocalAndBusyCloudSessionsButDropsOlderOnes() {
        val now = 10 * 86_400_000L
        val recent = parent.copy(id = "recent", where = Place.CLOUD, active = now - 1000)
        val boundary = recent.copy(id = "boundary", active = now - 86_400_000)
        val working = boundary.copy(id = "working", activity = Activity.WORKING)
        val waiting = boundary.copy(id = "waiting", activity = Activity.WAITING)
        val unknown = boundary.copy(id = "unknown", activity = Activity.UNKNOWN)
        val noTimestamp = boundary.copy(id = "undated", active = 0, started = 0)
        val created = boundary.copy(id = "created", active = 0, started = now - 1000)
        val rows = listOf(parent, recent, boundary, working, waiting, unknown, noTimestamp, created)
        assertEquals(
            setOf("parent", "recent", "working", "waiting", "created"),
            ids(sessionItems(rows, SessionOrder.RECENT, "", emptySet(), SessionScope.LIVE, now))
                .toSet(),
        )
    }

    @Test
    fun activityAndAgentFiltersRevealMatchingChildrenWithTheirParent() {
        val waitingChild = child.copy(activity = Activity.WAITING, agent = Agent.CLAUDE)
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
                    Agent.CLAUDE,
                    Activity.WAITING,
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
                    Agent.PI,
                    Activity.WAITING,
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

    @Test
    fun aHiddenSessionReturnsWhenItsActivityChanges() {
        val working = listOf(parent.copy(activity = Activity.WORKING), child)
        val hidden = hideWithActivity(working, emptyMap(), sessionTreeIds(working, "parent"))
        assertEquals(mapOf("parent" to Activity.WORKING, "child" to Activity.IDLE), hidden)
        assertEquals(hidden, hiddenEntries(storedHidden(hidden)))
        assertEquals(hidden, settleHidden(working, hidden))
        // Losing sight of it is not a change.
        val unknown = listOf(parent.copy(activity = Activity.UNKNOWN), child)
        assertEquals(hidden, settleHidden(unknown, hidden))
        // The parent finishes: it comes back with its helper.
        assertEquals(emptyMap<String, Activity?>(), settleHidden(listOf(parent, child), hidden))
        // A helper that asks for input brings its parent back too.
        val asking =
            listOf(
                parent.copy(activity = Activity.WORKING),
                child.copy(activity = Activity.WAITING),
            )
        assertEquals(emptyMap<String, Activity?>(), settleHidden(asking, hidden))
    }

    @Test
    fun sessionsHiddenBeforeActivityWasStoredLearnItOnTheNextSnapshot() {
        val stored = hiddenEntries(setOf("parent"))
        assertEquals(mapOf("parent" to null), stored)
        assertEquals(mapOf("parent" to Activity.IDLE), settleHidden(listOf(parent, child), stored))
    }

    @Test
    fun lastActiveFallsBackToTheStartTimeThenOneUnknown() {
        val now = 1_800_000_000_000L
        assertEquals("2m ago · ${updateTime(now - 120_000)}", lastActive(now - 120_000, 1, now))
        assertEquals("Unknown, started 7m ago", lastActive(0, now - 420_000, now))
        assertEquals("Unknown", lastActive(0, 0, now))
        assertEquals("Unknown", updateTime(0))
    }

    @Test
    fun projectOrderGathersWorktreesWithTheirRepositoryAsTheTerminalListDoes() {
        val main =
            parent.copy(id = "main", cwd = "/src/nebula", repository = "/src/nebula", active = 10)
        val worktree =
            parent.copy(
                id = "tree",
                cwd = "/wt/nebula-fix",
                repository = "/src/nebula",
                active = 30,
            )
        val other =
            parent.copy(id = "kiln", cwd = "/src/kiln", repository = "/src/kiln", active = 50)
        val items =
            sessionItems(listOf(main, other, worktree), SessionOrder.PROJECT, "", emptySet())
        assertEquals(
            listOf("kiln", "/src/kiln", "nebula", "/src/nebula"),
            items.filterIsInstance<SessionItem.Header>().flatMap { listOf(it.name, it.directory) },
        )
        // Within a project, the most recently active comes first.
        assertEquals(listOf("kiln", "tree", "main"), ids(items))
    }

    @Test
    fun progressGroupsTopLevelSessionsByStageMostUrgentFirst() {
        val now = 100_000L
        val rows =
            listOf(
                parent.copy(id = "green", stage = Stage.GREEN, active = 50),
                parent.copy(id = "failing", stage = Stage.FAILING, active = 10),
                parent.copy(id = "helper", stage = Stage.FAILING, parent = "failing"),
                parent.copy(id = "working-old", stage = Stage.WORKING, active = 20),
                parent.copy(id = "working-new", stage = Stage.WORKING, active = 90),
                parent.copy(id = "cloud", where = Place.CLOUD),
                parent.copy(id = "hidden", stage = Stage.CHECKS),
            )
        val items = progressItems(rows, now = now, hiddenIds = setOf("hidden"))
        assertEquals(
            listOf(
                "stage:failing",
                "failing",
                "stage:green",
                "green",
                "stage:working",
                "working-new",
                "working-old",
            ),
            items.map { it.key },
        )
        assertEquals(2, (items[4] as SessionItem.StageHeader).count)
        val numbered = rows.map {
            if (it.id == "green") it.copy(pr = PullInfo(7, "u", false, false, 1, 0, 0)) else it
        }
        assertEquals(listOf("green"), ids(progressItems(numbered, "#7", now)))
    }
}
