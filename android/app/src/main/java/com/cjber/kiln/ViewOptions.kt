package com.cjber.kiln

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ViewOptions(
    sort: SessionOrder,
    onSort: (SessionOrder) -> Unit,
    agent: Agent?,
    onAgent: (Agent?) -> Unit,
    activity: Activity?,
    onActivity: (Activity?) -> Unit,
    dismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = dismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            Modifier.fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("View options", style = MaterialTheme.typography.headlineSmall)
            Text("Agent", style = MaterialTheme.typography.titleSmall)
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                (listOf(null) + Agent.entries).forEach { value ->
                    FilterChip(
                        selected = agent == value,
                        onClick = { onAgent(value) },
                        label = { Text(value?.let(::agentName) ?: "All") },
                    )
                }
            }
            Text("Activity", style = MaterialTheme.typography.titleSmall)
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf(null, Activity.WORKING, Activity.WAITING, Activity.IDLE).forEach { value ->
                    FilterChip(
                        selected = activity == value,
                        onClick = { onActivity(value) },
                        label = { Text(value?.let(::activityName) ?: "All") },
                    )
                }
            }
            Text("Sort by", style = MaterialTheme.typography.titleSmall)
            SessionOrder.entries.forEach { order ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = sort == order, onClick = { onSort(order) })
                    TextButton(onClick = { onSort(order) }, modifier = Modifier.weight(1f)) {
                        Text(
                            order.label,
                            Modifier.fillMaxWidth(),
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
            Text(
                "Live includes local sessions, working or waiting cloud tasks, and cloud tasks updated in the last 24 hours. Older cloud tasks stay in History.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = dismiss, modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
                Text("Done")
            }
        }
    }
}
