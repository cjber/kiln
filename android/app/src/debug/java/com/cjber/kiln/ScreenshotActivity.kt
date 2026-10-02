package com.cjber.kiln

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.LaunchedEffect
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Debug-only host for README screenshots: `--es screen list` (default), `--es screen pair` or `--es
 * screen handoff`. It renders the production composables from seeded rows and a fixed clock;
 * nothing touches the network or saved credentials.
 */
class ScreenshotActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.getInsetsController(window, window.decorView)
            .hide(WindowInsetsCompat.Type.systemBars())
        val screen = intent.getStringExtra("screen")
        setContent {
            KilnTheme {
                if (screen == "handoff")
                    SessionDetails(demoRows.first(), demoNow, {}, {}, {}, false, {})
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
                        state = ConnectionState.CONNECTED,
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
    agent: Agent,
    title: String,
    cwd: String,
    activity: Activity,
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
        if (agent == Agent.PI) Place.ACP else Place.KILN,
        demoNow - started * 60_000,
        demoNow - minutes * 60_000,
        when (agent) {
            Agent.CODEX -> chatgpt
            Agent.CLAUDE -> claude
            Agent.PI -> null
        },
        when (agent) {
            Agent.CODEX -> "Open ChatGPT, then choose this thread"
            Agent.CLAUDE -> "Open in Claude"
            Agent.PI -> "Open this Pi session in kiln on your PC"
        },
        agent != Agent.CODEX,
        parent,
    )

private val demoRows =
    listOf(
        demo(
            "claude:101",
            Agent.CLAUDE,
            "Cache map tiles",
            "/home/demo/code/atlas",
            Activity.WORKING,
            2,
            42,
            "feat/tile-cache",
        ),
        demo(
            "codex:102",
            Agent.CODEX,
            "Fix retry backoff",
            "/home/demo/code/atlas",
            Activity.WAITING,
            2,
            18,
            "fix/retry-backoff",
        ),
        demo(
            "claude:105",
            Agent.CLAUDE,
            "Review the retry fix",
            "/home/demo/code/kiln",
            Activity.WAITING,
            2,
            64,
            parent = "codex:102",
        ),
        demo(
            "pi:103",
            Agent.PI,
            "Update shell bindings",
            "/home/demo/code/dotfiles",
            Activity.WORKING,
            2,
            7,
        ),
        demo(
            "claude:104",
            Agent.CLAUDE,
            "Draft terminal tools post",
            "/home/demo/code/blog",
            Activity.IDLE,
            130,
            190,
            "draft/terminal-tools",
        ),
        demo(
                "claude:106",
                Agent.CLAUDE,
                "Summarise release notes",
                "/home/demo/code/kiln",
                Activity.COMPLETED,
                300,
                320,
            )
            .copy(
                where = Place.BACKGROUND,
                url = null,
                label = "This job has finished; attach to it in kiln on your PC",
            ),
    )
