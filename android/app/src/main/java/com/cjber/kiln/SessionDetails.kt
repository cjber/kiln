package com.cjber.kiln

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
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
                    DetailField(
                        "Last active",
                        "${relativeTime(row.active, now)} · ${updateTime(row.active)}",
                    )
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
            TextButton(onClick = changeHidden, modifier = Modifier.fillMaxWidth()) {
                Text(if (hidden) "Restore on this phone" else "Hide on this phone")
            }
            OutlinedButton(
                onClick = copy,
                modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp),
                shape = MaterialTheme.shapes.small,
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
