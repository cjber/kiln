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
)

data class Snapshot(
    val instance: String,
    val sequence: Long,
    val updated: Long,
    val problem: String,
    val rows: List<Row>,
)

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

/** `kiln setup` serves OpenCode's web UI on the paired machine at this HTTPS port. */
const val OPENCODE_WEB_PORT = 4096

/** A session page of OpenCode's web UI on the machine this phone paired with, and nowhere else. */
private fun opencodeLink(uri: URI, origin: String?): Boolean {
    val host = origin?.let { runCatching { URI(it).host }.getOrNull() } ?: return false
    val key =
        java.util.Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString("https://$host:$OPENCODE_WEB_PORT".toByteArray())
    return uri.scheme == "https" &&
        uri.rawUserInfo == null &&
        uri.rawQuery == null &&
        uri.rawFragment == null &&
        uri.host == host &&
        uri.port == OPENCODE_WEB_PORT &&
        uri.rawPath.matches(Regex("/server/$key/session/ses_[A-Za-z0-9]+"))
}

/** `origin` is the paired kiln server, the only host an OpenCode link may point at. */
fun safeLink(agent: Agent, value: String, origin: String? = null): String? {
    val uri =
        try {
            URI(value)
        } catch (_: Exception) {
            return null
        }
    if (agent == Agent.OPENCODE) return value.takeIf { opencodeLink(uri, origin) }
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
            )
        }
    return Snapshot(
        json.getString("instance"),
        json.getLong("sequence"),
        json.getLong("updatedAt"),
        json.getString("problem"),
        rows,
    )
}
