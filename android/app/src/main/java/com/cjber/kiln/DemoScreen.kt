package com.cjber.kiln

import android.content.ClipData
import android.content.ClipboardManager
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext

/** Labelled local samples never connect to a host or persist credentials. */
@Composable
fun DemoScreen(close: () -> Unit) {
    BackHandler { close() }
    val context = LocalContext.current
    val now = remember { System.currentTimeMillis() }
    var filter by remember { mutableStateOf("") }
    var sort by remember { mutableStateOf(SessionOrder.PROJECT) }
    var expanded by remember { mutableStateOf(emptySet<String>()) }
    var hidden by remember { mutableStateOf(emptySet<String>()) }
    var selected by remember { mutableStateOf<Row?>(null) }
    var detail by remember { mutableStateOf<Row?>(null) }
    var prompt by remember { mutableStateOf("") }
    var approvals by remember {
        mutableStateOf(
            listOf(
                ApprovalRequest(
                    "demo-read",
                    "Read sample project files",
                    listOf(
                        ApprovalOption("allow", "Allow once"),
                        ApprovalOption("reject", "Reject"),
                    ),
                )
            )
        )
    }
    var messages by remember {
        mutableStateOf(
            listOf(
                ConversationMessage(
                    "agent",
                    "This is an offline demonstration. No files, agents or network connections are used.",
                )
            )
        )
    }
    val rows =
        listOf(
                "codex" to "Review project changes",
                "claude" to "Draft release notes",
                "pi" to "Check project setup",
            )
            .map { (agent, title) ->
                Row(
                    "$agent:demo",
                    agent,
                    title,
                    "/home/demo/code/sample",
                    "main",
                    if (agent == "codex" && approvals.isNotEmpty()) "waiting" else "idle",
                    "acp",
                    now,
                    now,
                    null,
                    "Offline demo",
                    true,
                    acpRemote = true,
                )
            }
    if (selected != null) {
        val row = selected!!
        ConversationView(
            "Offline demo",
            row.title,
            ConversationSnapshot(
                "demo",
                1,
                row.title,
                if (row.agent == "codex" && approvals.isNotEmpty()) "waiting" else "idle",
                messages,
                "Simulated conversation. Nothing is sent to an agent.",
                now,
                if (row.agent == "codex") approvals else emptyList(),
            ),
            true,
            "",
            prompt,
            { prompt = it },
            false,
            { command ->
                when {
                    command == "prompt" && prompt.isNotBlank() -> {
                        messages =
                            messages +
                                ConversationMessage("user", prompt) +
                                ConversationMessage(
                                    "agent",
                                    "Demo response: in a paired session, your selected ACP agent answers here.",
                                )
                        prompt = ""
                    }
                    command.startsWith("approve:") -> {
                        approvals = emptyList()
                        messages =
                            messages +
                                ConversationMessage(
                                    "tool",
                                    "Demo permission answered. No files were accessed.",
                                )
                    }
                    command == "abort" -> approvals = emptyList()
                }
            },
            { selected = null },
        )
        return
    }
    detail?.let { row ->
        SessionDetails(
            row,
            now,
            dismiss = { detail = null },
            open = {
                selected = row
                detail = null
            },
            copy = {
                context
                    .getSystemService(ClipboardManager::class.java)
                    .setPrimaryClip(ClipData.newPlainText("Thread ID", row.id))
            },
            hidden = row.id in hidden,
            changeHidden = {
                hidden = if (row.id in hidden) hidden - row.id else hidden + row.id
                detail = null
            },
        )
    }
    SessionScreen(
        machineLabel = "Offline demo",
        machines = listOf("Offline demo"),
        onMachine = {},
        onReconnect = {},
        onPairAnother = close,
        onForget = close,
        error = "",
        onDismissError = {},
        state = "Ready",
        updated = now,
        problem = "Sample data only. Return to pairing to connect your computer.",
        filter = filter,
        onFilter = { filter = it },
        sort = sort,
        onSort = { sort = it },
        rows = rows,
        loaded = true,
        now = now,
        expanded = expanded,
        open = { selected = it },
        details = { detail = it },
        toggle = { row ->
            expanded = if (row.id in expanded) expanded - row.id else expanded + row.id
        },
        hiddenIds = hidden,
        changeHidden = {
            hidden = it
            true
        },
    )
}
