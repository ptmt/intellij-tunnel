package com.intellij.tunnel.terminal

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.registry.Registry
import com.intellij.terminal.JBTerminalWidget
import com.intellij.terminal.ui.TerminalWidget
import com.intellij.tunnel.settings.TunnelTerminalSettingsService
import com.jediterm.core.Color
import com.jediterm.terminal.Terminal
import com.jediterm.terminal.TerminalColor
import com.jediterm.terminal.TerminalOutputStream
import com.jediterm.terminal.TextStyle
import com.jediterm.terminal.emulator.ColorPalette
import com.jediterm.terminal.emulator.ColorPaletteImpl
import com.jediterm.terminal.model.TerminalTextBuffer
import com.jediterm.terminal.util.CharUtils
import org.jetbrains.plugins.terminal.LocalBlockTerminalRunner
import org.jetbrains.plugins.terminal.ShellTerminalWidget
import org.jetbrains.plugins.terminal.TerminalToolWindowManager
import java.awt.event.KeyEvent
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicReference

class TerminalSessionManager {
    private val logger = Logger.getInstance(TerminalSessionManager::class.java)

    data class Session internal constructor(
        val id: String,
        val name: String,
        val workingDirectory: String,
        val createdAt: Instant,
        internal val backend: SessionBackend,
    )

    data class TerminalSnapshot internal constructor(
        val output: String,
        val cursorOffset: Int,
        val styles: List<TerminalStyleRun> = emptyList(),
    )

    data class TerminalStyleRun internal constructor(
        val start: Int,
        val end: Int,
        val fg: String?,
        val bg: String?,
        val bold: Boolean,
        val italic: Boolean,
        val underline: Boolean,
    )

    internal sealed interface SessionBackend {
        fun sendInput(data: String)
        fun snapshot(): TerminalSnapshot
        fun close()
        fun isDisposed(): Boolean
    }

    private inner class IdeaTerminalBackend(val widget: ShellTerminalWidget) : SessionBackend {
        override fun sendInput(data: String) {
            ApplicationManager.getApplication().invokeLater {
                val outputStream = widget.terminalPanel.terminalOutputStream
                if (outputStream != null) {
                    sendInputWithTerminalOutput(outputStream, widget.terminal, data)
                    return@invokeLater
                }
                widget.executeWithTtyConnector { connector ->
                    try {
                        connector.write(data)
                    } catch (_: Exception) {
                        // Ignore terminal write failures.
                    }
                }
            }
        }

        override fun snapshot(): TerminalSnapshot {
            return runOnEdt {
                snapshotTerminalText(
                    widget.terminalPanel.terminalTextBuffer,
                    widget.terminal,
                )
            }
        }

        override fun close() {
            ApplicationManager.getApplication().invokeLater {
                Disposer.dispose(widget)
            }
        }

        override fun isDisposed(): Boolean {
            return isDisposed(widget)
        }
    }

    private inner class TerminalWidgetBackend(
        val widget: TerminalWidget,
        val jediWidget: JBTerminalWidget?,
    ) : SessionBackend {
        override fun sendInput(data: String) {
            ApplicationManager.getApplication().invokeLater {
                val outputStream = jediWidget?.terminalPanel?.terminalOutputStream
                if (outputStream != null && jediWidget != null) {
                    sendInputWithTerminalOutput(outputStream, jediWidget.terminal, data)
                    return@invokeLater
                }
                widget.ttyConnectorAccessor.executeWithTtyConnector { connector ->
                    try {
                        connector.write(data)
                    } catch (_: Exception) {
                        // Ignore terminal write failures.
                    }
                }
            }
        }

        override fun snapshot(): TerminalSnapshot {
            val widget = jediWidget
            if (widget != null) {
                return runOnEdt {
                    snapshotTerminalText(
                        widget.terminalPanel.terminalTextBuffer,
                        widget.terminal,
                    )
                }
            }
            return TerminalSnapshot(
                "Terminal output unavailable for the new terminal UI. Disable 'terminal.new.ui' and retry.",
                0,
            )
        }

        override fun close() {
            ApplicationManager.getApplication().invokeLater {
                Disposer.dispose(widget)
            }
        }

        override fun isDisposed(): Boolean {
            return isDisposed(widget)
        }
    }

    private class InMemoryTerminalBackend : SessionBackend {
        private val lock = Any()
        private val output = StringBuilder()
        @Volatile
        private var closed = false

