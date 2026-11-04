package com.cjber.kiln

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

fun stageColor(stage: Stage): Color =
    when (stage) {
        Stage.FAILING -> Tui.red
        Stage.CHECKS -> Tui.yellow
        Stage.GREEN -> Tui.green
        Stage.WORKING -> Tui.fg
        Stage.DONE -> Tui.fgDim
    }

/** A stage's section heading: its name in small capitals and how many sessions are in it. */
@Composable
fun StageHeading(stage: Stage, count: Int) {
    Row(
        Modifier.fillMaxWidth()
            .padding(start = 4.dp, end = 4.dp, top = 16.dp, bottom = 4.dp)
            .semantics { heading() },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stage.label.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            letterSpacing = 1.sp,
            fontWeight = FontWeight.SemiBold,
            color = stageColor(stage),
            modifier = Modifier.weight(1f),
        )
        Text("$count", style = MaterialTheme.typography.labelSmall, color = Tui.comment)
    }
}

/** Passed, failed and running checks as `✓9 ✗2 ●5`, leaving out any that are zero. */
fun checkCounts(pr: PullInfo) = buildAnnotatedString {
    fun part(count: Int, mark: String, color: Color) {
        if (count == 0) return
        if (length > 0) append(" ")
        withStyle(SpanStyle(color = color)) { append("$mark$count") }
    }
    part(pr.passed, "✓", Tui.green)
    part(pr.failed, "✗", Tui.red)
    part(pr.running, "●", Tui.yellow)
}

/**
 * One session in the progress tab, laid out like the session list: the agent, the title, then its
 * project and pull request underneath, with check counts and its age on the right.
 */
@Composable
fun ProgressCard(row: Row, now: Long, open: () -> Unit, details: () -> Unit) {
    val project =
        row.repository?.trimEnd('/')?.substringAfterLast('/')
            ?: row.cwd.trimEnd('/').substringAfterLast('/')
    Row(
        Modifier.fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .heightIn(min = 48.dp)
            .combinedClickable(onClick = open, onLongClickLabel = "Details", onLongClick = details)
            .padding(horizontal = 4.dp, vertical = 6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            agentName(row.agent),
            color = agentColor(row.agent),
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            modifier = Modifier.width(84.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                row.title,
                color = if (row.activity == Activity.WAITING) Tui.yellow else Tui.fgBright,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    listOfNotNull(
                            project,
                            row.pr?.let { "#${it.number}${if (it.draft) " draft" else ""}" }
                                ?: row.branch.takeIf { it.isNotBlank() },
                        )
                        .joinToString("  "),
                    style = MaterialTheme.typography.labelSmall,
                    color = Tui.comment,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (row.pr?.queued == true)
                    Text(
                        "queued",
                        style = MaterialTheme.typography.labelSmall,
                        color = Tui.purple,
                        modifier =
                            Modifier.padding(start = 8.dp)
                                .border(
                                    1.dp,
                                    Tui.purple.copy(alpha = 0.4f),
                                    MaterialTheme.shapes.small,
                                )
                                .padding(horizontal = 4.dp),
                    )
            }
        }
        Column(Modifier.padding(start = 8.dp), horizontalAlignment = Alignment.End) {
            if (row.pr != null && row.stage != Stage.DONE)
                Text(checkCounts(row.pr), style = MaterialTheme.typography.labelSmall)
            Text(
                if (row.active > 0) elapsed(row.active, now) else "",
                style = MaterialTheme.typography.bodyMedium,
                color = Tui.comment,
            )
        }
    }
}
