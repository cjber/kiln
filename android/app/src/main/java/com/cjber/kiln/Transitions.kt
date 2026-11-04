package com.cjber.kiln

/**
 * The phone's port of `nativeNotifications` in `src/notifications.ts`. [update] returns the
 * sessions seen going from working to waiting or idle since the last snapshot. Cloud tasks are
 * skipped, a session that leaves or turns unknown loses its history, and a new server instance or
 * [reset] starts over, so a reconnect never replays old changes.
 */
class Transitions {
    private var instance: String? = null
    private var previous = emptyMap<String, Activity>()

    fun reset() {
        instance = null
        previous = emptyMap()
    }

    fun update(snapshot: Snapshot, enabled: Boolean): List<Row> {
        if (snapshot.instance != instance) {
            instance = snapshot.instance
            previous = emptyMap()
        }
        val changed = mutableListOf<Row>()
        val next = HashMap<String, Activity>()
        for (row in snapshot.rows) {
            if (row.where == Place.CLOUD) continue
            if (
                enabled &&
                    previous[row.id] == Activity.WORKING &&
                    (row.activity == Activity.WAITING || row.activity == Activity.IDLE)
            )
                changed += row
            next[row.id] = row.activity
        }
        previous = if (enabled) next else emptyMap()
        return changed
    }
}
