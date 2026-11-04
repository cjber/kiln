package com.cjber.kiln

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The Markdown agents write, as blocks: enough to read a reply, not a full CommonMark parser. */
sealed interface MarkdownBlock {
    data class Paragraph(val text: String) : MarkdownBlock

    data class Heading(val level: Int, val text: String) : MarkdownBlock

    /** `marker` is "•" or the item's number with its dot. */
    data class Item(val marker: String, val depth: Int, val text: String) : MarkdownBlock

    data class Quote(val text: String) : MarkdownBlock

    data class Code(val text: String) : MarkdownBlock

    data class Table(val rows: List<List<String>>) : MarkdownBlock

    data object Rule : MarkdownBlock
}

private val heading = Regex("^(#{1,6})\\s+(.*)$")
private val bullet = Regex("^(\\s*)[-*+]\\s+(.*)$")
private val numbered = Regex("^(\\s*)(\\d{1,3})[.)]\\s+(.*)$")
private val rule = Regex("^\\s*([-*_])(\\s*\\1){2,}\\s*$")
private val tableDivider = Regex("^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$")

fun parseMarkdown(source: String): List<MarkdownBlock> {
    val blocks = mutableListOf<MarkdownBlock>()
    val lines = source.replace("\r\n", "\n").split("\n")
    val paragraph = mutableListOf<String>()
    fun flush() {
        if (paragraph.isNotEmpty()) blocks += MarkdownBlock.Paragraph(paragraph.joinToString(" "))
        paragraph.clear()
    }
    var index = 0
    while (index < lines.size) {
        val line = lines[index]
        val trimmed = line.trim()
        when {
            trimmed.startsWith("```") || trimmed.startsWith("~~~") -> {
                flush()
                val fence = trimmed.take(3)
                val code = mutableListOf<String>()
                index++
                while (index < lines.size && !lines[index].trim().startsWith(fence)) code +=
                    lines[index++]
                blocks += MarkdownBlock.Code(code.joinToString("\n").trimEnd())
            }
            trimmed.isEmpty() -> flush()
            trimmed.startsWith("|") &&
                lines.getOrNull(index + 1)?.let(tableDivider::matches) == true -> {
                flush()
                val rows = mutableListOf(cells(trimmed))
                index += 2
                while (index < lines.size && lines[index].trim().startsWith("|")) rows +=
                    cells(lines[index++].trim())
                blocks += MarkdownBlock.Table(rows)
                continue
            }
            rule.matches(line) -> {
                flush()
                blocks += MarkdownBlock.Rule
            }
            heading.matches(trimmed) -> {
                flush()
                val match = heading.find(trimmed)!!
                blocks +=
                    MarkdownBlock.Heading(
                        match.groupValues[1].length,
                        match.groupValues[2].trim('#', ' '),
                    )
            }
            bullet.matches(line) -> {
                flush()
                val match = bullet.find(line)!!
                blocks +=
                    MarkdownBlock.Item("•", match.groupValues[1].length / 2, match.groupValues[2])
            }
            numbered.matches(line) -> {
                flush()
                val match = numbered.find(line)!!
                blocks +=
                    MarkdownBlock.Item(
                        "${match.groupValues[2]}.",
                        match.groupValues[1].length / 2,
                        match.groupValues[3],
                    )
            }
            trimmed.startsWith(">") -> {
                flush()
                val quote = mutableListOf<String>()
                while (index < lines.size && lines[index].trim().startsWith(">")) quote +=
                    lines[index++].trim().removePrefix(">").trim()
                blocks += MarkdownBlock.Quote(quote.joinToString(" "))
                continue
            }
            // An indented line under a list item continues it.
            line.startsWith("  ") &&
                paragraph.isEmpty() &&
                blocks.lastOrNull() is MarkdownBlock.Item -> {
                val item = blocks.removeAt(blocks.lastIndex) as MarkdownBlock.Item
                blocks += item.copy(text = "${item.text} $trimmed")
            }
            else -> paragraph += trimmed
        }
        index++
    }
    flush()
    return blocks
}

