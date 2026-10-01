package com.cjber.kiln

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.dp

@Composable
fun KilnTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors =
        if (dark)
            darkColorScheme(
                primary = Color(0xffefb394),
                onPrimary = Color(0xff452719),
                primaryContainer = Color(0xff5e3825),
                onPrimaryContainer = Color(0xffffdac5),
                secondary = Color(0xffb5caba),
                onSecondary = Color(0xff21362b),
                secondaryContainer = Color(0xff344a3d),
                onSecondaryContainer = Color(0xffd1e7d6),
                background = Color(0xff121311),
                onBackground = Color(0xffe5e5df),
                surface = Color(0xff171916),
                onSurface = Color(0xffe5e5df),
                surfaceContainerLowest = Color(0xff10110f),
                surfaceContainerLow = Color(0xff1c1e1a),
                surfaceContainer = Color(0xff232520),
                surfaceContainerHigh = Color(0xff2b2d28),
                surfaceContainerHighest = Color(0xff363832),
                surfaceVariant = Color(0xff41453c),
                onSurfaceVariant = Color(0xffbcc0b5),
                outline = Color(0xff898f81),
                outlineVariant = Color(0xff41453c),
            )
        else
            lightColorScheme(
                primary = Color(0xff8a4728),
                onPrimary = Color.White,
                primaryContainer = Color(0xffffdac5),
                onPrimaryContainer = Color(0xff351305),
                secondary = Color(0xff48634f),
                onSecondary = Color.White,
                secondaryContainer = Color(0xffcbe9cf),
                onSecondaryContainer = Color(0xff122c1b),
                background = Color(0xfff8f8f2),
                onBackground = Color(0xff1b1d18),
                surface = Color(0xfff8f8f2),
                onSurface = Color(0xff1b1d18),
                surfaceContainerLowest = Color.White,
                surfaceContainerLow = Color(0xfff2f3eb),
                surfaceContainer = Color(0xffeceee5),
                surfaceContainerHigh = Color(0xffe6e8df),
                surfaceContainerHighest = Color(0xffe0e2d9),
                surfaceVariant = Color(0xffe1e5d9),
                onSurfaceVariant = Color(0xff454b40),
                outline = Color(0xff757d6e),
                outlineVariant = Color(0xffc5cbbd),
            )
    MaterialTheme(
        colorScheme = colors,
        shapes =
            Shapes(
                small = RoundedCornerShape(12.dp),
                medium = RoundedCornerShape(20.dp),
                large = RoundedCornerShape(28.dp),
            ),
    ) {
        Surface(Modifier.fillMaxSize(), color = colors.background, content = content)
    }
}

@Composable
fun activityColor(activity: String): Color =
    when (activity) {
        "working" -> MaterialTheme.colorScheme.onSurfaceVariant
        "waiting" ->
            if (MaterialTheme.colorScheme.background.luminance() < 0.5f) Color(0xFFE5C46B)
            else Color(0xFF806000)
        "idle" ->
            if (MaterialTheme.colorScheme.background.luminance() < 0.5f) Color(0xFF6A9955)
            else Color(0xFF48634F)
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }

fun agentName(agent: String): String =
    when (agent) {
        "claude" -> "Claude"
        "codex" -> "Codex"
        "pi" -> "Pi"
        else -> agent
    }

fun activityName(activity: String): String =
    when (activity) {
        "working" -> "Working"
        "waiting" -> "Needs input"
        "idle" -> "Ready"
        else -> "Unknown"
    }
