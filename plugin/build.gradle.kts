import org.gradle.jvm.tasks.Jar

plugins {
    kotlin("jvm") version "2.3.0"
    id("org.jetbrains.intellij.platform") version "2.10.5"
}

val pluginVersion: String by project

group = "com.potomushto.intunnel"
version = pluginVersion

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

configurations.matching { it.name.endsWith("RuntimeClasspath") }.configureEach {
    exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core")
    exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core-jvm")
    exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-jdk8")
}

dependencies {
    intellijPlatform {
        create("IU", "261.17801.55")
        bundledPlugin("org.jetbrains.plugins.terminal")
        bundledPlugin("com.jetbrains.sh")
        testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Platform)
    }

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.opentest4j:opentest4j:1.3.0")

    implementation("io.ktor:ktor-server-core-jvm:2.3.12")
    implementation("io.ktor:ktor-server-netty-jvm:2.3.12")
    implementation("io.ktor:ktor-server-websockets-jvm:2.3.12")
    implementation("com.google.code.gson:gson:2.11.0")
    implementation("com.google.zxing:core:3.5.3")
    implementation("com.google.zxing:javase:3.5.3")
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "261.17801.55"
            untilBuild = "261.*"
        }
    }
    pluginVerification {
        ides {
            ide("IU", "261.17801.55")
        }
    }
}

fun sanitizeManifestFile(manifestFile: File) {
    if (!manifestFile.exists()) {
        return
    }
    val original = manifestFile.readText()
    if (original.isEmpty()) {
        return
    }
    var sanitized = original
    if (sanitized.startsWith("\uFEFF")) {
        sanitized = sanitized.removePrefix("\uFEFF")
    }
    sanitized = sanitized.replaceFirst(Regex("^\\s+"), "")
    if (sanitized == original) {
        return
    }
    manifestFile.writeText(sanitized)
}

fun debugManifestFile(manifestFile: File, label: String) {
    if (!manifestFile.exists()) {
        return
    }
    val data = manifestFile.readBytes()
    val preview = data.take(200).toByteArray().contentToString()
    println("MANIFEST_DEBUG [$label] ${manifestFile.absolutePath} size=${data.size} bytes preview=$preview")
}

tasks.withType<Jar>().configureEach {
    doFirst {
        val manifestPaths = listOf(
            "tmp/generateManifest/MANIFEST.MF",
            "tmp/jar/MANIFEST.MF",
            "tmp/instrumentedJar/MANIFEST.MF",
            "tmp/composedJar/MANIFEST.MF",
            "tmp/jarSearchableOptions/MANIFEST.MF",
        )
        val debug = System.getenv("MANIFEST_DEBUG") == "1"
        for (relativePath in manifestPaths) {
            val manifestFile = layout.buildDirectory.file(relativePath).get().asFile
            if (debug) {
                debugManifestFile(manifestFile, relativePath)
            }
            sanitizeManifestFile(manifestFile)
        }
    }
}

kotlin {
    jvmToolchain(17)
}
