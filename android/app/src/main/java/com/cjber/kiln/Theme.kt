package com.cjber.kiln

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/** The terminal palette from `src/tui.ts`, so the phone reads like the TUI. */
object Tui {
    val bg = Color(0xff121113)
    val bg2 = Color(0xff222222)
    val fg = Color(0xffb0b0b0)
    val fgBright = Color(0xffd0d0d0)
    val fgDim = Color(0xff777777)
    val comment = Color(0xff555555)
    val orange = Color(0xffe78a53)
    val teal = Color(0xff5f8787)
    val peach = Color(0xfffbcb97)
    val yellow = Color(0xffe5c46b)
    val red = Color(0xffc75a5a)
    val green = Color(0xff6a9955)
    val purple = Color(0xff9d7cd8)
}

@Composable
fun KilnTheme(content: @Composable () -> Unit) {
    val colors =
        darkColorScheme(
            primary = Tui.orange,
            onPrimary = Tui.bg,
            primaryContainer = Tui.bg2,
            onPrimaryContainer = Tui.peach,
            secondary = Tui.teal,
            onSecondary = Tui.bg,
            secondaryContainer = Tui.bg2,
            onSecondaryContainer = Tui.fgBright,
            tertiary = Tui.peach,
            background = Tui.bg,
            onBackground = Tui.fg,
            surface = Tui.bg,
            onSurface = Tui.fg,
            surfaceTint = Tui.bg,
            surfaceContainerLowest = Tui.bg,
            surfaceContainerLow = Color(0xff1a191b),
            surfaceContainer = Color(0xff1a191b),
            surfaceContainerHigh = Tui.bg2,
            surfaceContainerHighest = Color(0xff2a2a2a),
            surfaceVariant = Tui.bg2,
            onSurfaceVariant = Tui.fgDim,
            outline = Tui.comment,
            outlineVariant = Color(0xff2a2a2a),
            error = Tui.red,
            onError = Tui.bg,
            errorContainer = Color(0xff2e1c1c),
            onErrorContainer = Color(0xffe8a0a0),
        )
    val base = Typography()
    fun TextStyle.mono() = copy(fontFamily = FontFamily.Monospace)
    MaterialTheme(
        colorScheme = colors,
        typography =
            Typography(
                displayLarge = base.displayLarge.mono(),
                displayMedium = base.displayMedium.mono(),
                displaySmall = base.displaySmall.mono(),
                headlineLarge = base.headlineLarge.mono(),
                headlineMedium = base.headlineMedium.mono(),
                headlineSmall = base.headlineSmall.mono(),
                titleLarge = base.titleLarge.mono(),
                titleMedium = base.titleMedium.mono(),
                titleSmall = base.titleSmall.mono(),
                bodyLarge = base.bodyLarge.mono(),
                bodyMedium = base.bodyMedium.mono(),
                bodySmall = base.bodySmall.mono(),
                labelLarge = base.labelLarge.mono(),
                labelMedium = base.labelMedium.mono(),
                labelSmall = base.labelSmall.mono(),
            ),
        shapes =
            Shapes(
                small = RoundedCornerShape(4.dp),
                medium = RoundedCornerShape(6.dp),
                large = RoundedCornerShape(8.dp),
            ),
    ) {
        Surface(Modifier.fillMaxSize(), color = colors.background, content = content)
    }
}

/** The TUI's status tones: working is dim, needs input yellow, ready and completed green. */
fun activityColor(activity: Activity): Color =
    when (activity) {
        Activity.WORKING -> Tui.fg
        Activity.WAITING -> Tui.yellow
        Activity.IDLE,
        Activity.COMPLETED -> Tui.green
        Activity.STOPPED,
        Activity.UNKNOWN -> Tui.fgDim
    }

fun agentColor(agent: Agent): Color =
    when (agent) {
        Agent.CLAUDE -> Tui.orange
        Agent.CODEX -> Tui.teal
        Agent.OPENCODE -> Tui.fgBright
        Agent.PI -> Tui.purple
    }

fun agentName(agent: Agent): String =
    when (agent) {
        Agent.CLAUDE -> "Claude"
        Agent.CODEX -> "Codex"
        Agent.OPENCODE -> "OpenCode"
        Agent.PI -> "Pi"
    }

fun activityName(activity: Activity): String =
    when (activity) {
        Activity.WORKING -> "Working"
        Activity.WAITING -> "Needs input"
        Activity.IDLE -> "Ready"
        Activity.COMPLETED -> "Completed"
        Activity.STOPPED -> "Stopped"
        Activity.UNKNOWN -> "Unknown"
    }