/** A table cell drops its inline markers, since a table is drawn as aligned plain text. */
private fun cells(row: String) =
    row.trim().removePrefix("|").removeSuffix("|").split("|").map { inlineMarkdown(it.trim()).text }

private val inline =
    Regex(
        """`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\[([^\]]+)]\((https?://[^)\s]+)\)|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)"""
    )

/** Inline Markdown as styled text: code, bold, italic and links. */
fun inlineMarkdown(text: String, code: Color = Tui.peach, link: Color = Tui.teal): AnnotatedString =
    buildAnnotatedString {
        var at = 0
        for (match in inline.findAll(text)) {
            append(text.substring(at, match.range.first))
            val groups = match.groupValues
            when {
                groups[1].isNotEmpty() ->
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = code)) {
                        append(groups[1])
                    }
                groups[2].isNotEmpty() || groups[3].isNotEmpty() ->
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) {
                        append(inlineMarkdown(groups[2].ifEmpty { groups[3] }, code, link))
                    }
                groups[4].isNotEmpty() ->
                    withLink(
                        LinkAnnotation.Url(groups[5], TextLinkStyles(SpanStyle(color = link)))
                    ) {
                        append(groups[4])
                    }
                else ->
                    withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
                        append(groups[6].ifEmpty { groups[7] })
                    }
            }
            at = match.range.last + 1
        }
        append(text.substring(at))
    }

@Composable
fun Markdown(source: String, color: Color = Tui.fgBright) {
    val blocks = remember(source) { parseMarkdown(source) }
    val body = MaterialTheme.typography.bodyMedium
    val mono = body.copy(fontFamily = FontFamily.Monospace, fontSize = 12.sp)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        blocks.forEach { block ->
            when (block) {
                is MarkdownBlock.Paragraph ->
                    Text(inlineMarkdown(block.text), color = color, style = body)
                is MarkdownBlock.Heading ->
                    Text(
                        inlineMarkdown(block.text),
                        color = if (block.level <= 2) Tui.orange else color,
                        style =
                            body.copy(
                                fontWeight = FontWeight.Bold,
                                fontSize = if (block.level == 1) 17.sp else 15.sp,
                            ),
                    )
                is MarkdownBlock.Item ->
                    Row(Modifier.padding(start = (block.depth * 14).dp)) {
                        Text(
                            block.marker,
                            color = Tui.orange,
                            style = body,
                            modifier = Modifier.widthIn(min = 16.dp),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(inlineMarkdown(block.text), color = color, style = body)
                    }
                is MarkdownBlock.Quote ->
                    Row(Modifier.height(IntrinsicSize.Min)) {
                        Box(Modifier.width(2.dp).fillMaxHeight().background(Tui.comment))
                        Spacer(Modifier.width(10.dp))
                        Text(
                            inlineMarkdown(block.text),
                            color = Tui.fg,
                            style = body.copy(fontStyle = FontStyle.Italic),
                        )
                    }
                is MarkdownBlock.Code ->
                    Text(
                        block.text,
                        color = Tui.fg,
                        style = mono,
                        softWrap = false,
                        modifier =
                            Modifier.fillMaxWidth()
                                .background(Color(0xff1a1819), RoundedCornerShape(6.dp))
                                .horizontalScroll(rememberScrollState())
                                .padding(10.dp),
                    )
                is MarkdownBlock.Table -> {
                    val widths =
                        (0 until block.rows.maxOf { it.size }).map { column ->
                            block.rows.maxOf { it.getOrElse(column) { "" }.length }
                        }
                    Column(
                        Modifier.fillMaxWidth()
                            .background(Color(0xff1a1819), RoundedCornerShape(6.dp))
                            .horizontalScroll(rememberScrollState())
                            .padding(10.dp)
                    ) {
                        block.rows.forEachIndexed { row, cells ->
                            Text(
                                widths.indices.joinToString("  ") {
                                    cells.getOrElse(it) { "" }.padEnd(widths[it])
                                },
                                color = if (row == 0) Tui.orange else Tui.fg,
                                style = mono,
                                softWrap = false,
                            )
                        }
                    }
                }
                MarkdownBlock.Rule -> HorizontalDivider(color = Tui.bg2)
            }
        }
    }
}
