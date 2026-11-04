package com.cjber.kiln

import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownTest {
    @Test
    fun blocksAgentsWrite() {
        val blocks =
            parseMarkdown(
                """
                ## Done
                Fixed the **parser** and
                ran `bun test`.

                - one
                  continued
                  - nested
                2. second

                ```ts
                const a = 1;
                ```

                | File | Change |
                | --- | --- |
                | `a.ts` | **new** |

                > a quote
                ---
                """
                    .trimIndent()
            )
        assertEquals(
            listOf(
                MarkdownBlock.Heading(2, "Done"),
                MarkdownBlock.Paragraph("Fixed the **parser** and ran `bun test`."),
                MarkdownBlock.Item("•", 0, "one continued"),
                MarkdownBlock.Item("•", 1, "nested"),
                MarkdownBlock.Item("2.", 0, "second"),
                MarkdownBlock.Code("const a = 1;"),
                MarkdownBlock.Table(listOf(listOf("File", "Change"), listOf("a.ts", "new"))),
                MarkdownBlock.Quote("a quote"),
                MarkdownBlock.Rule,
            ),
            blocks,
        )
    }

    @Test
    fun inlineMarkersBecomeStylesNotText() {
        val text =
            inlineMarkdown(
                "Run `a*b*c` on **bold _and_ more**, see [docs](https://x.dev) and 2*3*4"
            )
        assertEquals("Run a*b*c on bold and more, see docs and 2*3*4", text.text)
        assertEquals(1, text.getLinkAnnotations(0, text.length).size)
    }
}
