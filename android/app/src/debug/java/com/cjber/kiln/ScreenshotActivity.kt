package com.cjber.kiln

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.LaunchedEffect
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Debug-only host for README screenshots: `--es screen list` (default) or `--es screen pair`. It
 * renders the production composables from seeded rows and a fixed clock; nothing touches the
 * network or saved credentials.
 */
class ScreenshotActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.getInsetsController(window, window.decorView)
            .hide(WindowInsetsCompat.Type.systemBars())
        val screen = intent.getStringExtra("screen")
        setContent {
            KilnTheme {
                if (screen == "pi")
                    ConversationView(
                        "Demo",
                        "Review the release",
                        ConversationSnapshot(
                            "fixture",
                            1,
                            "Review the release",
                            "idle",
                            listOf(
                                ConversationMessage(
                                    "user",
                                    "Check the release notes and package assets.",
                                ),
                                ConversationMessage(
                                    "assistant",
                                    "Both Linux binaries and the signed Android APK are ready. The package checks passed.",
                                ),
                            ),
                            false,
                            "Approvals appear here when the agent needs input",
                            demoNow,
                        ),
                        true,
                        "",
                        "Check the changelog next",
                        {},
                        false,
                        {},
                        {},
                    )
                else if (screen == "pair")
                    PairingScreen(
                        error = "",
                        onDismissError = {},
                        invitation = "",
                        setInvitation = {},
                        busy = false,
                        canCancel = false,
                        pair = {},
                        scan = {},
                        cancel = {},
                    )
                else
                    SessionScreen(
                        machineLabel = "Demo",
                        machines = listOf("Demo"),
                        onMachine = {},
                        onReconnect = {},
                        onPairAnother = {},
                        onForget = {},
                        error = "",
                        onDismissError = {},
                        state = "Ready",
                        updated = demoNow,
                        problem = "",
                        filter = "",
                        onFilter = {},
                        sort = SessionOrder.PROJECT,
                        onSort = {},
                        rows = demoRows,
                        loaded = true,
                        now = demoNow,
                        expanded = emptySet(),
                        open = {},
                        details = {},
                        toggle = {},
                    )
                LaunchedEffect(Unit) { Log.i("KilnScreenshot", READY) }
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus)
            WindowCompat.getInsetsController(window, window.decorView)
                .hide(WindowInsetsCompat.Type.systemBars())
    }

    companion object {
        const val READY = "KILN_SCREENSHOT_READY"
    }
}

private const val demoNow = 1_800_000_000_000L
private const val chatgpt = "https://chatgpt.com/codex"
private const val claude = "https://claude.ai/code"

private fun demo(
    id: String,
    agent: String,
    title: String,
    cwd: String,
    activity: String,
    minutes: Long,
    started: Long,
    branch: String = "main",
    parent: String? = null,
) =
    Row(
        id,
        agent,
        title,
        cwd,
        branch,
        activity,
        "acp",
        demoNow - started * 60_000,
        demoNow - minutes * 60_000,
        when (agent) {
            "codex" -> chatgpt
            "claude" -> claude
            else -> null
        },
        "Demo",
        agent != "codex",
        parent,
        true,
    )

private val demoRows =
    listOf(
        demo(
            "claude:101",
            "claude",
            "Cache map tiles",
            "/home/demo/code/atlas",
            "working",
            2,
            42,
            "feat/tile-cache",
        ),
        demo(
            "codex:102",
            "codex",
            "Fix retry backoff",
            "/home/demo/code/atlas",
            "waiting",
            2,
            18,
            "fix/retry-backoff",
        ),
        demo(
            "claude:105",
            "claude",
            "Review the retry fix",
            "/home/demo/code/kiln",
            "waiting",
            2,
            64,
            parent = "codex:102",
        ),
        demo("pi:103", "pi", "Update shell bindings", "/home/demo/code/dotfiles", "working", 2, 7),
        demo(
            "claude:104",
            "claude",
            "Draft terminal tools post",
            "/home/demo/code/blog",
            "idle",
            130,
            190,
            "draft/terminal-tools",
        ),
    )
