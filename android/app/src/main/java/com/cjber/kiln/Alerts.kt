package com.cjber.kiln

/**
 * The sessions whose turn just ended: observed working before, now waiting or idle. Matches the
 * desktop notifications, so a first snapshot, cloud tasks and unknown states never alert.
 */
fun endedTurns(previous: Map<String, Activity>?, rows: List<Row>): List<Row> =
    if (previous == null) emptyList()
    else
        rows.filter {
            it.where != Place.CLOUD &&
                previous[it.id] == Activity.WORKING &&
                (it.activity == Activity.WAITING || it.activity == Activity.IDLE)
        }

fun activities(rows: List<Row>): Map<String, Activity> =
    rows.filter { it.where != Place.CLOUD }.associate { it.id to it.activity }
