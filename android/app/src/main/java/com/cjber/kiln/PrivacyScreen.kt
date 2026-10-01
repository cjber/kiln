package com.cjber.kiln

import android.text.Html
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

@Composable
fun PrivacyScreen(close: () -> Unit) {
    BackHandler { close() }
    val context = LocalContext.current
    val policy = remember {
        Html.fromHtml(
                context.assets.open("privacy.html").bufferedReader().use {
                    it.readText().substringAfter("</head>")
                },
                Html.FROM_HTML_MODE_COMPACT,
            )
            .toString()
            .trim()
    }
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.safeDrawingPadding().padding(20.dp)) {
            TextButton(onClick = close) { Text("Back") }
            Text(policy, modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()))
        }
    }
}
