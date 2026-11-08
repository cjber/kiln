package com.cjber.kiln

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import java.net.URLEncoder
import java.text.DateFormat
import java.util.Date
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
import org.json.JSONArray
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
    val at: Long = 0,
)

data class Abilities(val read: Boolean, val reply: String?, val stop: Boolean)

/**
 * One answer to a question the agent is waiting on; a typed one sends the reply box's text with it.
 */
data class MenuOption(val number: Int, val label: String, val detail: String, val typed: Boolean)

/** The menu the agent's terminal shows, as the machine read it; `key` names this exact question. */
data class Menu(
    val key: String,
    val question: String,
    val context: List<String>,
    val options: List<MenuOption>,
)

/** A file picked to send; `path` is where the machine stored it, once it has. */
data class Attachment(
    val id: String,
    val name: String,
    val path: String? = null,
    val failed: String? = null,
)

data class ViewPage(
    val abilities: Abilities,
    val menu: Menu?,
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
            "you" -> lines += Line(id, ItemKind.YOU, body, at = item.optLong("at"))
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
        json.optJSONObject("prompt")?.let(::parseMenu),
        lines.takeLast(maxLines),
        json.getString("cursor"),
        reset,
    )
}

private fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }

internal fun parseMenu(json: JSONObject) =
    Menu(
        key = json.getString("key"),
        question = json.optString("question"),
        context =
            json.optJSONArray("context")?.let { list ->
                (0 until list.length()).map { list.getString(it) }
            } ?: emptyList(),
        options =
            json.getJSONArray("options").objects().map {
                MenuOption(
                    it.getInt("number"),
                    it.getString("label"),
                    it.optString("detail"),
                    it.has("typed") && !it.isNull("typed"),
                )
            },
    )

/** One file a prompt changed, as `GET /v1/sessions/<id>/edits` reports it. */
data class EditFile(
    val file: String,
    val added: Int,
    val removed: Int,
    val created: Boolean,
    val deleted: Boolean,
    /** Written whole, so how many lines it replaced is unknown. */
    val rewritten: Boolean,
)

/** What one prompt changed: newest prompt first. */
data class EditTurn(
    val prompt: String,
    val files: List<EditFile>,
    val added: Int,
    val removed: Int,
    val rewritten: Boolean,
)

internal fun parseEdits(body: String): List<EditTurn> =
    JSONObject(body).getJSONArray("turns").objects().map { turn ->
        EditTurn(
            turn.optString("prompt"),
            turn.getJSONArray("files").objects().map {
                EditFile(
                    it.getString("file"),
                    it.getInt("added"),
                    it.getInt("removed"),
                    it.optBoolean("created"),
                    it.optBoolean("deleted"),
                    it.optBoolean("rewritten"),
                )
            },
            turn.getInt("added"),
            turn.getInt("removed"),
            turn.optBoolean("rewritten"),
        )
    }

/**
 * The message that carries attached files names where the machine stored them, so the agent can
 * open them.
 */
