package com.cjber.kiln

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {
    private var foreground by mutableStateOf(false)

    override fun onStart() {
        super.onStart()
        foreground = true
    }

    override fun onStop() {
        foreground = false
        super.onStop()
    }

    private var incoming by mutableStateOf("")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        incoming = intent.dataString.orEmpty()
        setContent {
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
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Kiln()
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        incoming = intent.dataString.orEmpty()
    }

    private fun copyId(row: Row) {
        getSystemService(ClipboardManager::class.java)
            .setPrimaryClip(ClipData.newPlainText("kiln session", row.id.substringAfter(':')))
    }

    private fun openSession(row: Row, error: (String) -> Unit) {
        val url = row.url ?: return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)))
        } catch (_: android.content.ActivityNotFoundException) {
            error("Install the provider app or a browser to open this session")
        }
    }

    @Composable
    private fun Kiln() {
        val credentials = remember { Credentials(this) }
        var error by remember { mutableStateOf("") }
        var hosts by remember {
            mutableStateOf(
                try {
                    credentials.read()
                } catch (_: Exception) {
                    error = "Saved credentials cannot be read. Pair this machine again."
                    emptyList()
                }
            )
        }
        var selected by remember { mutableStateOf(hosts.firstOrNull()?.origin) }
        var pairing by remember { mutableStateOf(hosts.isEmpty()) }
        var invitation by remember { mutableStateOf(incoming) }
        var pairingBusy by remember { mutableStateOf(false) }
        var filter by remember { mutableStateOf("") }
        var sort by remember { mutableStateOf(SessionOrder.PROJECT) }
        var expanded by remember { mutableStateOf(emptySet<String>()) }
        var details by remember { mutableStateOf<Row?>(null) }
        var handoff by remember { mutableStateOf<Row?>(null) }
        var state by remember { mutableStateOf("Connecting") }
        var snapshot by remember { mutableStateOf<Snapshot?>(null) }
        var retry by remember { mutableIntStateOf(0) }
        var clock by remember { mutableLongStateOf(System.currentTimeMillis()) }
        val connection = remember { Connection() }
        val host = hosts.find { it.origin == selected }
        fun save(next: List<Host>): Boolean =
            try {
                credentials.write(next)
                hosts = next
                true
            } catch (_: Exception) {
                error = "Could not save machine credentials"
                false
            }
        LaunchedEffect(incoming) {
            if (incoming.isNotEmpty()) {
                invitation = incoming
                incoming = ""
                pairing = true
            }
        }
        LaunchedEffect(Unit) {
            while (true) {
                delay(1000)
                clock = System.currentTimeMillis()
            }
        }
        LaunchedEffect(host?.origin) { snapshot = null }
        LaunchedEffect(foreground) { if (!foreground) pairingBusy = false }
        DisposableEffect(host, retry, pairing, foreground) {
            if (host != null && !pairing && foreground) {
                state = "Connecting"
                connection.connect(
                    host,
                    { next -> runOnUiThread { snapshot = next } },
                    { next -> runOnUiThread { state = next } },
                    {
                        runOnUiThread {
                            state = "Pairing revoked"
                            if (save(hosts.filter { it.origin != host.origin })) {
                                selected = hosts.firstOrNull()?.origin
                                pairing = hosts.isEmpty()
                            }
                            error = "Machine revoked this phone. Pair again to reconnect."
                        }
                    },
                )
            }
            onDispose { connection.close() }
        }
        LaunchedEffect(state, host, pairing, foreground) {
            if (state == "Disconnected; reconnecting" && host != null && !pairing && foreground) {
                delay(5000)
                retry++
            }
        }
        details?.let { row ->
            AlertDialog(
                onDismissRequest = { details = null },
                title = { Text(row.title) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(row.cwd)
                        Text("${row.agent} · ${row.activity} · ${row.where}")
                        if (row.branch.isNotEmpty()) Text(row.branch)
                        Text(
                            "Updated ${if (row.active > 0) java.time.Instant.ofEpochMilli(row.active).toString() else "unknown"} · age ${age(clock - row.started)}"
                        )
                        if (row.url == null) Text(row.label)
                        TextButton(onClick = { copyId(row) }) { Text("Copy session ID") }
                    }
                },
                confirmButton = { TextButton(onClick = { details = null }) { Text("Done") } },
            )
        }
        handoff?.let { row ->
            AlertDialog(
                onDismissRequest = { handoff = null },
                title = { Text("Open in ChatGPT") },
                text = {
                    Column {
                        Text(
                            "Choose ${row.title} on ${host?.name}. This thread has no verified direct link."
                        )
                        TextButton(onClick = { copyId(row) }) { Text("Copy thread ID") }
                    }
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            handoff = null
                            openSession(row) { error = it }
                        }
                    ) {
                        Text("Open ChatGPT")
                    }
                },
                dismissButton = { TextButton(onClick = { handoff = null }) { Text("Cancel") } },
            )
        }
        Column(
            Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (pairing) Text("kiln", style = MaterialTheme.typography.titleLarge)
            if (error.isNotEmpty()) {
                Text(error, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = { error = "" }) { Text("Dismiss") }
            }
            if (pairing) {
                Text("Pair a machine", style = MaterialTheme.typography.titleLarge)
                Text(
                    "On the machine, run kiln serve and expose it with Tailscale Serve. Run kiln pair with its HTTPS URL, then paste or scan the invitation here."
                )
                OutlinedTextField(
                    invitation,
                    { invitation = it },
                    label = { Text("Pairing invitation") },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 4,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        enabled = !pairingBusy,
                        onClick = {
                            try {
                                val (origin, code) = com.cjber.kiln.invitation(invitation)
                                pairingBusy = true
                                error = ""
                                connection.pair(origin, code, android.os.Build.MODEL) {
                                    paired,
                                    problem ->
                                    runOnUiThread {
                                        pairingBusy = false
                                        if (paired != null) {
                                            if (
                                                save(
                                                    hosts.filter { it.origin != paired.origin } +
                                                        paired
                                                )
                                            ) {
                                                selected = paired.origin
                                                invitation = ""
                                                pairing = false
                                                retry++
                                            }
                                        } else error = problem
                                    }
                                }
                            } catch (_: Exception) {
                                error = "Paste a valid kiln invitation with an HTTPS server URL"
                            }
                        },
                    ) {
                        Text(if (pairingBusy) "Pairing…" else "Pair")
                    }
                    OutlinedButton(
                        enabled = !pairingBusy,
                        onClick = {
                            GmsBarcodeScanning.getClient(this@MainActivity)
                                .startScan()
                                .addOnSuccessListener { invitation = it.rawValue.orEmpty() }
                                .addOnFailureListener {
                                    error = "Scanner unavailable. Paste the invitation instead."
                                }
                        },
                    ) {
                        Text("Scan QR")
                    }
                    if (hosts.isNotEmpty())
                        TextButton(
                            onClick = {
                                pairing = false
                                invitation = ""
                            }
                        ) {
                            Text("Cancel")
                        }
                }
                return@Column
            }
            var menu by remember { mutableStateOf(false) }
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text("kiln", style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.weight(1f))
                Box {
                    TextButton(onClick = { menu = true }) {
                        Text(host?.name ?: "Choose machine", maxLines = 1)
                    }
                    DropdownMenu(menu, { menu = false }) {
                        hosts.forEach { item ->
                            DropdownMenuItem(
                                text = { Text(item.name) },
                                onClick = {
                                    selected = item.origin
                                    menu = false
                                },
                            )
                        }
                        DropdownMenuItem(
                            text = { Text("Reconnect") },
                            onClick = {
                                retry++
                                menu = false
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("Pair another machine") },
                            onClick = {
                                pairing = true
                                menu = false
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("Forget this machine") },
                            onClick = {
                                if (
                                    host != null && save(hosts.filter { it.origin != host.origin })
                                ) {
                                    selected = hosts.firstOrNull()?.origin
                                    pairing = hosts.isEmpty()
                                }
                                menu = false
                            },
                        )
                    }
                }
            }
            Text(
                "$state · refreshed ${updateTime(snapshot?.updated ?: 0)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            snapshot
                ?.problem
                ?.takeIf { it.isNotEmpty() }
                ?.let {
                    Text(
                        it,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            OutlinedTextField(
                filter,
                { filter = it },
                placeholder = {
                    Text("Filter sessions", style = MaterialTheme.typography.bodySmall)
                },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodySmall,
                modifier = Modifier.fillMaxWidth(),
            )
            val items = sessionItems(snapshot?.rows.orEmpty(), sort, filter, expanded)
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                TextButton(
                    onClick = {
                        sort = SessionOrder.entries[(sort.ordinal + 1) % SessionOrder.entries.size]
                    },
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
            LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (items.isEmpty())
                    item {
                        Text(
                            if (snapshot == null) "Waiting for the machine…"
                            else "No openable sessions match",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                items(items, key = { it.key }) { item ->
                    when (item) {
                        is SessionItem.Header ->
                            if (item.directory != null)
                                Column(Modifier.padding(top = 8.dp, bottom = 2.dp)) {
                                    Text(
                                        item.name,
                                        style = MaterialTheme.typography.labelLarge,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    item.directory?.let {
                                        Text(
                                            it,
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                        is SessionItem.Entry ->
                            SessionCard(
                                item,
                                item.row.id in expanded,
                                open = {
                                    if (item.row.exact) openSession(item.row) { error = it }
                                    else handoff = item.row
                                },
                                details = { details = item.row },
                                toggle = {
                                    expanded =
                                        if (item.row.id in expanded) expanded - item.row.id
                                        else expanded + item.row.id
                                },
                            )
                    }
                }
            }
        }
    }
}

private fun age(milliseconds: Long): String {
    val seconds = milliseconds.coerceAtLeast(0) / 1000
    return when {
        seconds < 60 -> "${seconds}s"
        seconds < 3600 -> "${seconds / 60}m"
        seconds < 86400 -> "${seconds / 3600}h"
        else -> "${seconds / 86400}d"
    }
}
