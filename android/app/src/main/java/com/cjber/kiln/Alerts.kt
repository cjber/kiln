package com.cjber.kiln

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

private const val NEEDS_INPUT = "needs-input"
private const val TURN_FINISHED = "turn-finished"
const val WATCHING = "watching"
const val OPEN_SESSION = "com.cjber.kiln.OPEN_SESSION"
const val EXTRA_ORIGIN = "origin"
const val EXTRA_SESSION = "session"
private const val EXTRA_AT = "com.cjber.kiln.at"

/** One session's turn ending, from the live connection or from a push. */
data class TurnAlert(
    val session: String,
    val agent: Agent,
    val title: String,
    val cwd: String,
    val waiting: Boolean,
    /** The machine's `updatedAt` for the refresh that saw the change; both paths agree on it. */
    val at: Long,
)

/**
 * The keys of the last [limit] alerts shown, oldest first. Both the live connection and a push can
 * deliver the same change, and [add] is false the second time.
 */
class RecentAlerts(stored: String, private val limit: Int = 64) {
    private val keys = ArrayDeque(stored.split('\n').filter { it.isNotEmpty() })

    fun add(key: String): Boolean {
        if (key in keys) return false
        keys.addLast(key)
        while (keys.size > limit) keys.removeFirst()
        return true
    }

    override fun toString() = keys.joinToString("\n")

    companion object {
        fun key(origin: String, alert: TurnAlert) =
            listOf(origin, alert.session, alert.at.toString()).joinToString("\t").replace('\n', ' ')
    }
}

/** Whether an alert shown at [at], by the machine's clock, has been read on that machine. */
fun isRead(row: Row, at: Long): Boolean = row.activity == Activity.WORKING || row.seen > at

/** Posts the turn notifications the watch service and the push service share. */
object Alerts {
    /** The machine the app shows on screen, which posts no notifications while it is visible. */
    @Volatile var visibleOrigin: String? = null

    fun createChannels(context: Context) {
        context
            .getSystemService(NotificationManager::class.java)
            .createNotificationChannels(
                listOf(
                    NotificationChannel(
                            NEEDS_INPUT,
                            "Needs input",
                            NotificationManager.IMPORTANCE_HIGH,
                        )
                        .apply { description = "A session is waiting for your answer" },
                    NotificationChannel(
                            TURN_FINISHED,
                            "Turn finished",
                            NotificationManager.IMPORTANCE_DEFAULT,
                        )
                        .apply { description = "A session finished its turn" },
                    NotificationChannel(WATCHING, "Watching", NotificationManager.IMPORTANCE_LOW)
                        .apply {
                            description =
                                "Shown while kiln keeps the connection open for notifications"
                        },
                )
            )
    }

    fun openApp(context: Context, code: Int, session: Pair<String, String>? = null): PendingIntent {
        val intent =
            Intent(context, MainActivity::class.java)
                .addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP
                )
        if (session != null)
            intent
                .setAction(OPEN_SESSION)
                .putExtra(EXTRA_ORIGIN, session.first)
                .putExtra(EXTRA_SESSION, session.second)
        return PendingIntent.getActivity(
            context,
            code,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun notificationId(origin: String, session: String) =
        (origin + "\n" + session).hashCode()

    /** Removes the session's alert, and the machine's summary once nothing is left under it. */
    fun clear(context: Context, origin: String, session: String) {
        val notifications = context.getSystemService(NotificationManager::class.java)
        notifications.cancel(notificationId(origin, session))
        val left =
            notifications.activeNotifications.any {
                it.notification.group == origin &&
                    it.id != origin.hashCode() &&
                    it.id != notificationId(origin, session)
            }
        if (!left) notifications.cancel(origin.hashCode())
    }

    /**
     * Clears each alert from this machine that has been read there: its session is working again,
     * was attached to or typed in after the alert, or is no longer listed.
     */
    fun clearRead(context: Context, origin: String, snapshot: Snapshot) {
        val notifications = context.getSystemService(NotificationManager::class.java)
        for (shown in notifications.activeNotifications) {
            if (shown.notification.group != origin) continue
            val session = shown.notification.extras.getString(EXTRA_SESSION) ?: continue
            val at = shown.notification.extras.getLong(EXTRA_AT)
            val row = snapshot.rows.find { it.id == session }
            // The machine's first snapshot lists nothing yet, which is not every session closing.
            val closed = row == null && snapshot.updated > at
            if (closed || (row != null && isRead(row, at))) clear(context, origin, session)
        }
    }

    /** Records `alert` as shown and returns false when it already was. */
    @Synchronized
    private fun firstDelivery(context: Context, origin: String, alert: TurnAlert): Boolean {
        val preferences = context.getSharedPreferences("alerts", Context.MODE_PRIVATE)
        val recent = RecentAlerts(preferences.getString("recent", "").orEmpty())
        if (!recent.add(RecentAlerts.key(origin, alert))) return false
        preferences.edit().putString("recent", recent.toString()).commit()
        return true
    }

    fun show(context: Context, host: Host, alert: TurnAlert) {
        if (!firstDelivery(context, host.origin, alert)) return
        createChannels(context)
        val notifications = context.getSystemService(NotificationManager::class.java)
        val title = alert.title.ifBlank { "${agentName(alert.agent)} session" }
        val id = notificationId(host.origin, alert.session)
        notifications.notify(
            id,
            Notification.Builder(context, if (alert.waiting) NEEDS_INPUT else TURN_FINISHED)
                .setSmallIcon(R.drawable.icon)
                .setContentTitle(
                    "$title · ${if (alert.waiting) "Needs input" else "Turn finished"}"
                )
                .setContentText("${agentName(alert.agent)} · ${tildePath(alert.cwd)}")
                .setSubText(host.name)
                .setGroup(host.origin)
                .setAutoCancel(true)
                .setContentIntent(openApp(context, id, host.origin to alert.session))
                .addExtras(
                    android.os.Bundle().apply {
                        putString(EXTRA_SESSION, alert.session)
                        putLong(EXTRA_AT, alert.at)
                    }
                )
                .build(),
        )
        notifications.notify(
            host.origin.hashCode(),
            Notification.Builder(context, TURN_FINISHED)
                .setSmallIcon(R.drawable.icon)
                .setSubText(host.name)
                .setGroup(host.origin)
                .setGroupSummary(true)
                .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
                .setAutoCancel(true)
                .setContentIntent(openApp(context, host.origin.hashCode()))
                .build(),
        )
    }
}
