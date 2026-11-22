package com.cjber.kiln

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper

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

/** Owns the selected machine connection while the activity is visible. */
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
    private var generation = 0
    private var host: Host? = null
    private var listener: Listener? = null
    private var snapshot: Snapshot? = null
    private var state = ConnectionState.CONNECTING
    private val retry = Runnable { host?.let(::connect) }

    override fun onCreate() {
        super.onCreate()
        Alerts.createChannels(this)
    }

    override fun onBind(intent: Intent): IBinder = Link()

    override fun onDestroy() {
        close()
        super.onDestroy()
    }

    fun attach(listener: Listener, host: Host) {
        this.listener = listener
        Alerts.visibleOrigin = host.origin
        if (this.host != host) connect(host)
        else {
            listener.state(state)
            snapshot?.let(listener::snapshot)
        }
    }

    fun detach() {
        listener = null
        Alerts.visibleOrigin = null
        close()
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
    }

    private fun changed(next: ConnectionState) {
        state = next
        listener?.state(next)
        main.removeCallbacks(retry)
        if (next == ConnectionState.DISCONNECTED && listener != null) main.postDelayed(retry, 5_000)
    }

    private fun revoked(gone: Host) {
        val current = listener
        close()
        current?.revoked(gone)
    }

    private fun received(host: Host, next: Snapshot) {
        snapshot = next
        Alerts.clearRead(this, host.origin, next)
        listener?.snapshot(next)
    }
}
