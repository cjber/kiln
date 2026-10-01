package com.cjber.kiln

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
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
        enableEdgeToEdge()
        incoming = if (savedInstanceState == null) intent.dataString.orEmpty() else ""
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
        var demo by rememberSaveable { mutableStateOf(false) }
        var privacy by rememberSaveable { mutableStateOf(false) }
        if (privacy) {
            PrivacyScreen { privacy = false }
            return
        }
        if (demo) {
            DemoScreen { demo = false }
            return
        }
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
        var selected by rememberSaveable { mutableStateOf(hosts.firstOrNull()?.origin) }
        var pairing by rememberSaveable { mutableStateOf(hosts.isEmpty()) }
        var invitation by rememberSaveable { mutableStateOf(incoming) }
        var pairingBusy by remember { mutableStateOf(false) }
        var filter by rememberSaveable { mutableStateOf("") }
        var sort by rememberSaveable { mutableStateOf(SessionOrder.PROJECT) }
        var expanded by remember { mutableStateOf(emptySet<String>()) }
        var details by remember { mutableStateOf<Row?>(null) }
        var handoff by remember { mutableStateOf<Row?>(null) }
        var conversationSession by remember { mutableStateOf<Row?>(null) }
        var state by remember { mutableStateOf("Connecting") }
        var snapshot by remember { mutableStateOf<Snapshot?>(null) }
        var retry by remember { mutableIntStateOf(0) }
        var clock by remember { mutableLongStateOf(System.currentTimeMillis()) }
        val connection = remember { Connection() }
        val screenState = rememberSaveableStateHolder()
        val host = hosts.find { it.origin == selected }
        val viewPreferences = remember { getSharedPreferences("session-views", MODE_PRIVATE) }
        var hiddenIds by
            remember(host?.origin) {
                mutableStateOf(
                    viewPreferences
                        .getStringSet("hidden:${host?.origin}", emptySet())
                        .orEmpty()
                        .toSet()
                )
            }
        val effectiveHidden = hiddenSessionIds(snapshot?.rows.orEmpty(), hiddenIds)
        fun setHidden(next: Set<String>): Boolean {
            if (host == null) return false
            if (!viewPreferences.edit().putStringSet("hidden:${host.origin}", next).commit()) {
                error = "Could not save hidden sessions"
                return false
            }
            hiddenIds = next
            return true
        }
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
            conversationSession = null
            details = null
            handoff = null
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
        if (conversationSession != null && host != null && !pairing) {
            ConversationScreen(host, conversationSession!!, foreground) {
                conversationSession = null
            }
            return
        }
        fun launch(row: Row) {
            if (row.acpRemote) conversationSession = row
            else if (row.exact) openSession(row) { error = it } else handoff = row
        }
        details?.let { original ->
            val row = snapshot?.rows?.find { it.id == original.id } ?: original
            SessionDetails(
                row,
                clock,
                dismiss = { details = null },
                open = {
                    details = null
                    launch(row)
                },
                copy = { copyId(row) },
                hidden = row.id in effectiveHidden,
                changeHidden = {
                    val rows = snapshot?.rows.orEmpty()
                    val next =
                        if (row.id in effectiveHidden)
                            effectiveHidden - sessionRestoreIds(rows, row.id)
                        else effectiveHidden + sessionTreeIds(rows, row.id)
                    if (setHidden(next)) details = null
                },
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
                demo = { demo = true },
                privacy = { privacy = true },
            )
        } else {
            screenState.SaveableStateProvider(host?.origin ?: "unpaired") {
                key(host?.origin) {
                    SessionScreen(
                        host?.name ?: "Choose machine",
                        hosts.map { it.name },
                        selectedMachine = hosts.indexOf(host),
                        privacy = { privacy = true },
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
                        onSort = { sort = it },
                        rows = snapshot?.rows.orEmpty(),
                        loaded = snapshot != null,
                        now = clock,
                        expanded = expanded,
                        hiddenIds = effectiveHidden,
                        changeHidden = ::setHidden,
                        open = ::launch,
                        details = { details = it },
                        toggle = { row ->
                            expanded =
                                if (row.id in expanded) expanded - row.id else expanded + row.id
                        },
                    )
                }
            }
        }
    }
}