        override fun sendInput(data: String) {
            synchronized(lock) {
                if (closed) return
                output.append(data)
            }
        }

        override fun snapshot(): TerminalSnapshot {
            synchronized(lock) {
                val text = output.toString()
                return TerminalSnapshot(text, text.length)
            }
        }

        override fun close() {
            synchronized(lock) {
                closed = true
            }
        }

        override fun isDisposed(): Boolean {
            return closed
        }
    }

    private val sessions = ConcurrentHashMap<String, Session>()

    fun listSessions(): List<Session> {
        syncExistingSessions()
        cleanupDisposed()
        return sessions.values.sortedBy { it.createdAt }
    }

    fun createSession(name: String?, workingDirectory: String?): Session? {
        val project = resolveProject() ?: return null
        val sessionId = UUID.randomUUID().toString()
        val sessionName = name?.trim().takeUnless { it.isNullOrEmpty() }
            ?: "Session ${sessions.size + 1}"
        val sessionDirectory = workingDirectory?.trim().takeUnless { it.isNullOrEmpty() }
            ?: project.basePath
            ?: System.getProperty("user.home")
            ?: "."

        logger.info(
            "createSession: project=${project.name} basePath=${project.basePath} id=$sessionId name=$sessionName dir=$sessionDirectory testMode=${ApplicationManager.getApplication().isUnitTestMode}",
        )

        val backend = if (ApplicationManager.getApplication().isUnitTestMode) {
            logger.info("createSession: using in-memory backend id=$sessionId")
            InMemoryTerminalBackend()
        } else {
            val widget = runCatching {
                runOnEdtWithTimeout(10_000) {
                    createClassicShellWidget(project, sessionDirectory, sessionName, sessionId)
                }
            }.onFailure { error ->
                logger.warn("createSession: failed to create terminal widget id=$sessionId", error)
            }.getOrThrow()
            logger.info("createSession: terminal widget created id=$sessionId")
            IdeaTerminalBackend(widget)
        }
        val session = Session(
            id = sessionId,
            name = sessionName,
            workingDirectory = sessionDirectory,
            createdAt = Instant.now(),
            backend = backend,
        )
        sessions[sessionId] = session
        if (backend is IdeaTerminalBackend) {
            Disposer.register(backend.widget, object : Disposable {
                override fun dispose() {
                    sessions.remove(sessionId)
                    logger.info("Session disposed: id=$sessionId")
                }
            })
        }
        return session
    }

    fun sendInput(sessionId: String, data: String): Boolean {
        val session = sessions[sessionId] ?: run {
            logger.info("sendInput: session missing id=$sessionId")
            return false
        }
        if (session.backend.isDisposed()) {
            sessions.remove(sessionId)
            logger.info("sendInput: session disposed id=$sessionId")
            return false
        }
        session.backend.sendInput(data)
        return true
    }

    fun snapshot(sessionId: String, maxLines: Int): TerminalSnapshot? {
        val session = sessions[sessionId] ?: run {
            logger.info("snapshot: session missing id=$sessionId")
            return null
        }
        if (session.backend.isDisposed()) {
            sessions.remove(sessionId)
            logger.info("snapshot: session disposed id=$sessionId")
            return null
        }

        val snapshot = session.backend.snapshot()
        return trimSnapshot(snapshot, maxLines)
    }

    fun closeSession(sessionId: String): Boolean {
        val session = sessions.remove(sessionId) ?: run {
            logger.info("closeSession: session missing id=$sessionId")
            return false
        }
        logger.info("closeSession: closing id=$sessionId")
        session.backend.close()
        return true
    }

    private fun resolveProject(): Project? {
        val projects = openProjects()
        if (projects.isEmpty()) {
            logger.info("resolveProject: no open projects")
            return null
        }
        val project = projects.firstOrNull()
        if (project == null) {
            logger.info("resolveProject: first project null")
        } else if (project.isDisposed) {
            logger.info("resolveProject: project disposed name=${project.name}")
        }
        return project
    }

    private fun openProjects(): List<Project> {
        return ProjectManager.getInstance().openProjects.filterNot { it.isDisposed }
    }

