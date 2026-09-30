package com.cjber.kiln

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
            Surface(
                modifier = Modifier.fillMaxSize().clip(MaterialTheme.shapes.small),
                color = MaterialTheme.colorScheme.secondaryContainer,
            ) {
                Row(
                    Modifier.fillMaxSize().padding(horizontal = 20.dp),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        if (hidden) Icons.Default.Check else Icons.Default.Clear,
                        null,
                        Modifier.size(20.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(label, style = MaterialTheme.typography.labelLarge)
                }
            }
        },
    ) {
        SessionCard(
            item,
            now,
            expanded,
            open,
            details,
            toggle,
            restore = if (hidden) restore else null,
        )
    }
}
