package com.cjber.kiln

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
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
    tailscaleOn: Boolean = true,
    openTailscale: () -> Unit = {},
    notify: Boolean = false,
    onNotify: (Boolean) -> Unit = {},
    push: Boolean = false,
    onPush: (Boolean) -> Unit = {},
    openNotificationSettings: () -> Unit = {},
    /** Opens the new-session sheet; null when the machine takes no sessions from the phone. */
    onNewSession: (() -> Unit)? = null,
    /** A row to bring into view, such as the session this phone just started. */
    scrollTo: String? = null,
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
    val needsInput = rows.count { it.activity == Activity.WAITING && it.id !in hiddenIds }
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
        floatingActionButton = {
            if (onNewSession != null && !machinesPage)
                ExtendedFloatingActionButton(
                    onClick = onNewSession,
                    icon = { Icon(Icons.Default.Add, null) },
                    text = { Text("New session") },
                )
        },
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
                    buildAnnotatedString {
                        withStyle(SpanStyle(color = Tui.fgBright, fontWeight = FontWeight.Bold)) {
                            append("kiln")
                        }
                        if (needsInput > 0)
                            withStyle(SpanStyle(color = Tui.yellow)) {
                                append("  $needsInput need input")
                            }
                    },
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
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
                    notify = notify,
                    setNotify = onNotify,
                    push = push,
                    setPush = onPush,
                    openNotificationSettings = openNotificationSettings,
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
                    scrollTo = scrollTo,
                    // Room for the last row to scroll clear of the new-session button.
                    bottom = if (onNewSession != null) 88.dp else 12.dp,
                    header = {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            ErrorNotice(error, onDismissError)
                            if (problem.isNotBlank())
                                ConnectionNotice("Discovery needs attention", problem, onReconnect)
                            if (state != ConnectionState.CONNECTED && !tailscaleOn)
                                ConnectionNotice(
                                    "Tailscale is off",
                                    "Turn on Tailscale on this phone to reach $machineLabel. " +
                                        "kiln reconnects as soon as it is on.",
                                    onReconnect,
                                    "Open Tailscale" to openTailscale,
                                )
                            else if (state == ConnectionState.DISCONNECTED)
                                ConnectionNotice(
                                    "$machineLabel is not answering",
                                    "Check that it is awake and kiln serve is running." +
                                        if (loaded) " Last update: ${relativeTime(updated, now)}."
                                        else "",
                                    onReconnect,
                                )
                            else if (state != ConnectionState.CONNECTED)
                                ConnectionNotice(
                                    status,
                                    if (loaded) "Last update: ${relativeTime(updated, now)}."
                                    else "Waiting for $machineLabel.",
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
                                    TextButton(
                                        modifier = Modifier.semantics { selected = scope == value },
                                        onClick = {
                                            scope = value
                                            activity = null
                                        },
                                        colors =
                                            ButtonDefaults.textButtonColors(
                                                contentColor =
                                                    if (scope == value) Tui.peach else Tui.comment
                                            ),
                                    ) {
                                        Text(
                                            value.label.lowercase(),
                                            fontWeight =
                                                if (scope == value) FontWeight.SemiBold
                                                else FontWeight.Normal,
                                        )
                                    }
                                }
                                Spacer(Modifier.weight(1f))
                                IconButton(onClick = { options = true }) {
                                    Icon(
                                        Icons.Default.MoreVert,
                                        "Filter and sort sessions: ${sort.label}",
                                        Modifier.size(20.dp),
                                    )
                                }
                            }
                        }
                    },
                )
        }
    }
}

@Composable
fun ConnectionNotice(
    title: String,
    message: String,
    retry: (() -> Unit)?,
    action: Pair<String, () -> Unit>? = null,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.small,
    ) {
        Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
                Text(title, style = MaterialTheme.typography.labelLarge, color = Tui.peach)
                Text(
                    message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (action != null)
                    TextButton(
                        onClick = action.second,
                        contentPadding = PaddingValues(horizontal = 0.dp),
                    ) {
                        Text(action.first)
                    }
            }
            if (retry != null)
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
    scrollTo: String? = null,
    bottom: androidx.compose.ui.unit.Dp = 12.dp,
) {
    val list = rememberLazyListState()
    LaunchedEffect(scrollTo, items.isNotEmpty()) {
        val index = items.indexOfFirst { it is SessionItem.Entry && it.row.id == scrollTo }
        // The controls header is the list's first item.
        if (index >= 0) list.animateScrollToItem(index + 1)
    }
    LazyColumn(
        modifier.fillMaxSize(),
        state = list,
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = bottom),
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
                        textAlign = TextAlign.Center,
                    )
                    Text(
                        if (!loaded) "Sessions will appear when the connection is ready."
                        else emptyMessage,
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
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
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Bold,
                            color = Tui.orange,
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
