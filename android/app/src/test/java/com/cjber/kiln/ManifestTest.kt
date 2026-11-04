package com.cjber.kiln

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Test

class ManifestTest {
    /**
     * A pairing link or a notification tap reuses the one app screen through onNewIntent. A second
     * stacked screen would keep the old invitation behind it and hold a second watch connection.
     */
    @Test
    fun linksReuseTheOneActivity() {
        val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        val manifest = factory.newDocumentBuilder().parse(File("src/main/AndroidManifest.xml"))
        val activities = manifest.getElementsByTagName("activity")
        val main =
            (0 until activities.length)
                .map { activities.item(it) as org.w3c.dom.Element }
                .single { it.getAttributeNS(ANDROID, "name") == ".MainActivity" }
        assertEquals("singleTask", main.getAttributeNS(ANDROID, "launchMode"))
    }

    private companion object {
        const val ANDROID = "http://schemas.android.com/apk/res/android"
    }
}
