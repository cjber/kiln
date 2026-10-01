package com.cjber.kiln

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

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
        Column(
            Modifier.fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Text(
                row.title,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(agentName(row.agent), style = MaterialTheme.typography.titleMedium)
                ActivityBadge(row.activity)
            }
            SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    if (row.where != "cloud") DetailField("Directory", tildePath(row.cwd))
                    if (row.branch.isNotBlank()) DetailField("Branch", row.branch)
                    DetailField(
                        "Location",
                        when (row.where) {
                            "cloud" -> "Cloud task"
                            "acp",
                            "kiln" -> "Managed by kiln"
                            "background" -> "Native background session"
                            else -> "Native terminal"
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
                Button(onClick = open, modifier = Modifier.fillMaxWidth()) {
                    Text(
                        if (row.exact) "Open in ${agentName(row.agent)}"
                        else "Find in ${agentName(row.agent)}"
                    )
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
