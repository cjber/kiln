package com.cjber.kiln

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
fun SwipeSessionRow(
    item: SessionItem.Entry,
    now: Long,
    expanded: Boolean,
    open: () -> Unit,
    details: () -> Unit,
    toggle: () -> Unit,
    hidden: Boolean,
    hide: () -> Unit,
    restore: () -> Unit,
    progress: Boolean = false,
) {
    val action by rememberUpdatedState(if (hidden) restore else hide)
    val label = if (hidden) "Restore" else "Hide"
    val state =
        rememberSwipeToDismissBoxState(
            confirmValueChange = {
                if (it == SwipeToDismissBoxValue.EndToStart) action()
                false
            }
        )
    SwipeToDismissBox(
        state = state,
        enableDismissFromStartToEnd = false,
        modifier =
            Modifier.semantics {
                customActions =
                    listOf(
                        CustomAccessibilityAction("$label session on this phone") {
                            action()
                            true
                        }
                    )
            },
        backgroundContent = {
            if (state.dismissDirection == SwipeToDismissBoxValue.EndToStart)
                Row(
                    Modifier.fillMaxSize().background(Tui.bg2).padding(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        label.lowercase(),
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (hidden) Tui.green else Tui.peach,
                    )
                }
        },
    ) {
        if (progress) ProgressCard(item.row, now, open, details)
        else SessionCard(item, now, expanded, open, details, toggle)
    }
}
