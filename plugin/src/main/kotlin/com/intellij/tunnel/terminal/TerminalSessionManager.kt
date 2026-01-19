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
import org.jetbrains.plugins.terminal.LocalBlockTerminalRunner
import org.jetbrains.plugins.terminal.ShellTerminalWidget
import org.jetbrains.plugins.terminal.TerminalToolWindowManager
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

    internal sealed interface SessionBackend {
        fun sendInput(data: String)
        fun snapshot(): String
        fun close()
        fun isDisposed(): Boolean
    }

    private inner class IdeaTerminalBackend(val widget: ShellTerminalWidget) : SessionBackend {
        override fun sendInput(data: String) {
            ApplicationManager.getApplication().invokeLater {
                widget.executeWithTtyConnector { connector ->
                    try {
                        connector.write(data)
                    } catch (_: Exception) {
                        // Ignore terminal write failures.
                    }
                }
            }
        }

        override fun snapshot(): String {
            return runOnEdt { widget.text }
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
                widget.ttyConnectorAccessor.executeWithTtyConnector { connector ->
                    try {
                        connector.write(data)
                    } catch (_: Exception) {
                        // Ignore terminal write failures.
                    }
                }
            }
        }

        override fun snapshot(): String {
            val widget = jediWidget
            if (widget != null) {
                return runOnEdt { widget.text }
            }
            return "Terminal output unavailable for the new terminal UI. Disable 'terminal.new.ui' and retry."
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

        override fun snapshot(): String {
            synchronized(lock) {
                return output.toString()
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

    fun snapshot(sessionId: String, maxLines: Int): String? {
        val session = sessions[sessionId] ?: run {
            logger.info("snapshot: session missing id=$sessionId")
            return null
        }
        if (session.backend.isDisposed()) {
            sessions.remove(sessionId)
            logger.info("snapshot: session disposed id=$sessionId")
            return null
        }

        val output = session.backend.snapshot()
        return trimOutput(output, maxLines)
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
        val registry = Registry.get(LocalBlockTerminalRunner.BLOCK_TERMINAL_REGISTRY)
        val wasBlockUiEnabled = registry.asBoolean()
        if (wasBlockUiEnabled) {
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
            if (wasBlockUiEnabled) {
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

    private fun trimOutput(text: String, maxLines: Int): String {
        if (maxLines <= 0) return text
        val lines = text.split('\n')
        if (lines.size <= maxLines) return text
        return lines.takeLast(maxLines).joinToString("\n")
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
