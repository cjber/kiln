package com.cjber.kiln

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PiConversation(
    machine: String,
    title: String,
    state: PiSnapshot?,
    connected: Boolean,
    error: String,
    prompt: String,
    onPrompt: (String) -> Unit,
    busy: Boolean,
    onCommand: (String) -> Unit,
    close: () -> Unit,
) {
    BackHandler { close() }
    val listState = rememberLazyListState()
    val messages = state?.messages.orEmpty()
    LaunchedEffect(messages) {
        if (messages.isNotEmpty() && !listState.canScrollForward)
            listState.animateScrollToItem(messages.lastIndex)
    }
    val writable = connected && !busy && state?.blocked != true && state?.activity == "idle"
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            state?.title?.takeIf { it.isNotBlank() } ?: title,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            "Pi · $machine",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = close) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to sessions")
                    }
                },
            )
        }
    ) { padding ->
        Box(
            Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(Modifier.widthIn(max = 720.dp).fillMaxWidth()) {
                Column(
                    Modifier.padding(horizontal = 20.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        ActivityBadge(if (connected) state?.activity.orEmpty() else "unknown")
                        Text(
                            if (connected) "Connected" else "Reconnecting…",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (error.isNotEmpty())
                        Text(
                            error,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    if (state?.blocked == true)
                        Text(
                            "Another phone controls this session. You can still read it.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    Text(
                        state?.notice?.takeIf { it.isNotBlank() }
                            ?: "Answer extension dialogs on your computer.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                LazyColumn(
                    Modifier.weight(1f).fillMaxWidth(),
                    state = listState,
                    contentPadding = PaddingValues(20.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    if (messages.isEmpty())
                        item {
                            Text(
                                "The conversation will appear here.",
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    itemsIndexed(messages) { _, message ->
                        val user = message.role == "user"
                        Surface(
                            modifier =
                                Modifier.fillMaxWidth()
                                    .padding(
                                        start = if (user) 32.dp else 0.dp,
                                        end = if (user) 0.dp else 16.dp,
                                    ),
                            shape = MaterialTheme.shapes.medium,
                            color =
                                if (user) MaterialTheme.colorScheme.primaryContainer
                                else MaterialTheme.colorScheme.surfaceContainerLow,
                        ) {
                            Column(
                                Modifier.padding(16.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(
                                    if (user) "You"
                                    else if (message.role == "assistant") "Pi" else message.role,
                                    style = MaterialTheme.typography.labelLarge,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                SelectionContainer {
                                    Text(message.text, style = MaterialTheme.typography.bodyLarge)
                                }
                            }
                        }
                    }
                }
                Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
                    Column(
                        Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (state?.activity == "working")
                            Row(
                                Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    "Pi is working…",
                                    style = MaterialTheme.typography.labelMedium,
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(
                                    onClick = { onCommand("abort") },
                                    enabled = connected && !busy && state.blocked != true,
                                ) {
                                    Text("Stop turn")
                                }
                            }
                        Row(
                            verticalAlignment = Alignment.Bottom,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            OutlinedTextField(
                                prompt,
                                { if (it.toByteArray(Charsets.UTF_8).size <= 3500) onPrompt(it) },
                                modifier = Modifier.weight(1f),
                                placeholder = { Text("Message Pi") },
                                maxLines = 4,
                                shape = MaterialTheme.shapes.medium,
                            )
                            FilledIconButton(
                                onClick = { onCommand("prompt") },
                                enabled = writable && prompt.isNotBlank(),
                                modifier = Modifier.size(56.dp),
                            ) {
                                if (busy)
                                    CircularProgressIndicator(
                                        Modifier.size(20.dp),
                                        strokeWidth = 2.dp,
                                    )
                                else Icon(Icons.AutoMirrored.Filled.Send, "Send message")
                            }
                        }
                    }
                }
            }
        }
    }
}
