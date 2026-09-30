package com.cjber.kiln

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
fun KilnTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme =
            darkColorScheme(
                background = Color.Black,
                surface = Color(0xff101214),
                surfaceContainer = Color(0xff101214),
                primary = Color(0xffc18362),
                onPrimary = Color.Black,
                secondary = Color(0xff82968a),
                onSurface = Color(0xffc8c9cb),
                onBackground = Color(0xffc8c9cb),
                onSurfaceVariant = Color(0xff85898d),
                outline = Color(0xff333638),
            )
    ) {
        Surface(
            Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background,
            content = content,
        )
    }
}

@Composable
fun ErrorNotice(error: String, dismiss: () -> Unit) {
    if (error.isEmpty()) return
    Text(error, color = MaterialTheme.colorScheme.error)
    TextButton(onClick = dismiss) { Text("Dismiss") }
}

/** The paired list screen: machine menu, refresh state, filter, sort and the session list. */
@Composable
fun SessionScreen(
    machineLabel: String,
    machines: List<String>,
    onMachine: (Int) -> Unit,
    onReconnect: () -> Unit,
    onPairAnother: () -> Unit,
    onForget: () -> Unit,
    error: String,
    onDismissError: () -> Unit,
    state: String,
    updated: Long,
    problem: String,
    filter: String,
    onFilter: (String) -> Unit,
    sort: SessionOrder,
    onSort: () -> Unit,
    rows: List<Row>,
    loaded: Boolean,
    now: Long,
    expanded: Set<String>,
    open: (Row) -> Unit,
    details: (Row) -> Unit,
    toggle: (Row) -> Unit,
) {
    Column(
        Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ErrorNotice(error, onDismissError)
        var menu by remember { mutableStateOf(false) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("kiln", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.weight(1f))
            Box {
                TextButton(onClick = { menu = true }) { Text(machineLabel, maxLines = 1) }
                DropdownMenu(menu, { menu = false }) {
                    machines.forEachIndexed { index, name ->
                        DropdownMenuItem(
                            text = { Text(name) },
                            onClick = {
                                onMachine(index)
                                menu = false
                            },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text("Reconnect") },
                        onClick = {
                            onReconnect()
                            menu = false
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Pair another machine") },
                        onClick = {
                            onPairAnother()
                            menu = false
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Forget this machine") },
                        onClick = {
                            onForget()
                            menu = false
                        },
                    )
                }
            }
        }
        Text(
            "$state · refreshed ${updateTime(updated)}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (problem.isNotEmpty())
            Text(
                problem,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        OutlinedTextField(
            filter,
            onFilter,
            placeholder = { Text("Filter sessions", style = MaterialTheme.typography.bodySmall) },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodySmall,
            modifier = Modifier.fillMaxWidth(),
        )
        val items = sessionItems(rows, sort, filter, expanded)
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(
                onClick = onSort,
                contentPadding = PaddingValues(horizontal = 0.dp),
            ) {
                Text(sort.label, style = MaterialTheme.typography.labelMedium)
            }
            Spacer(Modifier.weight(1f))
            Text(
                "${items.count { it is SessionItem.Entry }} shown",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        SessionListView(items, loaded, now, expanded, open, details, toggle)
    }
}

/** The unpaired screen: kiln title, any pairing error and the invitation panel. */
@Composable
fun PairingScreen(
    error: String,
    onDismissError: () -> Unit,
    invitation: String,
    setInvitation: (String) -> Unit,
    busy: Boolean,
    canCancel: Boolean,
    pair: () -> Unit,
    scan: () -> Unit,
    cancel: () -> Unit,
) {
    Column(
        Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("kiln", style = MaterialTheme.typography.titleLarge)
        ErrorNotice(error, onDismissError)
        PairingPanel(invitation, setInvitation, busy, canCancel, pair, scan, cancel)
    }
}

@Composable
fun SessionListView(
    items: List<SessionItem>,
    loaded: Boolean,
    now: Long,
    expanded: Set<String>,
    open: (Row) -> Unit,
    details: (Row) -> Unit,
    toggle: (Row) -> Unit,
) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (items.isEmpty())
            item {
                Text(
                    if (!loaded) "Waiting for the machine…" else "No tasks match",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        items(items, key = { it.key }) { item ->
            when (item) {
                is SessionItem.Header ->
                    if (item.directory != null)
                        Text(
                            tildePath(item.directory),
                            style = MaterialTheme.typography.labelLarge,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 8.dp, bottom = 2.dp),
                        )
                is SessionItem.Entry ->
                    SessionCard(
                        item,
                        now,
                        item.row.id in expanded,
                        open = { open(item.row) },
                        details = { details(item.row) },
                        toggle = { toggle(item.row) },
                    )
            }
        }
    }
}

@Composable
fun PairingPanel(
    invitation: String,
    setInvitation: (String) -> Unit,
    busy: Boolean,
    canCancel: Boolean,
    pair: () -> Unit,
    scan: () -> Unit,
    cancel: () -> Unit,
) {
    Text("Pair a machine", style = MaterialTheme.typography.titleLarge)
    Text(
        "On the machine, run kiln serve and expose it with Tailscale Serve. Run kiln pair with its HTTPS URL, then paste or scan the invitation here."
    )
    OutlinedTextField(
        invitation,
        setInvitation,
        label = { Text("Pairing invitation") },
        modifier = Modifier.fillMaxWidth(),
        maxLines = 4,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(enabled = !busy, onClick = pair) { Text(if (busy) "Pairing…" else "Pair") }
        OutlinedButton(enabled = !busy, onClick = scan) { Text("Scan QR") }
        if (canCancel) TextButton(onClick = cancel) { Text("Cancel") }
    }
}
