package com.intellij.tunnel.terminal

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.Disposer
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
                    val terminalManager = TerminalToolWindowManager.getInstance(project)
                    val terminalWidget = terminalManager.createShellWidget(sessionDirectory, sessionName, false, false)
                    if (terminalWidget == null) {
                        logger.warn("createSession: terminal widget null id=$sessionId")
                        throw IllegalStateException("Terminal widget unavailable. Open the Terminal tool window and retry.")
                    }
                    logger.info("createSession: terminal widget class=${terminalWidget.javaClass.name} id=$sessionId")
                    runCatching { ShellTerminalWidget.toShellJediTermWidgetOrThrow(terminalWidget) }
                        .onFailure { error ->
                            logger.warn(
                                "createSession: failed to convert terminal widget id=$sessionId class=${terminalWidget.javaClass.name}",
                                error,
                            )
                        }
                        .getOrThrow()
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
        val projects = ProjectManager.getInstance().openProjects
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
