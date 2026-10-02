package com.cjber.kiln

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

@Composable
fun ErrorNotice(error: String, dismiss: () -> Unit) {
    if (error.isEmpty()) return
    Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.small) {
        Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                error,
                Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            IconButton(onClick = dismiss) {
                Icon(Icons.Default.Close, "Dismiss error", Modifier.size(18.dp))
            }
        }
    }
}

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
    state: ConnectionState,
    updated: Long,
    problem: String,
    filter: String,
    onFilter: (String) -> Unit,
    sort: SessionOrder,
    onSort: (SessionOrder) -> Unit,
    rows: List<Row>,
    loaded: Boolean,
    now: Long,
    expanded: Set<String>,
    open: (Row) -> Unit,
    details: (Row) -> Unit,
    toggle: (Row) -> Unit,
    hiddenIds: Set<String> = emptySet(),
    changeHidden: (Set<String>) -> Boolean = { false },
    selectedMachine: Int = 0,
) {
    var machinesPage by rememberSaveable { mutableStateOf(false) }
    var scope by rememberSaveable { mutableStateOf(SessionScope.LIVE) }
    var activity by rememberSaveable { mutableStateOf<Activity?>(null) }
    var agent by rememberSaveable { mutableStateOf<Agent?>(null) }
    var options by rememberSaveable { mutableStateOf(false) }
    var searching by rememberSaveable { mutableStateOf(false) }
    var forget by rememberSaveable { mutableStateOf(false) }
    val live = state == ConnectionState.CONNECTED
    val fresh = live && updated > 0 && now - updated < 15_000
    val status =
        when {
            fresh -> "Connected"
            live && updated > 0 -> "Updates delayed"
            state == ConnectionState.CONNECTING -> "Connecting…"
            else -> "Offline"
        }
    val snackbar = remember { SnackbarHostState() }
    val coroutineScope = rememberCoroutineScope()
    val items = sessionItems(rows, sort, filter, expanded, scope, now, agent, activity, hiddenIds)
    val currentHidden by rememberUpdatedState(hiddenIds)
    fun restoreRow(row: Row) {
        changeHidden(currentHidden - sessionRestoreIds(rows, row.id))
    }
    fun hideRow(row: Row) {
        val added = sessionTreeIds(rows, row.id) - currentHidden
        if (changeHidden(currentHidden + added))
            coroutineScope.launch {
                snackbar.currentSnackbarData?.dismiss()
                if (
                    snackbar.showSnackbar(
                        "Session hidden on this phone",
                        "Undo",
                        withDismissAction = true,
                    ) == SnackbarResult.ActionPerformed
                )
                    changeHidden(currentHidden - added)
            }
    }
    BackHandler(machinesPage && !options && !forget) { machinesPage = false }
    if (forget)
        AlertDialog(
            onDismissRequest = { forget = false },
            title = { Text("Forget $machineLabel?") },
            text = { Text("You'll need a new pairing invitation to connect this phone again.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        forget = false
                        onForget()
                    }
                ) {
                    Text("Forget machine")
                }
            },
            dismissButton = { TextButton(onClick = { forget = false }) { Text("Cancel") } },
        )
    if (options)
        ViewOptions(
            sort,
            onSort,
            agent,
            { agent = it },
            activity,
            { activity = it },
            { options = false },
        )
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Row(
                Modifier.fillMaxWidth()
                    .windowInsetsPadding(WindowInsets.statusBars)
                    .heightIn(min = 48.dp)
                    .padding(start = 16.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (machinesPage)
                    IconButton(onClick = { machinesPage = false }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to sessions")
                    }
                else
                    Icon(
                        androidx.compose.ui.res.painterResource(R.drawable.icon),
                        null,
                        modifier = Modifier.size(24.dp),
                        tint = androidx.compose.ui.graphics.Color.Unspecified,
                    )
                Text(
                    "kiln",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(start = 8.dp).weight(1f),
                )
                TextButton(onClick = { machinesPage = !machinesPage }) {
                    Text(
                        machineLabel,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.widthIn(max = 140.dp),
                    )
                    Icon(Icons.Default.KeyboardArrowDown, "Manage machines", Modifier.size(18.dp))
                }
                if (!machinesPage)
                    IconButton(onClick = { searching = !searching }) {
                        Icon(Icons.Default.Search, "Search sessions", Modifier.size(22.dp))
                    }
            }
        },
    ) { padding ->
        Box(
            Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            if (machinesPage)
                MachinesScreen(
                    machineLabel,
                    machines,
                    status,
                    selectedMachine,
                    select = {
                        onMachine(it)
                        machinesPage = false
                    },
                    reconnect = onReconnect,
                    pair = onPairAnother,
                    forget = { forget = true },
                )
            else
                SessionListView(
                    items,
                    loaded,
                    now,
                    expanded,
                    open,
                    details,
                    toggle,
                    Modifier.widthIn(max = 720.dp).fillMaxWidth(),
                    emptyTitle =
                        if (filter.isNotEmpty() || activity != null || agent != null)
                            "No matching sessions"
                        else if (scope == SessionScope.HIDDEN) "Nothing hidden"
                        else if (scope == SessionScope.HISTORY) "No older cloud tasks"
                        else "All quiet here",
                    emptyMessage =
                        if (filter.isNotEmpty() || activity != null || agent != null)
                            "Try another search or clear your filters."
                        else if (scope == SessionScope.HIDDEN)
                            "Swipe a session left to hide it on this phone."
                        else if (scope == SessionScope.HISTORY)
                            "Cloud tasks older than 24 hours appear here."
                        else "Your live sessions and recent cloud tasks will appear here.",
                    clear =
                        if (filter.isNotEmpty() || activity != null || agent != null)
                            ({
                                onFilter("")
                                activity = null
                                agent = null
                            })
                        else null,
                    hidden = scope == SessionScope.HIDDEN,
                    hide = ::hideRow,
                    restore = ::restoreRow,
                    header = {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            ErrorNotice(error, onDismissError)
                            if (problem.isNotBlank())
                                ConnectionNotice("Discovery needs attention", problem, onReconnect)
                            if (!fresh)
                                ConnectionNotice(
                                    status,
                                    if (loaded) "Last update: ${relativeTime(updated, now)}."
                                    else "Waiting for your machine.",
                                    onReconnect,
                                )
                            if (searching || filter.isNotEmpty())
                                OutlinedTextField(
                                    value = filter,
                                    onValueChange = onFilter,
                                    modifier = Modifier.fillMaxWidth(),
                                    placeholder = { Text("Search sessions") },
                                    singleLine = true,
                                    textStyle = MaterialTheme.typography.bodyMedium,
                                    shape = MaterialTheme.shapes.small,
                                    trailingIcon = {
                                        IconButton(
                                            onClick = {
                                                onFilter("")
                                                searching = false
                                            }
                                        ) {
                                            Icon(
                                                Icons.Default.Close,
                                                "Close search",
                                                Modifier.size(20.dp),
                                            )
                                        }
                                    },
                                )
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                SessionScope.entries.forEach { value ->
                                    val count =
                                        sessionItems(
                                                rows,
                                                SessionOrder.RECENT,
                                                "",
                                                rows.mapTo(mutableSetOf()) { it.id },
                                                value,
                                                now,
                                                hiddenIds = hiddenIds,
                                            )
                                            .count { it is SessionItem.Entry }
                                    TextButton(
                                        modifier = Modifier.semantics { selected = scope == value },
                                        onClick = {
                                            scope = value
                                            activity = null
                                        },
                                        colors =
                                            ButtonDefaults.textButtonColors(
                                                contentColor =
                                                    if (scope == value)
                                                        MaterialTheme.colorScheme.primary
                                                    else MaterialTheme.colorScheme.onSurfaceVariant
                                            ),
                                    ) {
                                        Text(
                                            "${value.label} $count",
                                            fontWeight =
                                                if (scope == value) FontWeight.Bold
                                                else FontWeight.Normal,
                                        )
                                    }
                                }
                                Spacer(Modifier.weight(1f))
                                IconButton(onClick = { options = true }) {
                                    BadgedBox(
                                        badge = { if (agent != null || activity != null) Badge() }
                                    ) {
                                        Icon(
                                            Icons.Default.MoreVert,
                                            "Filter and sort sessions: ${sort.label}",
                                            Modifier.size(20.dp),
                                        )
                                    }
                                }
                            }
                        }
                    },
                )
        }
    }
}

