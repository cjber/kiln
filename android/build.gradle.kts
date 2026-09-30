plugins {
    id("com.android.application") version "9.1.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.10" apply false
}

val formatter by configurations.creating {
    attributes.attribute(
        org.gradle.api.attributes.Bundling.BUNDLING_ATTRIBUTE,
        objects.named(org.gradle.api.attributes.Bundling.SHADOWED),
    )
}

dependencies { formatter("com.facebook:ktfmt:0.63") }

val kotlinFiles =
    fileTree(rootDir) {
        include("**/*.kt", "**/*.kts")
        exclude("**/build/**", ".gradle/**")
    }

tasks.register<JavaExec>("formatKotlin") {
    classpath = formatter
    mainClass.set("com.facebook.ktfmt.cli.Main")
    args("--kotlinlang-style")
    args(kotlinFiles.files.sorted().map { it.path })
}

tasks.register<JavaExec>("checkKotlinFormat") {
    classpath = formatter
    mainClass.set("com.facebook.ktfmt.cli.Main")
    args("--kotlinlang-style", "--dry-run", "--set-exit-if-changed")
    args(kotlinFiles.files.sorted().map { it.path })
}
