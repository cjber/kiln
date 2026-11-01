package com.cjber.kiln

import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
        Agent.OPENCODE,
        Agent.PI ->
            Box(modifier.size(22.dp), contentAlignment = Alignment.Center) {
                Text(
                    if (agent == Agent.PI) "π" else "O",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.semantics { contentDescription = agentName(agent) },
                )
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
) {
    val row = item.row
    val openable = row.url != null
    Row(
        modifier =
            Modifier.fillMaxWidth()
                .heightIn(min = 44.dp)
                .combinedClickable(
                    onClick = { if (openable) open() else details() },
                    onLongClickLabel = "Details",
                    onLongClick = details,
                )
                .padding(start = if (item.depth > 0) 20.dp else 0.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        AgentMark(row.agent, Modifier.size(18.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                row.title,
                color = activityColor(row.activity),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                listOfNotNull(
                        if (row.where == Place.CLOUD) "Cloud"
                        else
                            listOf(
                                    row.cwd.trimEnd('/').substringAfterLast('/'),
                                    row.branch.takeIf { it.isNotBlank() },
                                )
                                .filterNotNull()
                                .joinToString(" / ")
                                .takeIf { it.isNotBlank() },
                        activityName(row.activity),
                        if (row.active > 0) elapsed(row.active, now) else null,
                    )
                    .joinToString("  ·  "),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (item.children > 0)
            Row(
                modifier =
                    Modifier.clip(RoundedCornerShape(6.dp))
                        .clickable(onClick = toggle)
                        .padding(horizontal = 6.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    item.children.toString(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Icon(
                    if (expanded) Icons.Default.KeyboardArrowDown
                    else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    null,
                    Modifier.size(14.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
    }
}
