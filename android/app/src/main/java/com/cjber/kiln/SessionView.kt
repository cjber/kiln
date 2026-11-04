package com.cjber.kiln

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

enum class ItemKind {
    YOU,
    AGENT,
    NOTICE,
    TOOL,
}

/** One line of the conversation; a tool call carries its result once the agent has one. */
data class Line(
    val id: String,
    val kind: ItemKind,
    val text: String,
    val tool: String = "",
    val result: String? = null,
    val error: Boolean = false,
)

data class Abilities(val read: Boolean, val reply: String?, val stop: Boolean)

data class ViewPage(
    val abilities: Abilities,
    val lines: List<Line>,
    val cursor: String,
    val reset: Boolean,
)

private const val maxLines = 1_000

/**
 * Parse one view response. Results attach to the tool call they answer, here or in `held` from an
 * earlier page, so the screen draws each call once with its outcome.
 */
fun parseView(text: String, held: List<Line> = emptyList()): ViewPage {
    val json = JSONObject(text)
    val abilities = json.getJSONObject("abilities")
    val reset = json.getBoolean("reset")
    val lines = if (reset) mutableListOf() else held.toMutableList()
    val items = json.getJSONArray("items")
    for (index in 0 until items.length()) {
        val item = items.getJSONObject(index)
        val id = item.getString("id")
        val body = item.optString("text")
        when (item.getString("kind")) {
            "you" -> lines += Line(id, ItemKind.YOU, body)
            "agent" -> lines += Line(id, ItemKind.AGENT, body)
            "notice" -> lines += Line(id, ItemKind.NOTICE, body)
            "tool" -> lines += Line(id, ItemKind.TOOL, body, tool = item.optString("tool"))
            "result" -> {
                val of = item.optString("of")
                val at = lines.indexOfLast { it.kind == ItemKind.TOOL && it.id == of }
                if (at >= 0)
                    lines[at] = lines[at].copy(result = body, error = item.optBoolean("error"))
            }
        }
    }
    return ViewPage(
        Abilities(
            read = abilities.optBoolean("read"),
            reply = abilities.optString("reply").ifBlank { null },
            stop = abilities.optBoolean("stop"),
        ),
        lines.takeLast(maxLines),
        json.getString("cursor"),
        reset,
    )
}

/**
 * Reads and writes one session's view on a paired machine; every call blocks, so run it off the UI
 * thread.
 */
class SessionClient(
    private val host: Host,
    private val session: String,
    private val client: OkHttpClient =
        OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(10, TimeUnit.SECONDS)
            .callTimeout(20, TimeUnit.SECONDS)
            .build(),
) {
    private val base =
        "${httpsOrigin(host.origin)}/v1/sessions/${URLEncoder.encode(session, "UTF-8").replace("+", "%20")}"

    private fun call(request: Request.Builder): Pair<Int, String> =
        client
            .newCall(request.header("Authorization", "Bearer ${host.token}").build())
            .execute()
            .use { it.code to it.body!!.string() }

    fun view(cursor: String): Pair<Int, String> =
        call(
            Request.Builder()
                .url(
                    if (cursor.isEmpty()) "$base/view"
                    else "$base/view?cursor=${URLEncoder.encode(cursor, "UTF-8")}"
                )
        )

    private fun post(path: String, body: JSONObject) =
        call(
            Request.Builder()
                .url("$base/$path")
                .post(body.toString().toRequestBody("application/json".toMediaType()))
        )

    /** The id makes a retry of the same message harmless: the machine keeps one copy. */
    fun send(id: String, text: String) = post("input", JSONObject().put("id", id).put("text", text))

    fun interrupt() = post("interrupt", JSONObject())
}

private fun errorText(code: Int, body: String): String =
    try {
        JSONObject(body).getString("error")
    } catch (_: Exception) {
        "The machine answered $code"
    }

