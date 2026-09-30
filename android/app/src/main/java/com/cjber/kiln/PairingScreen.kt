package com.cjber.kiln

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingScreen(
    error: String,
    onDismissError: () -> Unit,
    invitation: String,
    setInvitation: (String) -> Unit,
    busy: Boolean,
    canCancel: Boolean,
    pair: () -> Unit,
    scan: () -> Unit,
    cancel: () -> Unit,
) {
    var instructions by rememberSaveable { mutableStateOf(false) }
    BackHandler(canCancel) { cancel() }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("kiln", fontWeight = FontWeight.SemiBold) },
                navigationIcon = {
                    if (canCancel)
                        IconButton(onClick = cancel) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to sessions")
                        }
                },
            )
        }
    ) { padding ->
        Box(
            Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(
                Modifier.widthIn(max = 560.dp)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Surface(
                    Modifier.size(64.dp),
                    shape = MaterialTheme.shapes.large,
                    color = MaterialTheme.colorScheme.primaryContainer,
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            Icons.Default.Add,
                            null,
                            modifier = Modifier.size(32.dp),
                            tint = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "Bring your sessions\nwith you.",
                        style = MaterialTheme.typography.headlineLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        "Connect to kiln on your computer to see what your agents are working on.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                ErrorNotice(error, onDismissError)
                FilledTonalButton(
                    onClick = scan,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                ) {
                    Text("Scan pairing QR code")
                }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    HorizontalDivider(Modifier.weight(1f))
                    Text(
                        "or use an invitation",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    HorizontalDivider(Modifier.weight(1f))
                }
                OutlinedTextField(
                    invitation,
                    setInvitation,
                    enabled = !busy,
                    label = { Text("Pairing invitation") },
                    placeholder = { Text("Paste your kiln://pair link") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                    maxLines = 4,
                    shape = MaterialTheme.shapes.medium,
                )
                Button(
                    onClick = pair,
                    enabled = !busy && invitation.isNotBlank(),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                ) {
                    if (busy) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(if (busy) "Connecting…" else "Connect machine")
                }
                Card(
                    colors =
                        CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceContainerLow
                        )
                ) {
                    Column(
                        Modifier.padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("First time setting up?", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "Create a pairing invitation on your computer. It expires after five minutes and works once.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        TextButton(onClick = { instructions = !instructions }) {
                            Text(if (instructions) "Hide setup steps" else "Show setup steps")
                        }
                        if (instructions) {
                            Text(
                                "1. Start the phone server",
                                style = MaterialTheme.typography.labelLarge,
                            )
                            Text(
                                "kiln serve",
                                fontFamily = FontFamily.Monospace,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                "2. Expose it over your Tailscale connection",
                                style = MaterialTheme.typography.labelLarge,
                            )
                            Text(
                                "tailscale serve --bg http://127.0.0.1:7437",
                                fontFamily = FontFamily.Monospace,
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Text(
                                "3. Create your invitation using the HTTPS URL from Tailscale",
                                style = MaterialTheme.typography.labelLarge,
                            )
                            Text(
                                "kiln pair <https-url> --qr",
                                fontFamily = FontFamily.Monospace,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }
            }
        }
    }
}