internal fun withAttachments(text: String, paths: List<String>): String =
    if (paths.isEmpty()) text
    else
        (if (text.isBlank()) "" else "${text.trimEnd()}\n\n") +
            "Attached files:\n" +
            paths.joinToString("\n")

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

    private fun call(request: Request.Builder, through: OkHttpClient = client): Pair<Int, String> =
        through
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

    fun edits(): Pair<Int, String> = call(Request.Builder().url("$base/edits"))

    private fun post(path: String, body: JSONObject) =
        call(
            Request.Builder()
                .url("$base/$path")
                .post(body.toString().toRequestBody("application/json".toMediaType()))
        )

    /** The id makes a retry of the same message harmless: the machine keeps one copy. */
    fun send(id: String, text: String) =
        post("messages", JSONObject().put("id", id).put("text", text))

    fun interrupt() = post("interrupt", JSONObject())

    fun answer(key: String, option: Int, text: String?) =
        post(
            "prompt",
            JSONObject().put("key", key).put("option", option).apply {
                if (text != null) put("text", text)
            },
        )

    /** A file can take a while over a phone connection, so it gets longer than a message. */
    fun upload(name: String, bytes: ByteArray) =
        call(
            Request.Builder()
                .url("$base/files?name=${URLEncoder.encode(name, "UTF-8").replace("+", "%20")}")
                .post(bytes.toRequestBody("application/octet-stream".toMediaType())),
            client.newBuilder().callTimeout(2, TimeUnit.MINUTES).build(),
        )
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
    var menu by remember(row.id) { mutableStateOf<Menu?>(null) }
    var attachments by remember(row.id) { mutableStateOf(emptyList<Attachment>()) }
    var showEdits by remember(row.id) { mutableStateOf(false) }
    var edits by remember(row.id) { mutableStateOf<List<EditTurn>?>(null) }
    val context = LocalContext.current
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
                    menu = page.menu
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
    // The edits are read while they are shown; the machine sends counts and paths, never file text.
    LaunchedEffect(client, showEdits) {
        while (showEdits) {
            try {
                val (code, body) = withContext(Dispatchers.IO) { client.edits() }
                if (code == 200) edits = parseEdits(body) else problem = errorText(code, body)
            } catch (_: Exception) {
                problem = "Cannot reach ${host.name}"
            }
            delay(5_000)
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
    fun attach(uri: Uri) {
        val picked = Attachment(UUID.randomUUID().toString(), displayName(context, uri))
        attachments = attachments + picked
        fun settle(path: String?, failed: String?) {
            attachments = attachments.map {
                if (it.id == picked.id) it.copy(path = path, failed = failed) else it
            }
        }
        scope.launch {
            try {
                val bytes =
                    withContext(Dispatchers.IO) {
                        context.contentResolver.openInputStream(uri)?.use {
                            readAtMost(it, uploadLimit)
                        }
                    }
                if (bytes == null) return@launch settle(null, "Could not read it")
                if (bytes.size > uploadLimit) return@launch settle(null, "Over 20 MB")
                val (code, body) = withContext(Dispatchers.IO) { client.upload(picked.name, bytes) }
                if (code == 200) settle(JSONObject(body).getString("path"), null)
                else settle(null, errorText(code, body))
            } catch (_: Exception) {
                settle(null, "Cannot reach ${host.name}")
            }
        }
    }
    val pick =
        rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
            uris.forEach(::attach)
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
            TextButton(onClick = { showEdits = !showEdits }) {
                Text(if (showEdits) "Chat" else "Edits", color = Tui.fg)
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
        if (showEdits) EditsList(edits, Modifier.weight(1f))
        else
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
        val stored = attachments.mapNotNull { it.path }
        // A file still sending, or one that failed, holds the message back rather than going
        // missing from it.
        val settled = attachments.all { it.path != null }
        val written =
            if (settled && (draft.isNotBlank() || stored.isNotEmpty()))
                withAttachments(draft.trimEnd(), stored)
            else ""
        menu?.let { waiting ->
            MenuCard(waiting, written, enabled = !sending) { option ->
                val text = if (option.typed) written else null
                act({ client.answer(waiting.key, option.number, text) }) { code, body ->
                    if (code == 200) {
                        menu = null
                        if (text != null) {
                            draft = ""
                            attachments = emptyList()
                        }
                        status = ""
                    } else status = errorText(code, body)
                }
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
        // A session kiln cannot message can still take a typed answer to its menu, which needs the
        // box.
        if (refused == null || menu?.options?.any { it.typed } == true) {
            if (attachments.isNotEmpty())
                Row(
                    Modifier.fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    attachments.forEach { file ->
                        AttachmentChip(file) {
                            attachments = attachments.filter { it.id != file.id }
                        }
                    }
                }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                IconButton(onClick = { pick.launch("*/*") }, modifier = Modifier.size(52.dp)) {
                    Icon(Icons.Default.Add, "Attach files", tint = Tui.fgDim)
                }
                TextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Reply to ${agentName(row.agent)}") },
                    maxLines = 6,
                    shape = RoundedCornerShape(22.dp),
                    colors =
                        TextFieldDefaults.colors(
                            focusedContainerColor = field,
                            unfocusedContainerColor = field,
                            disabledContainerColor = field,
                            focusedIndicatorColor = Color.Transparent,
                            unfocusedIndicatorColor = Color.Transparent,
                            disabledIndicatorColor = Color.Transparent,
                            focusedTextColor = Tui.fgBright,
                            unfocusedTextColor = Tui.fgBright,
                            cursorColor = Tui.orange,
                            focusedPlaceholderColor = Tui.fgDim,
                            unfocusedPlaceholderColor = Tui.fgDim,
                        ),
                )
                FilledIconButton(
                    enabled =
                        !sending && abilities != null && refused == null && written.isNotEmpty(),
                    shape = CircleShape,
                    modifier = Modifier.size(52.dp),
                    colors =
                        IconButtonDefaults.filledIconButtonColors(
                            containerColor = Tui.orange,
                            contentColor = Tui.bg,
                            disabledContainerColor = field,
                            disabledContentColor = Tui.comment,
                        ),
                    onClick = {
                        val text = written
                        val id = UUID.randomUUID().toString()
                        act({ client.send(id, text) }) { code, body ->
                            if (code == 200) {
                                draft = ""
                                attachments = emptyList()
                                val json = JSONObject(body)
                                status =
                                    if (!json.optBoolean("delivered", true))
                                        "Queued: ${json.optString("reason")}"
                                    else ""
                            } else status = errorText(code, body)
                        }
                    },
                ) {
                    Icon(Icons.AutoMirrored.Filled.Send, "Send", Modifier.size(20.dp))
                }
            }
        }
    }
}

@Composable
private fun EditsList(turns: List<EditTurn>?, modifier: Modifier) {
    val mono = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (turns == null) item { Text("Reading edits", color = Tui.fgDim) }
        else if (turns.isEmpty()) item { Text("No files edited yet", color = Tui.fgDim) }
        items(turns.orEmpty()) { turn ->
            Column {
                Text(
                    turn.prompt.ifBlank { "Before the first prompt" },
                    color = Tui.fgBright,
                    maxLines = 2,
                )
                Text(
                    "${turn.files.size} files  +${turn.added}" +
                        if (turn.rewritten) "" else " -${turn.removed}",
                    color = Tui.fgDim,
                    style = MaterialTheme.typography.labelMedium,
                )
                turn.files.forEach { file ->
                    Row(Modifier.padding(start = 8.dp, top = 2.dp)) {
                        Text(
                            file.file.substringAfterLast('/'),
                            color = Tui.fg,
                            style = mono,
                            maxLines = 1,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            when {
                                file.created -> "new "
                                file.deleted -> "deleted "
                                file.rewritten -> "rewritten "
                                else -> ""
                            },
                            color = Tui.fgDim,
                            style = mono,
                        )
                        Text("+${file.added}", color = Tui.green, style = mono)
                        // A file written whole has no removed count to show.
                        if (!file.rewritten)
                            Text(" -${file.removed}", color = Tui.red, style = mono)
                    }
                }
            }
        }
    }
}

