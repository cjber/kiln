package com.cjber.kiln

import org.junit.Assert.assertEquals
import org.junit.Test

class TransitionsTest {
    private val row =
        Row(
            "claude:1",
            Agent.CLAUDE,
            "Fix retry",
            "/home/me/atlas",
            "main",
            Activity.WORKING,
            Place.KILN,
            1,
            2,
            null,
            "",
            false,
        )

    private fun snapshot(
        vararg activities: Activity,
        instance: String = "a",
        place: Place = Place.KILN,
    ) =
        Snapshot(
            instance,
            0,
            0,
            "",
            activities.mapIndexed { index, activity ->
                row.copy(id = "claude:$index", activity = activity, where = place)
            },
        )

    private fun ids(rows: List<Row>) = rows.map { "${it.id} ${it.activity.id}" }

    @Test
    fun notifiesWhenWorkingTurnsToWaitingOrIdle() {
        val check = Transitions()
        assertEquals(
            emptyList<String>(),
            ids(check.update(snapshot(Activity.WORKING, Activity.WORKING), true)),
        )
        assertEquals(
            listOf("claude:0 waiting", "claude:1 idle"),
            ids(check.update(snapshot(Activity.WAITING, Activity.IDLE), true)),
        )
    }

    @Test
    fun aRepeatedSnapshotDoesNotNotifyTwice() {
        val check = Transitions()
        check.update(snapshot(Activity.WORKING), true)
        assertEquals(1, check.update(snapshot(Activity.WAITING), true).size)
        assertEquals(0, check.update(snapshot(Activity.WAITING), true).size)
    }

    @Test
    fun aNewInstanceOrReconnectStartsOver() {
        val check = Transitions()
        check.update(snapshot(Activity.WORKING), true)
        assertEquals(0, check.update(snapshot(Activity.WAITING, instance = "b"), true).size)
        check.update(snapshot(Activity.WORKING, instance = "b"), true)
        check.reset()
        assertEquals(0, check.update(snapshot(Activity.IDLE, instance = "b"), true).size)
    }

    @Test
    fun unknownActivityAndFinishedJobsNeverNotify() {
        val check = Transitions()
        check.update(snapshot(Activity.WORKING, Activity.WORKING), true)
        assertEquals(0, check.update(snapshot(Activity.UNKNOWN, Activity.COMPLETED), true).size)
        assertEquals(0, check.update(snapshot(Activity.WAITING, Activity.IDLE), true).size)
    }

    @Test
    fun cloudTasksAndDisabledMachinesStaySilent() {
        val cloud = Transitions()
        cloud.update(snapshot(Activity.WORKING, place = Place.CLOUD), true)
        assertEquals(0, cloud.update(snapshot(Activity.WAITING, place = Place.CLOUD), true).size)
        val muted = Transitions()
        muted.update(snapshot(Activity.WORKING), false)
        assertEquals(0, muted.update(snapshot(Activity.WAITING), true).size)
        muted.update(snapshot(Activity.WORKING), true)
        assertEquals(0, muted.update(snapshot(Activity.WAITING), false).size)
    }

    private fun staged(vararg stages: Stage?, instance: String = "a") =
        Snapshot(
            instance,
            0,
            0,
            "",
            stages.mapIndexed { index, stage -> row.copy(id = "claude:$index", stage = stage) },
        )

    @Test
    fun notifiesWhenAPullRequestTurnsRedFromRunningOrPassingChecks() {
        val check = FailingTransitions()
        check.update(staged(Stage.CHECKS, Stage.GREEN, Stage.WORKING), true)
        assertEquals(
            listOf("claude:0", "claude:1"),
            check.update(staged(Stage.FAILING, Stage.FAILING, Stage.FAILING), true).map { it.id },
        )
        // Still failing is not news, and a machine's first lookups turning Working red are not
        // either.
        assertEquals(
            0,
            check.update(staged(Stage.FAILING, Stage.FAILING, Stage.FAILING), true).size,
        )
        check.update(staged(Stage.CHECKS), false)
        assertEquals(0, check.update(staged(Stage.FAILING), true).size)
        check.update(staged(Stage.CHECKS, instance = "b"), true)
        check.reset()
        assertEquals(0, check.update(staged(Stage.FAILING, instance = "b"), true).size)
    }
}
