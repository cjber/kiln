package com.cjber.kiln

import java.net.URI
import org.json.JSONObject

data class Host(val origin: String, val name: String, val token: String)

data class Row(
    val id: String,
    val agent: String,
    val title: String,
    val cwd: String,
    val branch: String,
    val activity: String,
    val where: String,
    val started: Long,
    val active: Long,
    val url: String?,
    val label: String,
    val exact: Boolean,
    val parent: String? = null,
    val piRemote: Boolean = false,
)

data class Snapshot(
    val instance: String,
    val sequence: Long,
    val updated: Long,
    val problem: String,
    val rows: List<Row>,
)

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

fun safeLink(agent: String, value: String): String? {
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
        "claude" ->
            value.takeIf {
                uri.host == "claude.ai" &&
                    uri.rawQuery == null &&
                    uri.rawPath.matches(Regex("/code/(session|cse)_[A-Za-z0-9_-]+"))
            }
        "codex" ->
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
        else -> null
    }
}

fun parseSnapshot(source: String): Snapshot {
    val json = JSONObject(source)
    require(json.getInt("version") == 1)
    val array = json.getJSONArray("sessions")
    require(array.length() <= 10_000)
    val rows =
        (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            val agent = item.getString("agent")
            require(agent in listOf("claude", "codex", "pi"))
            val handoff = item.getJSONObject("handoff")
            val url = if (handoff.has("url")) safeLink(agent, handoff.getString("url")) else null
            Row(
                item.getString("id"),
                agent,
                item.getString("title"),
                item.getString("cwd"),
                item.optString("branch"),
                item.optString("activity", "unknown"),
                item.getString("where"),
                item.getLong("startedAt"),
                item.optLong("lastActiveAt"),
                url,
                if (url != null) handoff.getString("label")
                else handoff.optString("reason", "No verified session link"),
                handoff.optBoolean("exact"),
                item.optString("parentId").takeIf { it.isNotEmpty() },
                agent == "pi" && item.optBoolean("piRemote"),
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
