package com.cjber.kiln

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionDetails(
    row: Row,
    now: Long,
    dismiss: () -> Unit,
    open: () -> Unit,
    copy: () -> Unit,
    hidden: Boolean,
    changeHidden: () -> Unit,
    /** Sends a prompt and reports the line to show; null where the machine takes none. */
    send: ((String, (String) -> Unit) -> Unit)? = null,
) {
    ModalBottomSheet(
        onDismissRequest = dismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        // The sheet's window picks its bar icons from the system theme; kiln is always dark.
        val view = LocalView.current
        SideEffect {
            (view.parent as? DialogWindowProvider)?.window?.let {
                WindowCompat.getInsetsController(it, view).apply {
                    isAppearanceLightStatusBars = false
                    isAppearanceLightNavigationBars = false
                }
            }
        }
        Column(
            Modifier.fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Text(
                row.title,
                color = activityColor(row.activity),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    agentName(row.agent),
                    style = MaterialTheme.typography.titleMedium,
                    color = agentColor(row.agent),
                )
                Text(
                    activityName(row.activity).lowercase(),
                    style = MaterialTheme.typography.titleMedium,
                    color = activityColor(row.activity),
                )
            }
            SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    if (row.where != Place.CLOUD) DetailField("Directory", tildePath(row.cwd))
                    if (row.branch.isNotBlank()) DetailField("Branch", row.branch)
                    if (row.pulls.isNotEmpty())
                        DetailField(
                            if (row.pulls.size == 1) "Pull request" else "Pull requests",
                            row.pulls.joinToString("\n") { pr ->
                                listOfNotNull(
                                        "${pr.repository} #${pr.number}",
                                        pr.stage.label.lowercase(),
                                        checkCounts(pr).text.ifEmpty { null },
                                        "draft".takeIf { pr.draft },
                                        "queued".takeIf { pr.queued },
                                    )
                                    .joinToString(" · ")
                            },
                        )
                    DetailField(
                        "Location",
                        when (row.where) {
                            Place.CLOUD -> "Cloud task"
                            Place.KILN -> "Managed by kiln"
                            Place.BACKGROUND -> "Native background session"
                            Place.KITTY,
                            Place.ELSEWHERE,
                            Place.OTHER -> "Native terminal"
                        },
                    )
                    DetailField("Last active", lastActive(row.active, row.started, now))
                    DetailField("Started", updateTime(row.started))
                }
            }
            if (row.url != null)
                Button(
                    onClick = open,
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.small,
                ) {
                    Text(row.label)
                }
            else
                Text(
                    row.label,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            val links = LocalUriHandler.current
            // A session can open dozens; the merged and closed ones stay in the list above, without
            // a button.
            row.pulls
                .filter { it.state == "OPEN" }
                .ifEmpty { row.pulls.take(1) }
                .forEach { pr ->
                    OutlinedButton(
                        onClick = { links.openUri(pr.url) },
                        modifier = Modifier.fillMaxWidth(),
                        shape = MaterialTheme.shapes.small,
                        colors =
                            ButtonDefaults.outlinedButtonColors(
                                contentColor = MaterialTheme.colorScheme.onSurface
                            ),
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.onSurfaceVariant),
                    ) {
                        Text(
                            if (row.pulls.size == 1) "Open pull request #${pr.number}"
                            else "Open ${pr.repository} #${pr.number}"
                        )
                    }
                }
            if (send != null) SendBox(row.id, send)
            TextButton(onClick = changeHidden, modifier = Modifier.fillMaxWidth()) {
                Text(if (hidden) "Restore on this phone" else "Hide on this phone")
            }
            // The default outlined colours are the theme's dim variants, which read as disabled.
            OutlinedButton(
                onClick = copy,
                modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp),
                shape = MaterialTheme.shapes.small,
                colors =
                    ButtonDefaults.outlinedButtonColors(
                        contentColor = MaterialTheme.colorScheme.onSurface
                    ),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.onSurfaceVariant),
            ) {
                Text("Copy session ID")
            }
        }
    }
}

@Composable
private fun DetailField(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

/** A prompt for a running session, delivered the way `kiln msg send` delivers it. */
@Composable
private fun SendBox(id: String, send: (String, (String) -> Unit) -> Unit) {
    var text by rememberSaveable(id) { mutableStateOf("") }
    var result by rememberSaveable(id) { mutableStateOf("") }
    var busy by rememberSaveable(id) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = text,
            onValueChange = {
                text = it
                result = ""
            },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Send a prompt") },
            textStyle = MaterialTheme.typography.bodyMedium,
            shape = MaterialTheme.shapes.small,
            maxLines = 6,
        )
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text(
                result,
                style = MaterialTheme.typography.bodySmall,
                color = if (result == "Delivered") Tui.green else Tui.yellow,
                modifier = Modifier.weight(1f),
            )
            Button(
                onClick = {
                    busy = true
                    send(text.trim()) { line ->
                        busy = false
                        result = line
                        if (line == "Delivered" || line.startsWith("Waiting:")) text = ""
                    }
                },
                enabled = !busy && text.isNotBlank(),
                shape = MaterialTheme.shapes.small,
            ) {
                Text(if (busy) "Sending…" else "Send")
            }
        }
    }
}