@Composable
private fun ConversationLine(line: Line) {
    val mono = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace)
    when (line.kind) {
        ItemKind.YOU ->
            Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (line.at > 0)
                            "you · ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(line.at))}"
                        else "you",
                        color = Tui.orange,
                        style =
                            MaterialTheme.typography.labelSmall.copy(
                                fontFamily = FontFamily.Monospace
                            ),
                    )
                    HorizontalDivider(Modifier.weight(1f).padding(start = 8.dp), color = turnRule)
                }
                Text(
                    line.text,
                    color = Tui.fgBright,
                    style = mono,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        ItemKind.AGENT -> Markdown(line.text)
        ItemKind.NOTICE ->
            Text(
                line.text.lines().first().take(160),
                color = Tui.comment,
                style = mono,
                maxLines = 2,
            )
        ItemKind.TOOL ->
            Column {
                val kind = toolColor(line.tool)
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(color = kind)) { append("● ") }
                        withStyle(SpanStyle(color = kind, fontWeight = FontWeight.Bold)) {
                            append(line.tool)
                        }
                        append("  ${line.text}")
                    },
                    color = Tui.fg,
                    style = mono,
                    maxLines = 2,
                )
                line.result?.let {
                    if (it.isNotBlank())
                        Text(
                            "  ⎿ " + it.trim().replace("\n", "\n    "),
                            color = if (line.error) Tui.red else Tui.fgDim,
                            style = mono,
                            maxLines = 2,
                        )
                }
            }
    }
}

