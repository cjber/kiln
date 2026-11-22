package com.cjber.kiln

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

private const val NEEDS_INPUT = "needs-input"
private const val TURN_FINISHED = "turn-finished"
private const val CHECKS_FAILED = "checks-failed"
private const val ACCOUNTS = "accounts"
const val OPEN_SESSION = "com.cjber.kiln.OPEN_SESSION"
const val EXTRA_ORIGIN = "origin"
const val EXTRA_SESSION = "session"
private const val EXTRA_AT = "com.cjber.kiln.at"
private const val EXTRA_FAILING = "com.cjber.kiln.failing"

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

/** One session's pull request checks failing, from the live connection or from a push. */
data class FailingAlert(
    val session: String,
    val agent: Agent,
    val title: String,
    val cwd: String,
    val pr: Int,
    val at: Long,
) {
    companion object {
        fun of(alert: TurnAlert, pr: Int) =
            FailingAlert(alert.session, alert.agent, alert.title, alert.cwd, pr, alert.at)
    }
}

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
        fun key(origin: String, alert: TurnAlert) = key(origin, alert.session, alert.at)

        fun key(origin: String, alert: FailingAlert) =
            key(origin, "failing\t${alert.session}", alert.at)

        /** An account alert: a session moved to one, or one that has allowance again. */
        fun accountKey(origin: String, alert: TurnAlert) =
            key(origin, "account\t${alert.session}", alert.at)

        private fun key(origin: String, session: String, at: Long) =
            listOf(origin, session, at.toString()).joinToString("\t").replace('\n', ' ')
    }
}

/** Whether an alert shown at [at], by the machine's clock, has been read on that machine. */
fun isRead(row: Row, at: Long): Boolean = row.activity == Activity.WORKING || row.seen > at

