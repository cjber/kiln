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
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(Modifier.fillMaxSize()) { Kiln() }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        incoming = intent.dataString.orEmpty()
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
        var sort by remember { mutableStateOf("Last active") }
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
        Column(
            Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("kiln", style = MaterialTheme.typography.headlineLarge)
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
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box {
                    OutlinedButton(onClick = { menu = true }) {
                        Text(host?.name ?: "Choose machine")
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
                            text = { Text("Pair another machine") },
                            onClick = {
                                pairing = true
                                menu = false
                            },
                        )
                    }
                }
                TextButton(onClick = { retry++ }) { Text("Reconnect") }
                TextButton(
                    onClick = {
                        if (host != null && save(hosts.filter { it.origin != host.origin })) {
                            selected = hosts.firstOrNull()?.origin
                            pairing = hosts.isEmpty()
                        }
                    }
                ) {
                    Text("Forget")
                }
            }
            Text(
                "$state · ${snapshot?.updated?.takeIf { it > 0 }?.let { "updated ${age(clock - it)} ago" } ?: "no list yet"}"
            )
            snapshot
                ?.problem
                ?.takeIf { it.isNotEmpty() }
                ?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            OutlinedTextField(
                filter,
                { filter = it },
                label = { Text("Filter sessions, projects or harnesses") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(
                    onClick = {
                        val sorts = listOf("Last active", "Age", "Harness", "Directory", "Project")
                        sort = sorts[(sorts.indexOf(sort) + 1) % sorts.size]
                    }
                ) {
                    Text("Sort: $sort")
                }
                Text(
                    "${snapshot?.rows?.size ?: 0} sessions",
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
            val rows =
                snapshot?.rows.orEmpty().filter { row ->
                    listOf(row.title, row.cwd, row.agent, row.branch).any {
                        it.contains(filter, ignoreCase = true)
                    }
                }
            val ordered =
                when (sort) {
                    "Age" -> rows.sortedBy { it.started }
                    "Harness" -> rows.sortedBy { it.agent }
                    "Directory" -> rows.sortedBy { it.cwd }
                    "Project" -> rows.sortedBy { it.cwd.substringAfterLast('/') }
                    else ->
                        rows.sortedByDescending {
                            it.active.takeIf { time -> time > 0 } ?: it.started
                        }
                }
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (ordered.isEmpty())
                    item {
                        Text(
                            if (snapshot == null) "Waiting for the machine…"
                            else "No matching sessions"
                        )
                    }
                items(ordered, key = { it.id }) { row ->
                    Card(Modifier.fillMaxWidth()) {
                        Column(
                            Modifier.padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                "${row.agent} · ${row.activity} · ${row.where}",
                                style = MaterialTheme.typography.labelLarge,
                            )
                            Text(row.title, style = MaterialTheme.typography.titleMedium)
                            Text(
                                row.cwd + if (row.branch.isNotEmpty()) " · ${row.branch}" else "",
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Text(
                                "Last active: ${if (row.active > 0) age(clock - row.active) + " ago" else "unknown"} · age ${age(clock - row.started)}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                            if (row.url != null) {
                                if (!row.exact)
                                    Text(
                                        "Choose ${row.title} on ${host?.name}. Copy the thread ID if needed.",
                                        style = MaterialTheme.typography.bodySmall,
                                    )
                                Row {
                                    TextButton(
                                        onClick = {
                                            try {
                                                startActivity(
                                                    Intent(
                                                        Intent.ACTION_VIEW,
                                                        android.net.Uri.parse(row.url),
                                                    )
                                                )
                                            } catch (_: android.content.ActivityNotFoundException) {
                                                error =
                                                    "Install the provider app or a browser to open this session"
                                            }
                                        }
                                    ) {
                                        Text(row.label)
                                    }
                                    TextButton(
                                        onClick = {
                                            getSystemService(ClipboardManager::class.java)
                                                .setPrimaryClip(
                                                    ClipData.newPlainText(
                                                        "kiln session",
                                                        row.id.substringAfter(':'),
                                                    )
                                                )
                                        }
                                    ) {
                                        Text("Copy ID")
                                    }
                                }
                            } else Text(row.label, style = MaterialTheme.typography.bodySmall)
                        }
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
