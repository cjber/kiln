package com.cjber.kiln

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

fun updateTime(time: Long): String =
    if (time > 0)
        DateTimeFormatter.ofPattern("HH:mm:ss")
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
    val statusColor =
        when (row.activity) {
            "working" -> Color(0xff85a078)
            "waiting" -> Color(0xffd4ae78)
            "idle" -> Color(0xff8c8f92)
            else -> Color(0xff64676b)
        }
    Card(
        onClick = details,
        modifier = Modifier.fillMaxWidth().padding(start = if (item.depth > 0) 12.dp else 0.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xff101214)),
    ) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Text(
                row.title,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.primary,
            )
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text(
                    "${row.activity} · ${elapsed(row.active, now)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = statusColor,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
                if (item.children > 0)
                    TextButton(
                        onClick = toggle,
                        contentPadding = PaddingValues(horizontal = 6.dp),
                    ) {
                        Text(
                            "${if (expanded) "−" else "+"}${item.children}",
                            modifier =
                                Modifier.semantics {
                                    contentDescription =
                                        "${if (expanded) "Collapse" else "Expand"} ${item.children} child sessions"
                                },
                        )
                    }
                if (row.url != null || row.piRemote)
                    TextButton(onClick = open, contentPadding = PaddingValues(horizontal = 6.dp)) {
                        Text("Open")
                    }
            }
        }
    }
}
