package com.cjber.kiln

import org.junit.Assert.assertEquals
import org.junit.Test

class AlertsTest {
    private val row =
        Row(
            "a",
            Agent.CLAUDE,
            "Fix retry",
            "/z/atlas",
            "main",
            Activity.WORKING,
            Place.KILN,
            1,
            20,
            null,
            "",
            false,
        )

    @Test
    fun alertsOnlyWhenAnObservedTurnEnds() {
        val working = listOf(row, row.copy(id = "cloud", where = Place.CLOUD))
        assertEquals(emptyList<Row>(), endedTurns(null, working))
        val previous = activities(working)
        val next =
            listOf(
                row.copy(activity = Activity.WAITING),
                row.copy(id = "cloud", where = Place.CLOUD, activity = Activity.IDLE),
                row.copy(id = "new", activity = Activity.IDLE),
            )
        assertEquals(listOf("a"), endedTurns(previous, next).map { it.id })
        assertEquals(
            emptyList<Row>(),
            endedTurns(activities(next), listOf(row.copy(activity = Activity.IDLE))),
        )
    }
}