@Composable
fun SessionView(host: Host, row: Row, back: () -> Unit, details: () -> Unit) {
    BackHandler(onBack = back)
    val client = remember(host, row.id) { SessionClient(host, row.id) }
    var lines by remember(row.id) { mutableStateOf(emptyList<Line>()) }
    var abilities by remember(row.id) { mutableStateOf<Abilities?>(null) }
    var problem by remember(row.id) { mutableStateOf("") }
    var status by remember(row.id) { mutableStateOf("") }
    var draft by rememberSaveable(row.id) { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val list = rememberLazyListState()
    // The view is polled while open; each poll returns only what was appended since the cursor.
    LaunchedEffect(client) {
        var cursor = ""
        while (true) {
            try {
                val (code, body) = withContext(Dispatchers.IO) { client.view(cursor) }
                if (code == 200) {
                    val page = parseView(body, lines)
                    cursor = page.cursor
                    abilities = page.abilities
                    if (page.reset || page.lines.size != lines.size || page.lines != lines)
                        lines = page.lines
                    problem = ""
                } else problem = errorText(code, body)
            } catch (_: Exception) {
                problem = "Cannot reach ${host.name}"
            }
            delay(1_500)
        }
    }
    LaunchedEffect(lines.size) { if (lines.isNotEmpty()) list.animateScrollToItem(lines.size - 1) }
    fun act(work: () -> Pair<Int, String>, done: (Int, String) -> Unit) {
        sending = true
        scope.launch {
            try {
                val (code, body) = withContext(Dispatchers.IO) { work() }
                done(code, body)
            } catch (_: Exception) {
                status = "Cannot reach ${host.name}; try again"
            } finally {
                sending = false
            }
        }
    }
    Column(Modifier.fillMaxSize().background(Tui.bg).systemBarsPadding().imePadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = back) { Text("‹ Back", color = Tui.fg) }
            Column(Modifier.weight(1f)) {
                Text(
                    row.title,
                    color = activityColor(row.activity),
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                )
                Text(
                    "${agentName(row.agent)} · ${activityName(row.activity).lowercase()}",
                    color = Tui.fgDim,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            if (abilities?.stop == true && row.activity == Activity.WORKING)
                TextButton(
                    enabled = !sending,
                    onClick = {
                        act({ client.interrupt() }) { code, body ->
                            status = if (code == 200) "Stopping" else errorText(code, body)
                        }
                    },
                ) {
                    Text("Stop", color = Tui.red)
                }
            TextButton(onClick = details) { Text("⋮", color = Tui.fg) }
        }
        HorizontalDivider(color = Tui.bg2)
        if (problem.isNotEmpty())
            Text(problem, color = Tui.yellow, modifier = Modifier.padding(12.dp))
        if (abilities?.read == false)
            Text(
                "This session's conversation cannot be shown in kiln yet. Use ⋮ to open it in its own app.",
                color = Tui.fgDim,
                modifier = Modifier.padding(16.dp),
            )
        SelectionContainer(Modifier.weight(1f)) {
            LazyColumn(
                state = list,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(lines, key = { it.id }) { line -> ConversationLine(line) }
            }
        }
        if (status.isNotEmpty())
            Text(
                status,
                color = Tui.fgDim,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(horizontal = 12.dp),
            )
        val refused = abilities?.reply
        if (refused != null)
            Text(
                refused.replaceFirstChar { it.uppercase() },
                color = Tui.fgDim,
                modifier = Modifier.padding(12.dp),
            )
        else
            Row(
                Modifier.fillMaxWidth().padding(8.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Reply to ${agentName(row.agent)}") },
                    maxLines = 6,
                )
                Button(
                    enabled = !sending && draft.isNotBlank() && abilities != null,
                    shape = MaterialTheme.shapes.small,
                    onClick = {
                        val text = draft.trimEnd()
                        val id = UUID.randomUUID().toString()
                        act({ client.send(id, text) }) { code, body ->
                            if (code == 200) {
                                draft = ""
                                val json = JSONObject(body)
                                status =
                                    if (json.optBoolean("queued"))
                                        "Queued: ${json.optString("reason")}"
                                    else ""
                            } else status = errorText(code, body)
                        }
                    },
                ) {
                    Text("Send")
                }
            }
    }
}

@Composable
private fun ConversationLine(line: Line) {
    val mono = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace)
    when (line.kind) {
        ItemKind.YOU ->
            Text(
                "› ${line.text}",
                color = Tui.peach,
                style = mono,
                modifier =
                    Modifier.fillMaxWidth()
                        .background(Tui.bg2, RoundedCornerShape(6.dp))
                        .padding(8.dp),
            )
        ItemKind.AGENT ->
            Text(line.text, color = Tui.fgBright, style = MaterialTheme.typography.bodyMedium)
        ItemKind.NOTICE ->
            Text(
                line.text.lines().first().take(160),
                color = Tui.comment,
                style = mono,
                maxLines = 2,
            )
        ItemKind.TOOL ->
            Column {
                Text(
                    "● ${line.tool}  ${line.text}",
                    color = if (line.error) Tui.red else Tui.teal,
                    style = mono,
                    maxLines = 3,
                )
                line.result?.let {
                    if (it.isNotBlank())
                        Text(
                            "  ⎿ " + it.replace("\n", "\n    "),
                            color = if (line.error) Tui.red else Tui.fgDim,
                            style = mono,
                            maxLines = 4,
                        )
                }
            }
    }
}