    private fun createClassicShellWidget(
        project: Project,
        workingDirectory: String,
        tabName: String,
        sessionId: String,
    ): ShellTerminalWidget {
        val terminalManager = TerminalToolWindowManager.getInstance(project)
        val forceClassicTerminal = TunnelTerminalSettingsService.getInstance().isForceClassicTerminal()
        val registry = Registry.get(LocalBlockTerminalRunner.BLOCK_TERMINAL_REGISTRY)
        val wasBlockUiEnabled = registry.asBoolean()
        val shouldDisableTemporarily = wasBlockUiEnabled && !forceClassicTerminal
        if (wasBlockUiEnabled && forceClassicTerminal) {
            logger.info("createSession: force classic terminal UI enabled id=$sessionId")
            registry.setValue(false)
        } else if (shouldDisableTemporarily) {
            logger.info("createSession: disabling new terminal UI id=$sessionId")
            registry.setValue(false)
        }
        try {
            val terminalWidget = terminalManager.createShellWidget(workingDirectory, tabName, false, false)
            logger.info("createSession: terminal widget class=${terminalWidget.javaClass.name} id=$sessionId")
            return ShellTerminalWidget.asShellJediTermWidget(terminalWidget)
                ?: throw IllegalStateException(
                    "New Terminal UI is enabled. Disable 'terminal.new.ui' to create tunnel terminal sessions.",
                )
        } finally {
            if (shouldDisableTemporarily) {
                registry.setValue(true)
                logger.info("createSession: restored new terminal UI flag id=$sessionId")
            }
        }
    }

    private fun syncExistingSessions() {
        if (ApplicationManager.getApplication().isUnitTestMode) return
        val projects = openProjects()
        if (projects.isEmpty()) return
        runOnEdt {
            projects.forEach { project ->
                val terminalManager = TerminalToolWindowManager.getInstance(project)
                val nameByWidget = mutableMapOf<TerminalWidget, String>()
                val toolWindow = terminalManager.toolWindow
                if (toolWindow == null) {
                    logger.info("syncExistingSessions: terminal tool window not initialized project=${project.name}")
                } else {
                    toolWindow.contentManager.contents.forEach { content ->
                        val terminalWidget = TerminalToolWindowManager.findWidgetByContent(content) ?: return@forEach
                        val displayName = content.displayName?.takeIf { it.isNotBlank() }
                        if (displayName != null) {
                            nameByWidget[terminalWidget] = displayName
                        }
                    }
                }

                val widgets = terminalManager.terminalWidgets
                val fallbackWidgets = terminalManager.widgets
                if (widgets.isEmpty() && fallbackWidgets.isEmpty() && nameByWidget.isEmpty()) {
                    return@forEach
                }
                val terminalWidgets = if (widgets.isNotEmpty()) {
                    widgets
                } else if (fallbackWidgets.isNotEmpty()) {
                    fallbackWidgets.map { it.asNewWidget() }.toSet()
                } else {
                    nameByWidget.keys
                }

                terminalWidgets.forEach { terminalWidget ->
                    val existing = sessions.values.any { session ->
                        val backend = session.backend
                        when (backend) {
                            is IdeaTerminalBackend -> backend.widget == ShellTerminalWidget.asShellJediTermWidget(terminalWidget)
                            is TerminalWidgetBackend -> backend.widget == terminalWidget
                            else -> false
                        }
                    }
                    if (existing) return@forEach

                    val shellWidget = ShellTerminalWidget.asShellJediTermWidget(terminalWidget)
                    val sessionId = if (shellWidget != null) {
                        "external-${project.name}-${System.identityHashCode(shellWidget)}"
                    } else {
                        "external-${project.name}-${System.identityHashCode(terminalWidget)}"
                    }
                    val sessionName = nameByWidget[terminalWidget]
                        ?: terminalWidget.terminalTitle.buildTitle().takeIf { it.isNotBlank() }
                        ?: "Terminal"
                    val workingDirectory = shellWidget?.startupOptions?.workingDirectory
                        ?: project.basePath
                        ?: "."
                    val backend = if (shellWidget != null) {
                        IdeaTerminalBackend(shellWidget)
                    } else {
                        val jediWidget = JBTerminalWidget.asJediTermWidget(terminalWidget)
                        if (jediWidget == null) {
                            logger.info("syncExistingSessions: new terminal widget detected name=$sessionName project=${project.name}")
                        }
                        TerminalWidgetBackend(terminalWidget, jediWidget)
                    }
                    val session = Session(
                        id = sessionId,
                        name = sessionName,
                        workingDirectory = workingDirectory,
                        createdAt = Instant.now(),
                        backend = backend,
                    )
                    if (sessions.putIfAbsent(sessionId, session) == null) {
                        logger.info("syncExistingSessions: adopted terminal id=$sessionId name=$sessionName project=${project.name}")
                        val disposable = when (backend) {
                            is IdeaTerminalBackend -> backend.widget
                            is TerminalWidgetBackend -> backend.widget
                            else -> null
                        }
                        if (disposable != null) {
                            Disposer.register(disposable, object : Disposable {
                                override fun dispose() {
                                    sessions.remove(sessionId)
                                    logger.info("Session disposed: id=$sessionId")
                                }
                            })
                        }
                    }
                }
            }
        }
    }