private val field = Color(0xff1c1b1d)
private val turnRule = Color(0xff3a2c22)

/**
 * Edits read purple and lookups grey, so the shell commands that change state stand out in teal.
 */
internal fun toolColor(tool: String): Color =
    when (tool.lowercase()) {
        "edit",
        "multiedit",
        "write",
        "notebookedit",
        "apply_patch",
        "patch" -> Tui.purple
        "read",
        "grep",
        "glob",
        "ls",
        "find",
        "list",
        "webfetch",
        "websearch" -> Tui.fgDim
        else -> Tui.teal
    }

private const val uploadLimit = 20 * 1024 * 1024

/** The stream's bytes, stopping one past the limit so an oversized file is never read whole. */
internal fun readAtMost(input: java.io.InputStream, limit: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(64 * 1024)
    while (out.size() <= limit) {
        val read = input.read(buffer, 0, minOf(buffer.size, limit + 1 - out.size()))
        if (read < 0) break
        out.write(buffer, 0, read)
    }
    return out.toByteArray()
}

private fun displayName(context: Context, uri: Uri): String =
    try {
        context.contentResolver
            .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use {
                if (it.moveToFirst()) it.getString(0) else null
            }
    } catch (_: Exception) {
        null
    } ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file"

@Composable
private fun AttachmentChip(file: Attachment, remove: () -> Unit) {
    Row(
        Modifier.background(field, RoundedCornerShape(16.dp)).padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            when {
                file.failed != null -> "${file.name} · ${file.failed}"
                file.path == null -> "${file.name} · sending"
                else -> file.name
            },
            color =
                if (file.failed != null) Tui.red
                else if (file.path == null) Tui.fgDim else Tui.fgBright,
            style = MaterialTheme.typography.labelMedium,
            maxLines = 1,
            modifier = Modifier.widthIn(max = 220.dp),
        )
        TextButton(onClick = remove, contentPadding = PaddingValues(horizontal = 8.dp)) {
            Text("×", color = Tui.fgDim)
        }
    }
}

/** The question the agent is waiting on, with its answers as buttons. */
@Composable
private fun MenuCard(menu: Menu, written: String, enabled: Boolean, answer: (MenuOption) -> Unit) {
    val mono = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
    Column(
        Modifier.fillMaxWidth()
            .background(Color(0xff1a1819))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            "waiting on you",
            color = Tui.yellow,
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
        )
        if (menu.context.isNotEmpty())
            Text(
                menu.context.takeLast(8).joinToString("\n"),
                color = Tui.fgDim,
                style = mono,
                maxLines = 8,
            )
        Text(menu.question, color = Tui.fgBright, fontWeight = FontWeight.SemiBold)
        menu.options.forEach { option ->
            val ready = enabled && (!option.typed || written.isNotEmpty())
            Surface(
                onClick = { answer(option) },
                enabled = ready,
                shape = RoundedCornerShape(10.dp),
                color = field,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 9.dp)) {
                    Text(
                        "${option.number}. ${option.label}",
                        color = if (ready) Tui.fgBright else Tui.fgDim,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    val note =
                        if (option.typed && written.isEmpty())
                            "Write your answer in the reply box first"
                        else if (option.typed) "Sends: ${written.lines().first().take(60)}"
                        else option.detail
                    if (note.isNotBlank())
                        Text(
                            note,
                            color = if (option.typed) Tui.orange else Tui.fgDim,
                            style = MaterialTheme.typography.labelMedium,
                        )
                }
            }
        }
    }
}
