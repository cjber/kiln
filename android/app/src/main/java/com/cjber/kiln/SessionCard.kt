package com.cjber.kiln

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

fun updateTime(time: Long): String =
    if (time > 0)
        DateTimeFormatter.ofPattern("d MMM, HH:mm")
            .withZone(ZoneId.systemDefault())
            .format(Instant.ofEpochMilli(time))
    else "unknown"

fun elapsed(time: Long, now: Long): String {
    if (time <= 0) return "unknown"
    val seconds = ((now - time) / 1000).coerceAtLeast(0)
    return when {
        seconds < 60 -> "${seconds}s"
        seconds < 3600 -> "${seconds / 60}m"
        seconds < 86400 -> "${seconds / 3600}h"
        else -> "${seconds / 86400}d"
    }
}

fun relativeTime(time: Long, now: Long): String =
    when {
        time <= 0 -> "Activity unknown"
        now - time < 60_000 -> "Just now"
        else -> "${elapsed(time, now)} ago"
    }

fun tildePath(path: String): String = path.replace(Regex("^/(home|Users)/[^/]+(?=/|$)"), "~")

@Composable
fun AgentMark(agent: Agent, modifier: Modifier = Modifier) {
    when (agent) {
        Agent.CLAUDE,
        Agent.CODEX ->
            Icon(
                painter =
                    androidx.compose.ui.res.painterResource(
                        if (agent == Agent.CLAUDE) R.drawable.agent_claude
                        else R.drawable.agent_codex
                    ),
                contentDescription = agentName(agent),
                modifier = modifier.size(22.dp),
                tint =
                    if (agent == Agent.CLAUDE) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurface,
            )
        Agent.PI ->
            Box(modifier.size(22.dp), contentAlignment = Alignment.Center) {
                Text(
                    "π",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.semantics { contentDescription = "Pi" },
                )
            }
    }
}

@Composable
fun ActivityBadge(activity: Activity) {
    val color = activityColor(activity)
    Surface(shape = CircleShape, color = color.copy(alpha = 0.12f), contentColor = color) {
        Row(
            Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Surface(Modifier.size(6.dp), shape = CircleShape, color = color) {}
            Text(activityName(activity), style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
fun SessionCard(
    item: SessionItem.Entry,
    now: Long,
    expanded: Boolean,
    open: () -> Unit,
    details: () -> Unit,
    toggle: () -> Unit,
    restore: (() -> Unit)?,
) {
    val row = item.row
    val openable = row.url != null
    Card(
        onClick = if (openable) open else details,
        modifier = Modifier.fillMaxWidth().padding(start = if (item.depth > 0) 16.dp else 0.dp),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
        colors =
            CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    ) {
        Row(
            Modifier.fillMaxWidth()
                .heightIn(min = 60.dp)
                .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AgentMark(row.agent)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    row.title,
                    color = activityColor(row.activity),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        activityName(row.activity),
                        style = MaterialTheme.typography.labelSmall,
                        color = activityColor(row.activity),
                    )
                    Text(
                        if (row.where == Place.CLOUD) "Cloud"
                        else
                            listOf(
                                    row.cwd.trimEnd('/').substringAfterLast('/'),
                                    row.branch.takeIf { it.isNotBlank() },
                                )
                                .filterNotNull()
                                .joinToString(" / "),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            Text(
                if (row.active > 0) elapsed(row.active, now) else "?",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier =
                    Modifier.semantics { contentDescription = relativeTime(row.active, now) },
            )
            if (item.children > 0)
                TextButton(
                    onClick = toggle,
                    contentPadding = PaddingValues(0.dp),
                    modifier = Modifier.size(48.dp),
                ) {
                    Text(item.children.toString(), style = MaterialTheme.typography.labelSmall)
                    Icon(
                        if (expanded) Icons.Default.KeyboardArrowDown
                        else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        "${if (expanded) "Collapse" else "Expand"} ${item.children} subagents",
                        modifier = Modifier.size(20.dp),
                    )
                }
            if (restore != null)
                IconButton(onClick = restore, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.Default.Check, "Restore ${row.title}", Modifier.size(20.dp))
                }
            IconButton(onClick = details, modifier = Modifier.size(48.dp)) {
                Icon(
                    Icons.Default.Info,
                    "Details for ${row.title}",
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