@Composable
fun ConnectionNotice(title: String, message: String, retry: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.small,
    ) {
        Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.labelLarge)
                Text(
                    message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = retry) {
                Icon(Icons.Default.Refresh, "Reconnect", Modifier.size(20.dp))
            }
        }
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
    modifier: Modifier,
    emptyTitle: String,
    emptyMessage: String,
    clear: (() -> Unit)?,
    header: @Composable () -> Unit,
    hidden: Boolean,
    hide: (Row) -> Unit,
    restore: (Row) -> Unit,
) {
    LazyColumn(
        modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        item(key = "controls") { header() }
        if (items.isEmpty())
            item {
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 32.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (!loaded) CircularProgressIndicator(Modifier.size(24.dp))
                    else
                        Icon(
                            Icons.AutoMirrored.Filled.List,
                            null,
                            modifier = Modifier.size(28.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    Text(
                        if (!loaded) "Connecting to your machine" else emptyTitle,
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        if (!loaded) "Sessions will appear when the connection is ready."
                        else emptyMessage,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (clear != null) TextButton(onClick = clear) { Text("Clear filters") }
                }
            }
        items(items, key = { it.key }) { item ->
            when (item) {
                is SessionItem.Header ->
                    if (item.directory != null)
                        Text(
                            tildePath(item.directory),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(start = 4.dp, top = 8.dp, bottom = 4.dp),
                        )
                is SessionItem.Entry ->
                    SwipeSessionRow(
                        item,
                        now,
                        item.row.id in expanded,
                        { open(item.row) },
                        { details(item.row) },
                        { toggle(item.row) },
                        hidden,
                        { hide(item.row) },
                        { restore(item.row) },
                    )
            }
        }
    }
}