    private fun cleanupDisposed() {
        val iterator = sessions.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (entry.value.backend.isDisposed()) {
                logger.info("cleanupDisposed: removing id=${entry.key}")
                iterator.remove()
            }
        }
    }

    private fun isDisposed(disposable: Disposable): Boolean {
        @Suppress("DEPRECATION")
        return Disposer.isDisposed(disposable)
    }

    private fun trimSnapshot(snapshot: TerminalSnapshot, maxLines: Int): TerminalSnapshot {
        if (maxLines <= 0) return snapshot
        val lines = snapshot.output.split('\n')
        if (lines.size <= maxLines) return snapshot
        val removeCount = lines.size - maxLines
        val removedLength = lines.take(removeCount).sumOf { it.length } + removeCount
        val trimmedOutput = if (removedLength >= snapshot.output.length) {
            ""
        } else {
            snapshot.output.substring(removedLength)
        }
        val adjustedOffset = (snapshot.cursorOffset - removedLength)
            .coerceAtLeast(0)
            .coerceAtMost(trimmedOutput.length)
        val trimmedStyles = trimStyleRuns(snapshot.styles, removedLength, trimmedOutput.length)
        return TerminalSnapshot(trimmedOutput, adjustedOffset, trimmedStyles)
    }

    private fun snapshotTerminalText(buffer: TerminalTextBuffer, terminal: Terminal): TerminalSnapshot {
        buffer.lock()
        try {
            val historyLines = buffer.historyLinesCount
            val screenLines = buffer.screenLinesCount
            val width = buffer.width
            if (historyLines == 0 && screenLines == 0) return TerminalSnapshot("", 0)
            if (screenLines <= 0) return TerminalSnapshot("", 0)
            if (width <= 0) return TerminalSnapshot("", 0)
            val cursorLine = (terminal.cursorY - 1).coerceIn(0, screenLines - 1)
            val cursorColumn = (terminal.cursorX - 1).coerceIn(0, width)
            val palette = ColorPaletteImpl.XTERM_PALETTE
            val defaults = resolveDefaultColors(terminal, palette)
            val styleCache = mutableMapOf<TextStyle, StyleDescriptor>()
            val builder = StringBuilder()
            var cursorOffset = 0
            val styleRuns = mutableListOf<TerminalStyleRun>()
            val lastLineIndex = screenLines - 1
            for (lineIndex in -historyLines until screenLines) {
                val line = buffer.getLine(lineIndex)
                val lineStart = builder.length
                val lineSnapshot = buildLineSnapshot(
                    line = line,
                    width = width,
                    cursorColumn = if (lineIndex == cursorLine) cursorColumn else null,
                    styleResolver = { style -> resolveStyleDescriptor(style, defaults, palette, styleCache) },
                )
                builder.append(lineSnapshot.text)
                lineSnapshot.cursorOffset?.let { offset ->
                    if (lineIndex == cursorLine) {
                        cursorOffset = lineStart + offset.coerceAtMost(lineSnapshot.text.length)
                    }
                }
                if (lineSnapshot.runs.isNotEmpty()) {
                    lineSnapshot.runs.forEach { run ->
                        styleRuns.add(
                            run.copy(
                                start = run.start + lineStart,
                                end = run.end + lineStart,
                            )
                        )
                    }
                }
                if (!line.isWrapped && lineIndex < lastLineIndex) {
                    builder.append('\n')
                }
            }
            return TerminalSnapshot(builder.toString(), cursorOffset, styleRuns)
        } finally {
            buffer.unlock()
        }
    }

    private fun sendInputWithTerminalOutput(output: TerminalOutputStream, terminal: Terminal, data: String) {
        if (data.isEmpty()) return
        val enterCode = terminal.getCodeForKey(KeyEvent.VK_ENTER, 0)
        val buffer = StringBuilder()
        var index = 0
        while (index < data.length) {
            val ch = data[index]
            if (ch == '\r' || ch == '\n') {
                if (buffer.isNotEmpty()) {
                    output.sendString(buffer.toString(), true)
                    buffer.setLength(0)
                }
                if (enterCode != null && enterCode.isNotEmpty()) {
                    output.sendBytes(enterCode, true)
                } else {
                    output.sendString("\r", true)
                }
                if (ch == '\r' && index + 1 < data.length && data[index + 1] == '\n') {
                    index++
                }
            } else {
                buffer.append(ch)
            }
            index++
        }
        if (buffer.isNotEmpty()) {
            output.sendString(buffer.toString(), true)
        }
    }

    private data class LineSnapshot(
        val text: String,
        val runs: List<TerminalStyleRun>,
        val cursorOffset: Int?,
    )

    private data class DefaultColors(val foreground: Color, val background: Color)

    private data class StyleDescriptor(
        val fg: String?,
        val bg: String?,
        val bold: Boolean,
        val italic: Boolean,
        val underline: Boolean,
    )

    private fun buildLineSnapshot(
        line: com.jediterm.terminal.model.TerminalLine,
        width: Int,
        cursorColumn: Int?,
        styleResolver: (TextStyle?) -> StyleDescriptor,
    ): LineSnapshot {
        if (width <= 0) return LineSnapshot("", emptyList(), cursorColumn?.coerceAtLeast(0) ?: 0)
        var lastNonSpace = -1
        for (column in 0 until width) {
            val ch = line.charAt(column)
            val isDwc = ch == CharUtils.DWC
            val displayChar = if (isDwc) CharUtils.EMPTY_CHAR else ch
            if (isDwc || displayChar != CharUtils.EMPTY_CHAR) {
                lastNonSpace = column
            }
        }
        val minColumn = if (cursorColumn != null && cursorColumn > 0) cursorColumn - 1 else -1
        val contentEndColumn = maxOf(lastNonSpace, minColumn)
        val maxCursorColumn = cursorColumn?.coerceAtMost(width - 1) ?: -1
        val scanEndColumn = maxOf(contentEndColumn, maxCursorColumn)
        val builder = StringBuilder()
        val runs = mutableListOf<TerminalStyleRun>()
        var cursorOffset: Int? = null
        var visibleIndex = 0
        var currentStyle: StyleDescriptor? = null
        var runStart = 0

        if (scanEndColumn >= 0) {
            for (column in 0..scanEndColumn) {
                if (cursorColumn != null && column == cursorColumn) {
                    cursorOffset = visibleIndex
                }
                if (column > contentEndColumn) {
                    continue
                }
                val ch = line.charAt(column)
                val displayChar = if (ch == CharUtils.DWC) CharUtils.EMPTY_CHAR else ch
                val style = styleResolver(line.getStyleAt(column))
                if (currentStyle == null || currentStyle != style) {
                    if (currentStyle != null && runStart < visibleIndex) {
                        runs.add(
                            TerminalStyleRun(
                                start = runStart,
                                end = visibleIndex,
                                fg = currentStyle.fg,
                                bg = currentStyle.bg,
                                bold = currentStyle.bold,
                                italic = currentStyle.italic,
                                underline = currentStyle.underline,
                            )
                        )
                    }
                    currentStyle = style
                    runStart = visibleIndex
                }
                builder.append(displayChar)
                visibleIndex++
            }
        }

        if (cursorColumn != null && cursorColumn >= width) {
            cursorOffset = visibleIndex
        }

        if (currentStyle != null && runStart < visibleIndex) {
            runs.add(
                TerminalStyleRun(
                    start = runStart,
                    end = visibleIndex,
                    fg = currentStyle.fg,
                    bg = currentStyle.bg,
                    bold = currentStyle.bold,
                    italic = currentStyle.italic,
                    underline = currentStyle.underline,
                )
            )
        }

        return LineSnapshot(builder.toString(), runs, cursorOffset ?: visibleIndex)
    }

    private fun resolveDefaultColors(terminal: Terminal, palette: ColorPalette): DefaultColors {
        val windowForeground = terminal.windowForeground
        val windowBackground = terminal.windowBackground
        val styleState = terminal.styleState
        val foreground = windowForeground
            ?: resolveTerminalColor(styleState.defaultForeground, palette, isForeground = true)
        val background = windowBackground
            ?: resolveTerminalColor(styleState.defaultBackground, palette, isForeground = false)
        return DefaultColors(foreground, background)
    }

    private fun resolveStyleDescriptor(
        style: TextStyle?,
        defaults: DefaultColors,
        palette: ColorPalette,
        cache: MutableMap<TextStyle, StyleDescriptor>,
    ): StyleDescriptor {
        val resolvedStyle = style ?: TextStyle.EMPTY
        return cache.getOrPut(resolvedStyle) {
            val hasInverse = resolvedStyle.hasOption(TextStyle.Option.INVERSE)
            val hasDim = resolvedStyle.hasOption(TextStyle.Option.DIM)
            val foregroundColor = resolvedStyle.foreground?.let { resolveTerminalColor(it, palette, true) }
                ?: defaults.foreground
            val backgroundColor = resolvedStyle.background?.let { resolveTerminalColor(it, palette, false) }
                ?: defaults.background
            var effectiveForeground = if (hasInverse) backgroundColor else foregroundColor
            val effectiveBackground = if (hasInverse) foregroundColor else backgroundColor
            if (hasDim) {
                effectiveForeground = blendColors(effectiveForeground, effectiveBackground)
            }
            StyleDescriptor(
                fg = toHex(effectiveForeground),
                bg = toHex(effectiveBackground),
                bold = resolvedStyle.hasOption(TextStyle.Option.BOLD),
                italic = resolvedStyle.hasOption(TextStyle.Option.ITALIC),
                underline = resolvedStyle.hasOption(TextStyle.Option.UNDERLINED),
            )
        }
    }

    private fun resolveTerminalColor(
        color: TerminalColor,
        palette: ColorPalette,
        isForeground: Boolean,
    ): Color {
        if (!color.isIndexed) {
            return color.toColor()
        }
        val index = color.colorIndex
        if (index in 0..15) {
            return if (isForeground) palette.getForeground(color) else palette.getBackground(color)
        }
        val extended = ColorPalette.getIndexedTerminalColor(index)
        if (extended != null && !extended.isIndexed) {
            return extended.toColor()
        }
        val fallback = TerminalColor.index(index % 16)
        return if (isForeground) palette.getForeground(fallback) else palette.getBackground(fallback)
    }

    private fun blendColors(foreground: Color, background: Color): Color {
        val red = (foreground.red + background.red) / 2
        val green = (foreground.green + background.green) / 2
        val blue = (foreground.blue + background.blue) / 2
        val alpha = foreground.alpha
        return Color(red, green, blue, alpha)
    }

    private fun toHex(color: Color): String {
        return String.format("#%02x%02x%02x", color.red, color.green, color.blue)
    }

    private fun trimStyleRuns(
        runs: List<TerminalStyleRun>,
        removedLength: Int,
        newLength: Int,
    ): List<TerminalStyleRun> {
        if (runs.isEmpty()) return runs
        val result = mutableListOf<TerminalStyleRun>()
        runs.forEach { run ->
            val start = run.start - removedLength
            val end = run.end - removedLength
            if (end <= 0 || start >= newLength) return@forEach
            val clippedStart = start.coerceAtLeast(0)
            val clippedEnd = end.coerceAtMost(newLength)
            if (clippedEnd > clippedStart) {
                result.add(run.copy(start = clippedStart, end = clippedEnd))
            }
        }
        return result
    }

    private fun <T> runOnEdt(action: () -> T): T {
        val app = ApplicationManager.getApplication()
        if (app.isDispatchThread) {
            return action()
        }
        val ref = AtomicReference<T>()
        app.invokeAndWait { ref.set(action()) }
        return ref.get()
    }

    private fun <T> runOnEdtWithTimeout(timeoutMs: Long, action: () -> T): T {
        val app = ApplicationManager.getApplication()
        if (app.isDispatchThread) {
            return action()
        }
        val future = CompletableFuture<T>()
        app.invokeLater {
            try {
                future.complete(action())
            } catch (error: Exception) {
                future.completeExceptionally(error)
            }
        }
        return try {
            future.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (error: TimeoutException) {
            throw IllegalStateException("Timed out creating terminal session")
        } catch (error: ExecutionException) {
            throw error.cause ?: error
        }
    }
}
