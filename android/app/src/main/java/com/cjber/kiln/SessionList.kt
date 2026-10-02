package com.cjber.kiln

enum class SessionOrder(val label: String) {
    PROJECT("Project"),
    RECENT("Last active"),
    AGE("Oldest first"),
    HARNESS("Agent"),
    DIRECTORY("Directory"),
}

enum class SessionScope(val label: String) {
    LIVE("Live"),
    HISTORY("History"),
    HIDDEN("Hidden"),
}

fun isCurrentSession(row: Row, now: Long): Boolean =
    when (row.activity) {
        Activity.WORKING,
        Activity.WAITING -> true
        Activity.IDLE,
        Activity.UNKNOWN -> row.where != Place.CLOUD || isRecent(row, now)
        Activity.COMPLETED,
        Activity.STOPPED -> isRecent(row, now)
    }

private fun isRecent(row: Row, now: Long): Boolean =
    (row.active.takeIf { it > 0 } ?: row.started).let { it > 0 && now - it < 86_400_000 }

sealed interface SessionItem {
    val key: String

    data class Header(override val key: String, val name: String, val directory: String?) :
        SessionItem

    data class Entry(val row: Row, val depth: Int, val children: Int) : SessionItem {
        override val key = row.id
    }
}

fun sessionItems(
    rows: List<Row>,
    order: SessionOrder,
    filter: String,
    expanded: Set<String>,
    scope: SessionScope? = null,
    now: Long = System.currentTimeMillis(),
    agent: Agent? = null,
    activity: Activity? = null,
    hiddenIds: Set<String> = emptySet(),
): List<SessionItem> {
    val byId = rows.associateBy { it.id }
    fun canShow(row: Row, seen: Set<String> = emptySet()): Boolean {
        if (row.where != Place.ELSEWHERE || row.url != null) return true
        if (row.id in seen) return false
        return byId[row.parent]?.let { canShow(it, seen + row.id) } ?: false
    }
    val hidden = hiddenSessionIds(rows, hiddenIds)
    val eligible = rows.filter {
        canShow(it) && ((it.id in hidden) == (scope == SessionScope.HIDDEN))
    }
    val parents = eligible.associate { it.id to eligible.find { parent -> parent.id == it.parent } }
    val matching =
        eligible
            .filter { row ->
                (when (scope) {
                    null,
                    SessionScope.HIDDEN -> true
                    SessionScope.LIVE -> isCurrentSession(row, now)
                    SessionScope.HISTORY -> !isCurrentSession(row, now)
                }) &&
                    (agent == null || row.agent == agent) &&
                    (activity == null || row.activity == activity)
            }
            .filter { row ->
                listOf(row.title, row.cwd, row.agent.id, row.branch, row.activity.id).any {
                    it.contains(filter, ignoreCase = true)
                }
            }
            .map { it.id }
            .toMutableSet()
    matching.toList().forEach { id ->
        var parent = parents[id]
        val seen = mutableSetOf<String>()
        while (parent != null && seen.add(parent.id)) {
            matching.add(parent.id)
            parent = parents[parent.id]
        }
    }
    val roots = eligible.filter { parents[it.id] == null && it.id in matching }
    fun groupName(row: Row) =
        if (row.where == Place.CLOUD) row.title
        else row.cwd.trimEnd('/').substringAfterLast('/').ifEmpty { row.cwd }
    val comparator =
        when (order) {
            SessionOrder.PROJECT ->
                compareBy<Row> { groupName(it).lowercase() }
                    .thenBy { it.cwd }
                    .thenByDescending { it.active }
            SessionOrder.DIRECTORY ->
                compareBy<Row> { if (it.where == Place.CLOUD) it.title else it.cwd }
                    .thenByDescending { it.active }
            SessionOrder.RECENT -> compareByDescending<Row> { it.active }
            SessionOrder.AGE -> compareBy { it.started }
            SessionOrder.HARNESS -> compareBy<Row> { it.agent.id }.thenByDescending { it.active }
        }
    val grouped = order == SessionOrder.PROJECT || order == SessionOrder.DIRECTORY
    val groups =
        roots.sortedWith(comparator).groupBy {
            if (!grouped) "all"
            else if (it.where == Place.CLOUD) "task:${it.id}" else "dir:${it.cwd}"
        }
    val result = mutableListOf<SessionItem>()
    val seen = mutableSetOf<String>()
    fun append(row: Row, depth: Int) {
        if (row.id !in matching || !seen.add(row.id)) return
        val children =
            eligible
                .filter { parents[it.id]?.id == row.id && it.id in matching }
                .sortedByDescending { it.active }
        result.add(SessionItem.Entry(row, depth, children.size))
        if (row.id in expanded || filter.isNotBlank() || activity != null || agent != null)
            children.forEach { append(it, depth + 1) }
    }
    groups.forEach { (key, group) ->
        if (grouped) {
            val first = group.first()
            result.add(
                SessionItem.Header(
                    key,
                    groupName(first),
                    first.cwd.takeIf { first.where != Place.CLOUD },
                )
            )
        }
        group.forEach { append(it, 0) }
    }
    return result
}

fun sessionTreeIds(rows: List<Row>, id: String): Set<String> {
    val ids = mutableSetOf(id)
    fun append(parent: String) {
        rows.filter { it.parent == parent }.forEach { if (ids.add(it.id)) append(it.id) }
    }
    append(id)
    return ids
}

fun hiddenSessionIds(rows: List<Row>, hiddenIds: Set<String>): Set<String> =
    hiddenIds.flatMapTo(mutableSetOf()) { sessionTreeIds(rows, it) }

fun sessionRestoreIds(rows: List<Row>, id: String): Set<String> {
    val ids = sessionTreeIds(rows, id).toMutableSet()
    val byId = rows.associateBy { it.id }
    var parent = byId[id]?.parent
    while (parent != null && ids.add(parent)) parent = byId[parent]?.parent
    return ids
}
