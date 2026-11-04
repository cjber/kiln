package com.cjber.kiln

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.delay
import org.unifiedpush.android.connector.UnifiedPush

/** The machine origin and session id a notification tap opens, if `intent` came from one. */
private fun sessionTarget(intent: Intent): Pair<String, String>? {
    if (intent.action != OPEN_SESSION) return null
    val origin = intent.getStringExtra(EXTRA_ORIGIN) ?: return null
    val session = intent.getStringExtra(EXTRA_SESSION) ?: return null
    return origin to session
}

class MainActivity : ComponentActivity() {
    private var foreground by mutableStateOf(false)
    private var watch by mutableStateOf<WatchService?>(null)
    private val binding =
        object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, service: IBinder) {
                watch = (service as WatchService.Link).service
            }

            override fun onServiceDisconnected(name: ComponentName) {
                watch = null
            }
        }

    override fun onStart() {
        super.onStart()
        foreground = true
        bindService(Intent(this, WatchService::class.java), binding, BIND_AUTO_CREATE)
    }

    override fun onStop() {
        foreground = false
        watch?.detach()
        watch = null
        unbindService(binding)
        super.onStop()
    }

    private var incoming by mutableStateOf("")
    private var target by mutableStateOf<Pair<String, String>?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The app is always dark, so keep light system bar icons whatever the phone's theme.
        val bars = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
        enableEdgeToEdge(bars, bars)
        incoming = if (savedInstanceState == null) intent.dataString.orEmpty() else ""
        target = if (savedInstanceState == null) sessionTarget(intent) else null
        setContent {
            KilnTheme { Kiln() }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        incoming = intent.dataString.orEmpty()
        sessionTarget(intent)?.let { target = it }
    }

    private fun canNotify(): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED

    private fun openNotificationSettings() {
        try {
            startActivity(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            )
        } catch (_: android.content.ActivityNotFoundException) {}
    }

    /** kiln reaches the computer only through Tailscale, which Android runs as a VPN. */
    private fun vpnOn(): Boolean {
        val manager = getSystemService(ConnectivityManager::class.java)
        return manager
            .getNetworkCapabilities(manager.activeNetwork)
            ?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
    }

    private fun openTailscale() {
        val intent =
            packageManager.getLaunchIntentForPackage("com.tailscale.ipn")
                ?: Intent(
                    Intent.ACTION_VIEW,
                    android.net.Uri.parse(
                        "https://play.google.com/store/apps/details?id=com.tailscale.ipn"
                    ),
                )
        try {
            startActivity(intent)
        } catch (_: android.content.ActivityNotFoundException) {}
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
        var selected by rememberSaveable { mutableStateOf(hosts.firstOrNull()?.origin) }
        var pairing by rememberSaveable { mutableStateOf(hosts.isEmpty()) }
        var invitation by rememberSaveable { mutableStateOf(incoming) }
        var invitationProblem by rememberSaveable { mutableStateOf("") }
        var pairingBusy by remember { mutableStateOf(false) }
        var filter by rememberSaveable { mutableStateOf("") }
        var sort by rememberSaveable { mutableStateOf(SessionOrder.PROJECT) }
        var expanded by remember { mutableStateOf(emptySet<String>()) }
        var details by remember { mutableStateOf<Row?>(null) }
        var opened by rememberSaveable { mutableStateOf<String?>(null) }
        var handoff by remember { mutableStateOf<Row?>(null) }
        var state by remember { mutableStateOf(ConnectionState.CONNECTING) }
        var snapshot by remember { mutableStateOf<Snapshot?>(null) }
        var received by remember { mutableLongStateOf(0L) }
        var clock by remember { mutableLongStateOf(System.currentTimeMillis()) }
        var tailscaleOn by remember { mutableStateOf(vpnOn()) }
        var newSession by remember { mutableStateOf(false) }
        var startOptions by remember { mutableStateOf<StartOptions?>(null) }
        var startProblem by remember { mutableStateOf("") }
        var starting by remember { mutableStateOf(false) }
        // The tmux name of the session this phone just started, until it is listed.
        var started by remember { mutableStateOf<String?>(null) }
        var scrollTo by remember { mutableStateOf<String?>(null) }
        val connection = remember {
            Connection(
                unreachable = {
                    if (vpnOn())
                        "Your computer is not answering. Check that it is awake and kiln serve is running."
                    else "Tailscale is off on this phone. Turn it on, then try again."
                }
            )
        }
        val screenState = rememberSaveableStateHolder()
        val host = hosts.find { it.origin == selected }
        var notify by
            remember(host?.origin) {
                mutableStateOf(host != null && notifyEnabled(this@MainActivity, host.origin))
            }
        // Opening a session here reads it, so its notification goes.
        LaunchedEffect(host?.origin, opened, details?.id) {
            val origin = host?.origin ?: return@LaunchedEffect
            listOfNotNull(opened, details?.id).forEach {
                Alerts.clear(this@MainActivity, origin, it)
            }
        }
        val askedPreferences = remember { getSharedPreferences("notifications", MODE_PRIVATE) }
        var askNotifications by remember { mutableStateOf(false) }
        val permission =
            rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
        fun requestNotifications() {
            askedPreferences.edit().putBoolean("asked", true).apply()
            if (Build.VERSION.SDK_INT >= 33)
                permission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
        var push by remember { mutableStateOf(Push.enabled(this@MainActivity)) }
        DisposableEffect(Unit) {
            val listener = Push.listen(this@MainActivity) { push = it }
            onDispose { Push.unlisten(this@MainActivity, listener) }
        }
        fun usePush(on: Boolean, ask: Boolean = true) {
            if (!on) {
                Push.disable(this@MainActivity)
                return
            }
            if (ask && !canNotify()) requestNotifications()
            UnifiedPush.tryUseCurrentOrDefaultDistributor(this@MainActivity) { found ->
                if (found) Push.enable(this@MainActivity)
                else {
                    Push.disable(this@MainActivity)
                    error = "Install ntfy or another UnifiedPush app, then turn this on again"
                }
            }
        }
        // Registering again on each launch keeps every paired machine's copy of the endpoint
        // current.
        LaunchedEffect(Unit) { if (Push.enabled(this@MainActivity)) usePush(true, ask = false) }
        val viewPreferences = remember { getSharedPreferences("session-views", MODE_PRIVATE) }
        var hidden by
            remember(host?.origin) {
                mutableStateOf(
                    hiddenEntries(
                        viewPreferences
                            .getStringSet("hidden:${host?.origin}", emptySet())
                            .orEmpty()
                            .toSet()
                    )
                )
            }
        val effectiveHidden = hiddenSessionIds(snapshot?.rows.orEmpty(), hidden.keys)
        fun saveHidden(next: Map<String, Activity?>): Boolean {
            if (host == null) return false
            if (
                !viewPreferences
                    .edit()
                    .putStringSet("hidden:${host.origin}", storedHidden(next))
                    .commit()
            ) {
                error = "Could not save hidden sessions"
                return false
            }
            hidden = next
            return true
        }
        fun setHidden(next: Set<String>): Boolean =
            saveHidden(hideWithActivity(snapshot?.rows.orEmpty(), hidden, next))
        LaunchedEffect(snapshot) {
            val rows = snapshot?.rows ?: return@LaunchedEffect
            val settled = settleHidden(rows, hidden)
            if (settled != hidden) saveHidden(settled)
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
                invitationProblem = ""
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
            received = 0
            details = null
            handoff = null
            newSession = false
            started = null
        }
        LaunchedEffect(newSession) {
            val current = host
            if (!newSession || current == null) return@LaunchedEffect
            startOptions = null
            startProblem = ""
            connection.startOptions(current) { options, problem ->
                runOnUiThread {
                    startOptions = options
                    startProblem = problem
                }
            }
        }
        // A session this phone started opens its details once the machine lists it.
        LaunchedEffect(started, snapshot) {
            val terminal = started ?: return@LaunchedEffect
            val row = snapshot?.rows?.find { it.terminal == terminal } ?: return@LaunchedEffect
            started = null
            scrollTo = row.id
            details = row
        }
        LaunchedEffect(foreground) { if (!foreground) pairingBusy = false }
        // Pairing errors belong to the pairing screen and never follow the user to the list.
        LaunchedEffect(pairing) {
            if (!pairing) {
                pairingBusy = false
                invitationProblem = ""
                error = ""
            }
        }
        DisposableEffect(watch, host, pairing, foreground) {
            val service = watch
            if (service == null || host == null || pairing || !foreground)
                return@DisposableEffect onDispose {}
            service.attach(
                object : WatchService.Listener {
                    override fun snapshot(next: Snapshot) {
                        received = receivedAt(snapshot, next, received, System.currentTimeMillis())
                        snapshot = next
                    }

                    override fun state(next: ConnectionState) {
                        state = next
                    }

                    override fun revoked(host: Host) {
                        state = ConnectionState.REVOKED
                        if (save(hosts.filter { it.origin != host.origin })) {
                            selected = hosts.firstOrNull()?.origin
                            pairing = hosts.isEmpty()
                        }
                        error = "Machine revoked this phone. Pair again to reconnect."
                    }
                },
                host,
            )
            onDispose { service.detach() }
        }
        // Ask for notifications the first time a session works, never at launch.
        LaunchedEffect(snapshot) {
            if (
                notify &&
                    !canNotify() &&
                    !askedPreferences.getBoolean("asked", false) &&
                    snapshot?.rows.orEmpty().any {
                        it.where != Place.CLOUD && it.activity == Activity.WORKING
                    }
            )
                askNotifications = true
        }
        if (askNotifications)
            AlertDialog(
                onDismissRequest = {
                    askNotifications = false
                    askedPreferences.edit().putBoolean("asked", true).apply()
                },
                title = { Text("Get notified?") },
                text = { Text("kiln can tell you when a session needs input or finishes a turn.") },
                confirmButton = {
                    TextButton(
                        onClick = {
                            askNotifications = false
                            requestNotifications()
                        }
                    ) {
                        Text("Allow")
                    }
                },
                dismissButton = {
                    TextButton(
                        onClick = {
                            askNotifications = false
                            askedPreferences.edit().putBoolean("asked", true).apply()
                        }
                    ) {
                        Text("Not now")
                    }
                },
            )
        // A tapped notification opens its machine, then the session once it is listed.
        LaunchedEffect(target) {
            val origin = target?.first ?: return@LaunchedEffect
            if (hosts.any { it.origin == origin }) {
                selected = origin
                pairing = false
            } else target = null
        }
        LaunchedEffect(target, snapshot) {
            val (origin, id) = target ?: return@LaunchedEffect
            if (host?.origin != origin) return@LaunchedEffect
            val rows = snapshot?.rows ?: return@LaunchedEffect
            rows
                .find { it.id == id }
                ?.let {
                    if (opensView(snapshot, it)) opened = it.id else details = it
                }
            target = null
        }
        DisposableEffect(Unit) {
            val manager = getSystemService(ConnectivityManager::class.java)
            val callback =
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        runOnUiThread {
                            tailscaleOn = true
                            // Reconnect now rather than at the next five-second retry.
                            if (state != ConnectionState.CONNECTED) watch?.reconnect()
                        }
                    }

                    override fun onLost(network: Network) {
                        runOnUiThread { tailscaleOn = vpnOn() }
                    }
                }
            manager.registerNetworkCallback(
                NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_VPN)
                    .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                    .build(),
                callback,
            )
            onDispose { manager.unregisterNetworkCallback(callback) }
        }
        fun handOff(row: Row) {
            if (row.url == null) details = row
            else if (row.exact) openSession(row) { error = it } else handoff = row
        }
        // Claude sessions open in kiln's own view; the others still hand off to their app.
        fun launch(row: Row) {
            if (opensView(snapshot, row)) opened = row.id else handOff(row)
        }
        details?.let { original ->
            val row = snapshot?.rows?.find { it.id == original.id } ?: original
            SessionDetails(
                row,
                clock,
                dismiss = { details = null },
                open = {
                    details = null
                    handOff(row)
                },
                copy = { copyId(row) },
                hidden = row.id in effectiveHidden,
                send =
                    host
                        ?.takeIf { snapshot?.write == true && canMessage(row) }
                        ?.let { current ->
                            { text, done ->
                                connection.send(current, row.id, text) {
                                    runOnUiThread { done(it) }
                                }
                            }
                        },
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
        if (newSession && host != null)
            NewSessionSheet(
                startOptions,
                startProblem,
                starting,
                dismiss = { newSession = false },
                start = { agent, directory, prompt ->
                    starting = true
                    startProblem = ""
                    connection.startSession(host, agent, directory, prompt) { terminal, problem ->
                        runOnUiThread {
                            starting = false
                            if (terminal != null) {
                                newSession = false
                                started = terminal
                            } else startProblem = problem
                        }
                    }
                },
            )
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
                {
                    invitation = it
                    invitationProblem = ""
                },
                invitationProblem,
                pairingBusy,
                hosts.isNotEmpty(),
                tailscaleOn = tailscaleOn,
                openTailscale = ::openTailscale,
                pair = pair@{
                        invitationProblem = invitationError(invitation)
                        if (invitationProblem.isNotEmpty()) return@pair
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
                                        Push.share(this@MainActivity, paired)
                                        selected = paired.origin
                                        invitation = ""
                                        pairing = false
                                    }
                                } else error = problem
                            }
                        }
                    },
                scan = {
                    GmsBarcodeScanning.getClient(this@MainActivity)
                        .startScan()
                        .addOnSuccessListener {
                            invitation = it.rawValue.orEmpty()
                            invitationProblem = ""
                        }
                        .addOnFailureListener {
                            error = "Scanner unavailable. Paste the invitation instead."
                        }
                },
                cancel = {
                    pairing = false
                    invitation = ""
                },
            )
        } else if (host != null && opened != null) {
            val row = snapshot?.rows?.find { it.id == opened }
            if (row == null) LaunchedEffect(snapshot) { if (snapshot != null) opened = null }
            else SessionView(host, row, back = { opened = null }, details = { details = row })
        } else {
            screenState.SaveableStateProvider(host?.origin ?: "unpaired") {
                key(host?.origin) {
                    SessionScreen(
                        host?.name ?: "Choose machine",
                        hosts.map { it.name },
                        selectedMachine = hosts.indexOf(host),
                        onMachine = { selected = hosts[it].origin },
                        onReconnect = { watch?.reconnect() },
                        notify = notify,
                        onNotify = { on ->
                            if (host != null) {
                                setNotifyEnabled(this@MainActivity, host.origin, on)
                                notify = on
                                if (on && !canNotify()) requestNotifications()
                            }
                        },
                        push = push,
                        onPush = { usePush(it) },
                        openNotificationSettings = ::openNotificationSettings,
                        onPairAnother = { pairing = true },
                        onForget = {
                            if (host != null && save(hosts.filter { it.origin != host.origin })) {
                                if (push) Push.forget(host)
                                selected = hosts.firstOrNull()?.origin
                                pairing = hosts.isEmpty()
                            }
                        },
                        error = error,
                        onDismissError = { error = "" },
                        state = state,
                        updated = received,
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
                        tailscaleOn = tailscaleOn,
                        openTailscale = ::openTailscale,
                        changeHidden = ::setHidden,
                        open = ::launch,
                        details = { details = it },
                        onNewSession =
                            if (snapshot?.write == true) ({ newSession = true }) else null,
                        scrollTo = scrollTo,
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
