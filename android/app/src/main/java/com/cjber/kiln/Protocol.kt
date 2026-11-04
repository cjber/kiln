package com.cjber.kiln

import java.net.URI
import org.json.JSONObject

data class Host(val origin: String, val name: String, val token: String)

enum class Agent(val id: String) {
    CLAUDE("claude"),
    CODEX("codex"),
    OPENCODE("opencode"),
    PI("pi"),
}

/** OTHER is a place kind this version does not know; it renders as a native terminal. */
enum class Place(val id: String) {
    CLOUD("cloud"),
    KILN("kiln"),
    BACKGROUND("background"),
    KITTY("kitty"),
    ELSEWHERE("elsewhere"),
    OTHER(""),
}

enum class Activity(val id: String) {
    WORKING("working"),
    WAITING("waiting"),
    IDLE("idle"),
    COMPLETED("completed"),
    STOPPED("stopped"),
    UNKNOWN("unknown"),
}

enum class ConnectionState {
    CONNECTING,
    CONNECTED,
    DISCONNECTED,
    INVALID,
    REVOKED,
}

data class Row(
    val id: String,
    val agent: Agent,
    val title: String,
    val cwd: String,
    val branch: String,
    val activity: Activity,
    val where: Place,
    val started: Long,
    val active: Long,
    val url: String?,
    val label: String,
    val exact: Boolean,
    val parent: String? = null,
    /** Kiln's tmux name for a session it runs, which a session this phone started is found by. */
    val terminal: String? = null,
    /** When the person last attached to or typed in its terminal on the machine, by its clock. */
    val seen: Long = 0,
)

data class Snapshot(
    val instance: String,
    val sequence: Long,
    val updated: Long,
    val problem: String,
    val rows: List<Row>,
    /** Whether the machine takes new sessions and prompts from this phone. */
    val write: Boolean = false,
)

/**
 * Where the machine offers to start a session, most recent first, and the agents it has enabled.
 */
data class StartOptions(val directories: List<String>, val agents: List<Agent>)

fun parseStartOptions(source: String): StartOptions {
    val json = JSONObject(source)
    val directories = json.getJSONArray("directories")
    val agents = json.getJSONArray("agents")
    require(directories.length() <= 1_000)
    return StartOptions(
        (0 until directories.length()).map { directories.getString(it) },
        (0 until agents.length()).mapNotNull { index ->
            Agent.entries.find { it.id == agents.getString(index) }
        },
    )
}

/** The tmux name of a session the machine just started. */
fun parseStarted(source: String): String {
    val terminal = JSONObject(source).getString("terminal")
    require(terminal.matches(Regex("[a-z]+-[A-Za-z0-9-]{1,64}")))
    return terminal
}

/** What the send box shows after a prompt: delivered, or why it waits, in kiln msg's own words. */
fun parseSent(source: String): String {
    val json = JSONObject(source)
    return if (json.getBoolean("delivered")) "Delivered"
    else "Waiting: ${json.getString("reason").replaceFirstChar { it.uppercase() }}"
}

/** A session on the computer opens in the app's own view on a machine that takes writes; a cloud task opens its details. */
fun opensView(snapshot: Snapshot?, row: Row): Boolean = snapshot?.write == true && row.where != Place.CLOUD

/** Phones send prompts only to sessions that are running somewhere kiln can reach. */
fun canMessage(row: Row): Boolean =
    row.where != Place.CLOUD &&
        row.activity != Activity.COMPLETED &&
        row.activity != Activity.STOPPED

/**
 * When the phone last received a successful load. The machine leaves `updatedAt` unchanged after a
 * failed refresh, so a changed value marks a new load; the phone times it with its own clock
 * because the two clocks need not agree.
 */
fun receivedAt(previous: Snapshot?, next: Snapshot, received: Long, now: Long): Long =
    if (previous?.updated != next.updated) now else received

fun httpsOrigin(value: String): String {
    val uri = URI(value)
    require(
        uri.scheme == "https" &&
            !uri.host.isNullOrBlank() &&
            uri.rawUserInfo == null &&
            uri.rawQuery == null &&
            uri.rawFragment == null &&
            (uri.path.isNullOrEmpty() || uri.path == "/")
    ) {
        "Use an HTTPS server URL without a path"
    }
    return "https://${uri.rawAuthority}"
}