/** A failing alert is cleared once the session's pull request is no longer failing. */
fun isFixed(row: Row): Boolean = row.stage != Stage.FAILING

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
                    NotificationChannel(
                            CHECKS_FAILED,
                            "Checks failed",
                            NotificationManager.IMPORTANCE_DEFAULT,
                        )
                        .apply { description = "A session's pull request checks failed" },
                    NotificationChannel(
                            ACCOUNTS,
                            "Accounts",
                            NotificationManager.IMPORTANCE_DEFAULT,
                        )
                        .apply {
                            description =
                                "A session moved to another account, or an account has allowance again"
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

    /** Its own id, so a turn alert for the same session never replaces it. */
    private fun failingId(origin: String, session: String) =
        (origin + "\nfailing\n" + session).hashCode()

    /**
     * Removes the session's turn alert, and the machine's summary once nothing is left under it.
     */
    fun clear(context: Context, origin: String, session: String) =
        cancel(context, origin, notificationId(origin, session))

    /**
     * Removes the session's failing alert, and the summary once nothing is left under it. A clear
     * sent [before] the shown alert is for an earlier failure, delivered late, and leaves it.
     */
    fun clearFailing(
        context: Context,
        origin: String,
        session: String,
        before: Long = Long.MAX_VALUE,
    ) {
        val id = failingId(origin, session)
        val shown =
            context.getSystemService(NotificationManager::class.java).activeNotifications.find {
                it.id == id
            }
        if (shown != null && shown.notification.extras.getLong(EXTRA_AT) > before) return
        cancel(context, origin, id)
    }

    private fun cancel(context: Context, origin: String, id: Int) {
        val notifications = context.getSystemService(NotificationManager::class.java)
        notifications.cancel(id)
        val left =
            notifications.activeNotifications.any {
                it.notification.group == origin && it.id != origin.hashCode() && it.id != id
            }
        if (!left) notifications.cancel(origin.hashCode())
    }

    /**
     * Clears each alert from this machine that has been read there: its session is working again,
     * was attached to or typed in after the alert, or is no longer listed. A failing alert is
     * cleared once its pull request is no longer failing, or its session is no longer listed.
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
            if (shown.notification.extras.getBoolean(EXTRA_FAILING)) {
                if (closed || (row != null && isFixed(row))) clearFailing(context, origin, session)
            } else if (closed || (row != null && isRead(row, at))) clear(context, origin, session)
        }
    }

    /** Records the alert's [key] as shown and returns false when it already was. */
    @Synchronized
    private fun firstDelivery(context: Context, key: String): Boolean {
        val preferences = context.getSharedPreferences("alerts", Context.MODE_PRIVATE)
        val recent = RecentAlerts(preferences.getString("recent", "").orEmpty())
        if (!recent.add(key)) return false
        preferences.edit().putString("recent", recent.toString()).commit()
        return true
    }

    fun show(context: Context, host: Host, alert: TurnAlert) {
        if (!firstDelivery(context, RecentAlerts.key(host.origin, alert))) return
        post(
            context,
            host,
            notificationId(host.origin, alert.session),
            if (alert.waiting) NEEDS_INPUT else TURN_FINISHED,
            if (alert.waiting) "Needs input" else "Turn finished",
            alert.session,
            alert.agent,
            alert.title,
            alert.cwd,
            alert.at,
            failing = false,
        )
    }

    fun showFailing(context: Context, host: Host, alert: FailingAlert) {
        if (!firstDelivery(context, RecentAlerts.key(host.origin, alert))) return
        post(
            context,
            host,
            failingId(host.origin, alert.session),
            CHECKS_FAILED,
            if (alert.pr > 0) "PR #${alert.pr} checks failed" else "Checks failed",
            alert.session,
            alert.agent,
            alert.title,
            alert.cwd,
            alert.at,
            failing = true,
        )
    }

    /**
     * The session now runs on [account]. It works again at once, which would read a turn alert, so
     * this one stays until it is opened or dismissed.
     */
    fun showMoved(context: Context, host: Host, alert: TurnAlert, account: String) {
        if (account.isEmpty()) return
        if (!firstDelivery(context, RecentAlerts.accountKey(host.origin, alert))) return
        post(
            context,
            host,
            accountId(host.origin, alert.session),
            ACCOUNTS,
            "Moved to account $account",
            alert.session,
            alert.agent,
            alert.title,
            alert.cwd,
            alert.at,
            failing = false,
            clears = false,
        )
    }

    /** [account] of the alert's agent has allowance again; it opens the app, not a session. */
    fun showAvailable(context: Context, host: Host, alert: TurnAlert, account: String) {
        if (!firstDelivery(context, RecentAlerts.accountKey(host.origin, alert))) return
        val agent = agentName(alert.agent)
        val id = accountId(host.origin, alert.session)
        post(
            context,
            host,
            id,
            ACCOUNTS,
            if (account.isEmpty()) "$agent has allowance again"
            else "$agent account $account has allowance again",
            "Its usage limit has reset",
            openApp(context, id),
            null,
        )
    }

    private fun accountId(origin: String, session: String) =
        (origin + "\naccount\n" + session).hashCode()

    private fun post(
        context: Context,
        host: Host,
        id: Int,
        channel: String,
        what: String,
        session: String,
        agent: Agent,
        title: String,
        cwd: String,
        at: Long,
        failing: Boolean,
        clears: Boolean = true,
    ) =
        post(
            context,
            host,
            id,
            channel,
            "${title.ifBlank { "${agentName(agent)} session" }} · $what",
            "${agentName(agent)} · ${tildePath(cwd)}",
            openApp(context, id, host.origin to session),
            // Without its session an alert is never cleared as read on the machine.
            if (clears)
                android.os.Bundle().apply {
                    putString(EXTRA_SESSION, session)
                    putLong(EXTRA_AT, at)
                    putBoolean(EXTRA_FAILING, failing)
                }
            else null,
        )

    private fun post(
        context: Context,
        host: Host,
        id: Int,
        channel: String,
        heading: String,
        text: String,
        open: PendingIntent,
        extras: android.os.Bundle?,
    ) {
        createChannels(context)
        val notifications = context.getSystemService(NotificationManager::class.java)
        notifications.notify(
            id,
            Notification.Builder(context, channel)
                .setSmallIcon(R.drawable.icon)
                .setContentTitle(heading)
                .setContentText(text)
                .setSubText(host.name)
                .setGroup(host.origin)
                .setAutoCancel(true)
                .setContentIntent(open)
                .apply { if (extras != null) addExtras(extras) }
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
