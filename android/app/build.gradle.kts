plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.cjber.kiln"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.cjber.kiln"
        minSdk = 26
        targetSdk = 36
        versionCode = 22
        versionName = "0.12.1"
    }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint { abortOnError = true }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    testImplementation("org.json:json:20260814")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.5.1")
    testImplementation("com.squareup.okhttp3:okhttp-tls:5.5.1")
    testImplementation("junit:junit:4.13.2")
}