fun invitation(value: String): Pair<String, String> {
    val uri = URI(value.trim())
    require(uri.scheme == "kiln" && uri.host == "pair" && uri.rawFragment == null) {
        "Paste a kiln pairing invitation"
    }
    val parts =
        uri.rawQuery.orEmpty().split('&').associate { part ->
            val fields = part.split('=', limit = 2)
            require(fields.size == 2)
            java.net.URLDecoder.decode(fields[0], "UTF-8") to
                java.net.URLDecoder.decode(fields[1], "UTF-8")
        }
    val code = parts["code"].orEmpty()
    require(code.matches(Regex("[A-Za-z0-9_-]{43}"))) { "Invalid pairing code" }
    return httpsOrigin(parts["server"].orEmpty()) to code
}

/** The message the pairing invitation field shows for `value`, or "" when it can be used. */
fun invitationError(value: String): String =
    try {
        invitation(value)
        ""
    } catch (_: Exception) {
        "Paste a valid kiln invitation with an HTTPS server URL"
    }

/**
 * OpenCode sessions open through a one-use sign-in path on the paired kiln server, which signs the
 * browser in to OpenCode and redirects to the session. Resolving it against `origin` keeps it on
 * the paired machine.
 */
private fun opencodeLink(value: String, origin: String?): String? {
    if (origin == null || !value.matches(Regex("/opencode/[A-Za-z0-9_-]{32}"))) return null
    val base = runCatching { URI(origin) }.getOrNull() ?: return null
    if (
        base.scheme != "https" || base.rawUserInfo != null || base.rawPath.trimEnd('/').isNotEmpty()
    )
        return null
    return origin.trimEnd('/') + value
}

/** `origin` is the paired kiln server, the only host an OpenCode link may point at. */
fun safeLink(agent: Agent, value: String, origin: String? = null): String? {
    if (agent == Agent.OPENCODE) return opencodeLink(value, origin)
    val uri =
        try {
            URI(value)
        } catch (_: Exception) {
            return null
        }
    if (
        uri.scheme != "https" ||
            uri.rawUserInfo != null ||
            uri.port != -1 ||
            uri.rawFragment != null
    )
        return null
    return when (agent) {
        Agent.CLAUDE ->
            value.takeIf {
                uri.host == "claude.ai" &&
                    uri.rawQuery == null &&
                    uri.rawPath.matches(Regex("/code/(session|cse)_[A-Za-z0-9_-]+"))
            }
        Agent.CODEX ->
            value.takeIf {
                uri.host == "chatgpt.com" &&
                    ((uri.rawQuery == null &&
                        (uri.rawPath == "/codex" ||
                            uri.rawPath.matches(Regex("/codex/tasks/[A-Za-z0-9_-]+")))) ||
                        (uri.rawPath.matches(
                            Regex(
                                "/codex/remote/thread/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
                            )
                        ) &&
                            uri.rawQuery?.matches(
                                Regex("hostId=slingshot%3Aenv_[A-Za-z0-9_-]+%3A8765")
                            ) == true))
            }
        Agent.OPENCODE,
        Agent.PI -> null
    }
}

fun parseSnapshot(source: String, origin: String? = null): Snapshot {
    val json = JSONObject(source)
    require(json.getInt("version") == 1)
    val array = json.getJSONArray("sessions")
    require(array.length() <= 10_000)
    val rows =
        (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            val agent = item.getString("agent").let { id -> Agent.entries.first { it.id == id } }
            val handoff = item.getJSONObject("handoff")
            val url =
                if (handoff.has("url")) safeLink(agent, handoff.getString("url"), origin) else null
            Row(
                item.getString("id"),
                agent,
                item.getString("title"),
                item.getString("cwd"),
                item.optString("branch"),
                // A finished background job reports how it ended instead of an activity.
                (item.optString("lifecycle").takeIf { it == "completed" || it == "stopped" }
                        ?: item.optString("activity"))
                    .let { id -> Activity.entries.find { it.id == id } ?: Activity.UNKNOWN },
                item.getString("where").let { id ->
                    Place.entries.find { it.id == id } ?: Place.OTHER
                },
                item.getLong("startedAt"),
                item.optLong("lastActiveAt"),
                url,
                if (url != null) handoff.getString("label")
                else handoff.optString("reason", "No verified session link"),
                handoff.optBoolean("exact"),
                item.optString("parentId").takeIf { it.isNotEmpty() },
                item.optString("terminal").takeIf { it.isNotEmpty() },
                item.optLong("seenAt"),
            )
        }
    return Snapshot(
        json.getString("instance"),
        json.getLong("sequence"),
        json.getLong("updatedAt"),
        json.getString("problem"),
        rows,
        json.optBoolean("write"),
    )
}
