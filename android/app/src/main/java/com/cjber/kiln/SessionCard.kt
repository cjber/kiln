package com.cjber.kiln

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

fun updateTime(time: Long): String =
    if (time > 0)
        DateTimeFormatter.ofPattern("d MMM, HH:mm")
            .withZone(ZoneId.systemDefault())
            .format(Instant.ofEpochMilli(time))
    else "Unknown"

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

/** A session with no activity time shows when it started instead, labelled as the start. */
fun lastActive(active: Long, started: Long, now: Long): String =
    when {
        active > 0 -> "${relativeTime(active, now)} · ${updateTime(active)}"
        started > 0 -> "Unknown, started ${relativeTime(started, now).lowercase()}"
        else -> "Unknown"
    }

fun tildePath(path: String): String = path.replace(Regex("^/(home|Users)/[^/]+(?=/|$)"), "~")

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
    val status = activityColor(row.activity)
    val place =
        if (row.where == Place.CLOUD) "cloud"
        else row.branch.ifBlank { row.cwd.trimEnd('/').substringAfterLast('/') }
    Row(
        modifier =
            Modifier.fillMaxWidth()
                .background(MaterialTheme.colorScheme.background)
                .heightIn(min = 48.dp)
                .combinedClickable(
                    onClick = open,
                    onLongClickLabel = "Details",
                    onLongClick = details,
                )
                .padding(start = 4.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            agentName(row.agent),
            color = agentColor(row.agent),
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            modifier = Modifier.width(84.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                (if (item.depth > 0) "↳ " else "") + row.title,
                color = status,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(color = status)) {
                        append(activityName(row.activity).lowercase())
                    }
                    if (place.isNotBlank()) append("  $place")
                },
                style = MaterialTheme.typography.labelSmall,
                color = Tui.comment,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (item.children > 0)
            Text(
                "[${if (expanded) "−" else "+"}${item.children}]",
                style = MaterialTheme.typography.bodyMedium,
                color = Tui.fgDim,
                modifier =
                    Modifier.clip(MaterialTheme.shapes.small)
                        .clickable(
                            onClickLabel = if (expanded) "Collapse helpers" else "Show helpers",
                            onClick = toggle,
                        )
                        .padding(horizontal = 6.dp),
            )
        Text(
            if (row.active > 0) elapsed(row.active, now) else "",
            style = MaterialTheme.typography.bodyMedium,
            color = Tui.comment,
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}
