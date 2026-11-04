package com.cjber.kiln

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * Keeps one connection per paired machine while the app is closed and posts a notification when a
 * session's turn ends. Android requires a foreground service, and so an ongoing notification, to
 * hold the connections open.
 */
class WatchService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val watched = mutableMapOf<String, Watch>()
    private var network: ConnectivityManager.NetworkCallback? = null

    private class Watch(val host: Host, val connection: Connection = Connection()) {
        var previous: Map<String, Activity>? = null
        var connected = false
        /** Callbacks from an earlier attempt are dropped, since okhttp may deliver them late. */
        var attempt = 0
    }

    override fun onBind(intent: Intent?) = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(WATCHING, "Connection", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Shown while kiln watches your machines for finished turns"
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(TURNS, "Finished turns", NotificationManager.IMPORTANCE_HIGH)
                .apply { description = "A session finished its turn or needs your input" }
        )
        val callback =
            object : ConnectivityManager.NetworkCallback() {
                // Tailscale coming back reconnects now rather than at the next retry.
                override fun onAvailable(network: Network) {
                    handler.post { watched.values.filter { !it.connected }.forEach(::connect) }
                }
            }
        getSystemService(ConnectivityManager::class.java)
            .registerNetworkCallback(
                NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_VPN)
                    .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                    .build(),
                callback,
            )
        network = callback
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP || !allowed(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        val hosts =
            try {
                Credentials(this).read()
            } catch (_: Exception) {
                emptyList()
            }
        val ongoing = ongoing(hosts.size)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
            startForeground(ONGOING, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(ONGOING, ongoing)
        if (hosts.isEmpty()) {
            stopSelf()
            return START_NOT_STICKY
        }
        val origins = hosts.map { it.origin }.toSet()
        watched.keys.filter { it !in origins }.forEach { forget(it) }
        hosts.forEach { host ->
            val existing = watched[host.origin]
            if (existing == null || existing.host != host) {
                existing?.let { forget(host.origin) }
                connect(Watch(host).also { watched[host.origin] = it })
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        watched.keys.toList().forEach { forget(it) }
        network?.let {
            getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it)
        }
        super.onDestroy()
    }

    private fun forget(origin: String) {
        watched.remove(origin)?.let {
            handler.removeCallbacksAndMessages(it)
            it.connection.close()
        }
    }

    private fun connect(watch: Watch) {
        handler.removeCallbacksAndMessages(watch)
        val attempt = ++watch.attempt
        fun current() = watched[watch.host.origin] === watch && watch.attempt == attempt
        watch.connection.connect(
            watch.host,
            { snapshot -> handler.post { if (current()) seen(watch, snapshot) } },
            { state ->
                handler.post {
                    if (!current()) return@post
                    watch.connected = state == ConnectionState.CONNECTED
                    if (state == ConnectionState.DISCONNECTED || state == ConnectionState.INVALID)
                        handler.postAtTime(
                            { connect(watch) },
                            watch,
                            android.os.SystemClock.uptimeMillis() + RETRY_MS,
                        )
                }
            },
            { handler.post { if (current()) revoked(watch.host) } },
        )
    }

    /** A machine that revoked this phone is removed here too, so a restart never reconnects it. */
    private fun revoked(host: Host) {
        forget(host.origin)
        try {
            val credentials = Credentials(this)
            credentials.write(credentials.read().filter { it.origin != host.origin })
        } catch (_: Exception) {
            // The app removes it when it next connects to that machine.
        }
        if (watched.isEmpty()) stopSelf()
    }

    private fun seen(watch: Watch, snapshot: Snapshot) {
        val ended = endedTurns(watch.previous, snapshot.rows)
        watch.previous = activities(snapshot.rows)
        if (!allowed(this)) return
        val manager = getSystemService(NotificationManager::class.java)
        ended.forEach { row ->
            val waiting = row.activity == Activity.WAITING
            manager.notify(
                "${watch.host.origin}\n${row.id}".hashCode(),
                Notification.Builder(this, TURNS)
                    .setSmallIcon(R.drawable.notification)
                    .setContentTitle(
                        "${row.title.ifBlank { "${agentName(row.agent)} session" }} · ${if (waiting) "Needs input" else "Turn finished"}"
                    )
                    .setContentText(
                        "${agentName(row.agent)} · ${row.cwd}${if (watched.size > 1) " · ${watch.host.name}" else ""}"
                    )
                    .setCategory(
                        if (waiting) Notification.CATEGORY_REMINDER
                        else Notification.CATEGORY_STATUS
                    )
                    .setContentIntent(openApp())
                    .setAutoCancel(true)
                    .build(),
            )
        }
    }

    private fun openApp(): PendingIntent =
        PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )

    private fun ongoing(machines: Int): Notification =
        Notification.Builder(this, WATCHING)
            .setSmallIcon(R.drawable.notification)
            .setContentTitle("Watching for finished turns")
            .setContentText(if (machines == 1) "1 machine" else "$machines machines")
            .setContentIntent(openApp())
            .setOngoing(true)
            .addAction(
                Notification.Action.Builder(
                        null,
                        "Stop",
                        PendingIntent.getService(
                            this,
                            1,
                            Intent(this, WatchService::class.java).setAction(STOP),
                            PendingIntent.FLAG_IMMUTABLE,
                        ),
                    )
                    .build()
            )
            .build()

    companion object {
        /** Without the notification permission there is nothing to show, so nothing is watched. */
        fun allowed(context: Context): Boolean =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                    PackageManager.PERMISSION_GRANTED

        private const val WATCHING = "watching"
        private const val TURNS = "turns"
        private const val ONGOING = 1
        private const val STOP = "com.cjber.kiln.STOP_WATCHING"
        private const val RETRY_MS = 15_000L

        /**
         * Starts or refreshes the watch with the paired machines; it stops itself when there are
         * none.
         */
        fun start(context: Context) {
            if (!allowed(context)) return
            try {
                context.startForegroundService(Intent(context, WatchService::class.java))
            } catch (_: IllegalStateException) {
                // Android refuses a start from the background; the next app launch starts it.
            }
        }
    }
}

/** Resumes watching after the phone restarts. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) WatchService.start(context)
    }
}
