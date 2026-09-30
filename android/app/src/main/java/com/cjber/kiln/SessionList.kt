package com.cjber.kiln

enum class SessionOrder(val label: String) {
    PROJECT("Directory / task"),
    RECENT("Last active"),
    AGE("Age"),
    HARNESS("Harness"),
    DIRECTORY("Full directory"),
}

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
): List<SessionItem> {
    val byId = rows.associateBy { it.id }
    fun canShow(row: Row, seen: Set<String> = emptySet()): Boolean {
        if (row.where != "elsewhere" || row.url != null) return true
        if (row.id in seen) return false
        return byId[row.parent]?.let { canShow(it, seen + row.id) } ?: false
    }
    val eligible = rows.filter { canShow(it) }
    val parents = eligible.associate { it.id to eligible.find { parent -> parent.id == it.parent } }
    val matching =
        eligible
            .filter { row ->
                listOf(row.title, row.cwd, row.agent, row.branch, row.activity).any {
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
        if (row.where == "cloud") row.title
        else row.cwd.trimEnd('/').substringAfterLast('/').ifEmpty { row.cwd }
    val comparator =
        when (order) {
            SessionOrder.PROJECT ->
                compareBy<Row> { groupName(it).lowercase() }
                    .thenBy { it.cwd }
                    .thenByDescending { it.active }
            SessionOrder.DIRECTORY ->
                compareBy<Row> { if (it.where == "cloud") it.title else it.cwd }
                    .thenByDescending { it.active }
            SessionOrder.RECENT -> compareByDescending<Row> { it.active }
            SessionOrder.AGE -> compareBy { it.started }
            SessionOrder.HARNESS -> compareBy<Row> { it.agent }.thenByDescending { it.active }
        }
    val grouped = order == SessionOrder.PROJECT || order == SessionOrder.DIRECTORY
    val groups =
        roots.sortedWith(comparator).groupBy {
            if (!grouped) "all" else if (it.where == "cloud") "task:${it.id}" else "dir:${it.cwd}"
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
        if (row.id in expanded || filter.isNotBlank()) children.forEach { append(it, depth + 1) }
    }
    groups.forEach { (key, group) ->
        if (grouped) {
            val first = group.first()
            result.add(
                SessionItem.Header(
                    key,
                    groupName(first),
                    first.cwd.takeIf { first.where != "cloud" },
                )
            )
        }
        group.forEach { append(it, 0) }
    }
    return result
}
