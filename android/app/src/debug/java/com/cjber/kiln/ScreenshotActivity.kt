package com.cjber.kiln

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.LaunchedEffect
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Debug-only host for README screenshots: `--es screen list` (default), `--es screen progress`,
 * `--es screen pair` or `--es screen handoff`. It renders the production composables from seeded
 * rows and a fixed clock; nothing touches the network or saved credentials.
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
                        invitationError = "",
                        busy = false,
                        canCancel = false,
                        tailscaleOn = true,
                        openTailscale = {},
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
                        initialScope =
                            if (screen == "progress") SessionScope.PROGRESS else SessionScope.LIVE,
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
        Place.KILN,
        demoNow - started * 60_000,
        demoNow - minutes * 60_000,
        when (agent) {
            Agent.CODEX -> chatgpt
            Agent.CLAUDE -> claude
            Agent.OPENCODE,
            Agent.PI -> null
        },
        when (agent) {
            Agent.CODEX -> "Open ChatGPT, then choose this thread"
            Agent.CLAUDE -> "Open in Claude"
            Agent.OPENCODE -> "Open this OpenCode session in kiln on your computer"
            Agent.PI -> "Open this Pi session in kiln on your computer"
        },
        agent != Agent.CODEX,
        parent,
    )

private fun pull(
    number: Int,
    passed: Int,
    failed: Int,
    running: Int,
    queued: Boolean = false,
    repository: String = "repo",
    state: String = "OPEN",
) =
    PullInfo(
        number,
        "https://github.com/demo/$repository/pull/$number",
        false,
        queued,
        passed,
        failed,
        running,
        state,
    )

/** Each demo session's stage and pull request, as `kiln serve` reports them. */
private val demoProgress =
    mapOf(
        "claude:101" to (Stage.CHECKS to pull(214, 6, 0, 5)),
        "codex:102" to (Stage.FAILING to pull(212, 9, 2, 0)),
        "claude:105" to (Stage.FAILING to pull(212, 9, 2, 0)),
        "opencode:104" to (Stage.GREEN to pull(41, 4, 0, 0, queued = true)),
        "claude:106" to (Stage.DONE to pull(131, 14, 0, 0)),
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
                "opencode:104",
                Agent.OPENCODE,
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
                    label = "This job has finished; attach to it in kiln on your computer",
                    branch = "cb/release-notes",
                ),
        )
        .map { row ->
            demoProgress[row.id]?.let { (stage, pr) ->
                // One session opened two more pull requests, in other repositories.
                val more =
                    if (row.id == "codex:102")
                        listOf(
                            pull(88, 7, 0, 2, repository = "api"),
                            pull(19, 5, 0, 0, repository = "docs", state = "MERGED"),
                        )
                    else emptyList()
                row.copy(stage = stage, pr = pr, prs = listOf(pr) + more)
            } ?: row.copy(stage = Stage.WORKING)
        }
