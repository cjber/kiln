package com.cjber.kiln

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper

private const val ONGOING_ID = 1
private const val STOP = "com.cjber.kiln.STOP_WATCHING"
private const val IDLE_LIMIT = 10 * 60_000L

/** Whether `origin` posts notifications; every machine does until its Notify me switch is off. */
fun notifyEnabled(context: Context, origin: String): Boolean =
    context
        .getSharedPreferences("notifications", Context.MODE_PRIVATE)
        .getBoolean("notify:$origin", true)

fun setNotifyEnabled(context: Context, origin: String, enabled: Boolean) {
    context
        .getSharedPreferences("notifications", Context.MODE_PRIVATE)
        .edit()
        .putBoolean("notify:$origin", enabled)
        .apply()
}

/**
 * Owns the one socket to the selected machine. While the app is open it feeds the activity; once a
 * session on a machine with notifications on is working, it also runs in the foreground, so the
 * socket outlives the app and each working to waiting or idle change becomes a notification. It
 * stops after ten minutes with nothing working or when the user taps Stop watching.
 */
class WatchService : Service() {
    interface Listener {
        fun snapshot(next: Snapshot)

        fun state(next: ConnectionState)

        fun revoked(host: Host)
    }

    inner class Link : Binder() {
        val service: WatchService
            get() = this@WatchService
    }

    private val main = Handler(Looper.getMainLooper())
    private val connection = Connection()
    private val transitions = Transitions()
    private val notifications
        get() = getSystemService(NotificationManager::class.java)

    private var generation = 0
    private var host: Host? = null
    private var listener: Listener? = null
    private var snapshot: Snapshot? = null
    private var state = ConnectionState.CONNECTING
    private var watching = false
    private var lastWorking = 0L
    /** The machine the user stopped watching; it stays unwatched until the app opens again. */
    private var stopped: String? = null

    private val retry = Runnable { host?.let(::connect) }
    private val idleCheck =
        object : Runnable {
            override fun run() {
                if (System.currentTimeMillis() - lastWorking >= IDLE_LIMIT) stopWatching()
                else main.postDelayed(this, 60_000)
            }
        }

    override fun onCreate() {
        super.onCreate()
        Alerts.createChannels(this)
    }

    override fun onBind(intent: Intent): IBinder = Link()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            stopped = host?.origin
            stopWatching()
        } else if (!watching) stopSelf(startId)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        close()
        super.onDestroy()
    }

    /** The visible activity shows [host]; the socket is reused when it already watches it. */
    fun attach(listener: Listener, host: Host) {
        this.listener = listener
        Alerts.visibleOrigin = host.origin
        stopped = null
        if (this.host != host) connect(host)
        else {
            listener.state(state)
            snapshot?.let(listener::snapshot)
        }
    }

    /** The activity left; the socket stays open only while watching. */
    fun detach() {
        listener = null
        Alerts.visibleOrigin = null
        if (!watching) close()
    }

    fun reconnect() {
        host?.let(::connect)
    }

    private fun connect(next: Host) {
        close()
        host = next
        val current = generation
        fun onMain(block: () -> Unit) = main.post { if (current == generation) block() }
        listener?.state(state)
        connection.connect(
            next,
            { onMain { received(next, it) } },
            { onMain { changed(it) } },
            { onMain { revoked(next) } },
        )
    }

    private fun close() {
        generation++
        connection.close()
        main.removeCallbacks(retry)
        host = null
        snapshot = null
        state = ConnectionState.CONNECTING
        transitions.reset()
    }

    private fun changed(next: ConnectionState) {
        state = next
        listener?.state(next)
        main.removeCallbacks(retry)
        if (next == ConnectionState.DISCONNECTED && (listener != null || watching))
            main.postDelayed(retry, 5_000)
    }

    private fun revoked(gone: Host) {
        val current = listener
        stopWatching()
        close()
        current?.revoked(gone)
    }

    private fun received(host: Host, next: Snapshot) {
        snapshot = next
        Alerts.clearRead(this, host.origin, next)
        val notify = notifyEnabled(this, host.origin)
        val changed = transitions.update(next, notify)
        if (listener == null)
            changed.forEach {
                Alerts.show(
                    this,
                    host,
                    TurnAlert(
                        it.id,
                        it.agent,
                        it.title,
                        it.cwd,
                        it.activity == Activity.WAITING,
                        next.updated,
                    ),
                )
            }
        val working = next.rows.any { it.where != Place.CLOUD && it.activity == Activity.WORKING }
        if (working) lastWorking = System.currentTimeMillis()
        // A foreground service may only start while the app is visible, so the watch begins there.
        if (notify && working && !watching && listener != null && stopped != host.origin)
            startWatching(host, next)
        else if (watching && !notify) stopWatching()
        else if (watching) notifications.notify(ONGOING_ID, ongoing(host, next))
        listener?.snapshot(next)
    }

    private fun startWatching(host: Host, snapshot: Snapshot) {
        val notification = ongoing(host, snapshot)
        try {
            if (Build.VERSION.SDK_INT >= 34)
                startForeground(
                    ONGOING_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                )
            else startForeground(ONGOING_ID, notification)
        } catch (_: IllegalStateException) {
            // Android refused the start (the app left the screen first); try again next time.
            return
        }
        // Started as well as bound, so the service outlives the activity unbinding.
        startService(Intent(this, WatchService::class.java))
        watching = true
        main.removeCallbacks(idleCheck)
        main.postDelayed(idleCheck, 60_000)
    }

    private fun stopWatching() {
        main.removeCallbacks(idleCheck)
        val was = watching
        watching = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        if (was && listener == null) close()
    }

    private fun ongoing(host: Host, snapshot: Snapshot): Notification {
        val count =
            snapshot.rows.count {
                it.where != Place.CLOUD &&
                    (it.activity == Activity.WORKING ||
                        it.activity == Activity.WAITING ||
                        it.activity == Activity.IDLE)
            }
        val stop =
            PendingIntent.getService(
                this,
                0,
                Intent(this, WatchService::class.java).setAction(STOP),
                PendingIntent.FLAG_IMMUTABLE,
            )
        return Notification.Builder(this, WATCHING)
            .setSmallIcon(R.drawable.icon)
            .setContentTitle(
                "Watching $count ${if (count == 1) "session" else "sessions"} on ${host.name}"
            )
            .setContentText("You get a notification when a session needs input or finishes.")
            .setOngoing(true)
            .setContentIntent(Alerts.openApp(this, 0))
            .addAction(Notification.Action.Builder(null, "Stop watching", stop).build())
            .build()
    }
}
