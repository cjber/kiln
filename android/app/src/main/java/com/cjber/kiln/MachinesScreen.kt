package com.cjber.kiln

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
fun MachinesScreen(
    selected: String,
    machines: List<String>,
    status: String,
    select: (Int) -> Unit,
    reconnect: () -> Unit,
    pair: () -> Unit,
    forget: () -> Unit,
) {
    LazyColumn(
        Modifier.widthIn(max = 720.dp).fillMaxWidth(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Text(
                "Machines",
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "Your sessions, wherever you are.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        itemsIndexed(machines) { index, machine ->
            val active = machine == selected
            Card(
                onClick = { select(index) },
                colors =
                    CardDefaults.cardColors(
                        containerColor =
                            if (active) MaterialTheme.colorScheme.secondaryContainer
                            else MaterialTheme.colorScheme.surfaceContainerLow
                    ),
            ) {
                Row(
                    Modifier.padding(20.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Icon(Icons.Default.Settings, null)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(machine, style = MaterialTheme.typography.titleMedium)
                        Text(
                            if (active) status else "Tap to connect",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (active) Icon(Icons.Default.Check, "Selected machine")
                }
            }
        }
        item {
            Button(onClick = pair, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                Icon(Icons.Default.Add, null)
                Spacer(Modifier.width(8.dp))
                Text("Pair a machine")
            }
        }
        item {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Spacer(Modifier.height(16.dp))
            Text("$selected", style = MaterialTheme.typography.titleSmall)
            TextButton(onClick = reconnect) { Text("Reconnect") }
            TextButton(onClick = forget) {
                Text("Forget this machine", color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.height(16.dp))
            Text(
                "Pairing credentials are encrypted on this phone. Forgetting a machine removes its saved connection.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
