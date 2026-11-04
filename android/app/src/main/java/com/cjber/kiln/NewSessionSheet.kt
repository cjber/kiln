package com.cjber.kiln

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** The directories whose path contains every word of `query`, keeping the machine's order. */
fun matchingDirectories(directories: List<String>, query: String): List<String> {
    val words = query.lowercase().split(' ').filter { it.isNotBlank() }
    return directories.filter { path -> words.all { it in path.lowercase() } }
}

/**
 * Starts a session on the machine. The session runs there, with the provider's remote control on;
 * the phone follows it through the session's handoff link rather than a transcript of its own.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewSessionSheet(
    options: StartOptions?,
    problem: String,
    busy: Boolean,
    dismiss: () -> Unit,
    start: (Agent, String, String) -> Unit,
) {
    var agent by rememberSaveable { mutableStateOf<Agent?>(null) }
    var directory by rememberSaveable { mutableStateOf<String?>(null) }
    var search by rememberSaveable { mutableStateOf("") }
    var prompt by rememberSaveable { mutableStateOf("") }
    val chosen = agent ?: options?.agents?.firstOrNull()
    ModalBottomSheet(
        onDismissRequest = dismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            Modifier.fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp)
                .padding(bottom = 24.dp)
                .imePadding(),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                "New session",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
            )
            if (options == null) {
                if (problem.isNotEmpty()) Text(problem, color = MaterialTheme.colorScheme.error)
                else LinearProgressIndicator(Modifier.fillMaxWidth())
                return@Column
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                options.agents.forEach { value ->
                    FilterChip(
                        selected = chosen == value,
                        onClick = { agent = value },
                        label = { Text(agentName(value), color = agentColor(value)) },
                        modifier = Modifier.semantics { selected = chosen == value },
                    )
                }
            }
            OutlinedTextField(
                value = search,
                onValueChange = { search = it },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("Search directories") },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium,
                shape = MaterialTheme.shapes.small,
            )
            val shown = matchingDirectories(options.directories, search)
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                shape = MaterialTheme.shapes.small,
            ) {
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 220.dp)) {
                    if (shown.isEmpty())
                        item {
                            Text(
                                if (options.directories.isEmpty())
                                    "No directories yet. Open one in kiln on the computer first."
                                else "No matching directories",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(12.dp),
                            )
                        }
                    items(shown, key = { it }) { path ->
                        Text(
                            tildePath(path),
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (path == directory) Tui.peach else Tui.fg,
                            fontWeight =
                                if (path == directory) FontWeight.SemiBold else FontWeight.Normal,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier =
                                Modifier.fillMaxWidth()
                                    .semantics { selected = path == directory }
                                    .clickable { directory = path }
                                    .padding(horizontal = 12.dp, vertical = 10.dp),
                        )
                    }
                }
            }
            OutlinedTextField(
                value = prompt,
                onValueChange = { prompt = it },
                modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp),
                placeholder = { Text("What should it do?") },
                textStyle = MaterialTheme.typography.bodyMedium,
                shape = MaterialTheme.shapes.small,
            )
            if (problem.isNotEmpty()) Text(problem, color = MaterialTheme.colorScheme.error)
            Button(
                onClick = {
                    val path = directory ?: return@Button
                    start(chosen ?: return@Button, path, prompt.trim())
                },
                enabled = !busy && chosen != null && directory != null && prompt.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.small,
            ) {
                Text(if (busy) "Starting…" else "Start")
            }
            Text(
                "It runs on the computer with the provider's remote control on. " +
                    "Open it from its details once it is listed.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
