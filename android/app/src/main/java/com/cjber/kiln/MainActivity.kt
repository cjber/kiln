package com.cjber.kiln

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
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
            KilnTheme { Kiln() }
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
        var piSession by remember { mutableStateOf<Row?>(null) }
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
        LaunchedEffect(host?.origin) {
            snapshot = null
            piSession = null
        }
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
        if (piSession != null && host != null && !pairing) {
            PiRemoteScreen(host, piSession!!, foreground) { piSession = null }
            return
        }
        details?.let { row ->
            AlertDialog(
                onDismissRequest = { details = null },
                title = { Text(row.title) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(row.cwd)
                        Text(
                            listOf(row.agent, row.branch.takeIf { it.isNotEmpty() })
                                .filterNotNull()
                                .joinToString(" · ")
                        )
                        Text("${row.activity} · ${row.where}")
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
        if (pairing) {
            PairingScreen(
                error,
                { error = "" },
                invitation,
                { invitation = it },
                pairingBusy,
                hosts.isNotEmpty(),
                pair = {
                    try {
                        val (origin, code) = com.cjber.kiln.invitation(invitation)
                        pairingBusy = true
                        error = ""
                        connection.pair(origin, code, android.os.Build.MODEL) { paired, problem ->
                            runOnUiThread {
                                pairingBusy = false
                                if (paired != null) {
                                    if (
                                        save(hosts.filter { it.origin != paired.origin } + paired)
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
                scan = {
                    GmsBarcodeScanning.getClient(this@MainActivity)
                        .startScan()
                        .addOnSuccessListener { invitation = it.rawValue.orEmpty() }
                        .addOnFailureListener {
                            error = "Scanner unavailable. Paste the invitation instead."
                        }
                },
                cancel = {
                    pairing = false
                    invitation = ""
                },
            )
        } else {
            SessionScreen(
                host?.name ?: "Choose machine",
                hosts.map { it.name },
                onMachine = { selected = hosts[it].origin },
                onReconnect = { retry++ },
                onPairAnother = { pairing = true },
                onForget = {
                    if (host != null && save(hosts.filter { it.origin != host.origin })) {
                        selected = hosts.firstOrNull()?.origin
                        pairing = hosts.isEmpty()
                    }
                },
                error = error,
                onDismissError = { error = "" },
                state = state,
                updated = snapshot?.updated ?: 0,
                problem = snapshot?.problem.orEmpty(),
                filter = filter,
                onFilter = { filter = it },
                sort = sort,
                onSort = {
                    sort = SessionOrder.entries[(sort.ordinal + 1) % SessionOrder.entries.size]
                },
                rows = snapshot?.rows.orEmpty(),
                loaded = snapshot != null,
                now = clock,
                expanded = expanded,
                open = { row ->
                    if (row.piRemote) piSession = row
                    else if (row.exact) openSession(row) { error = it } else handoff = row
                },
                details = { details = it },
                toggle = { row ->
                    expanded = if (row.id in expanded) expanded - row.id else expanded + row.id
                },
            )
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
