package com.intellij.tunnel.server

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.build.BuildProgressListener
import com.intellij.build.BuildViewManager
import com.intellij.build.events.BuildEvent
import com.intellij.build.events.FinishBuildEvent
import com.intellij.build.events.MessageEvent
import com.intellij.build.events.OutputBuildEvent
import com.intellij.build.events.StartBuildEvent
import com.intellij.execution.ExecutionListener
import com.intellij.execution.ExecutionManager
import com.intellij.execution.ProgramRunnerUtil
import com.intellij.execution.RunManager
import com.intellij.execution.RunnerAndConfigurationSettings
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.process.ProcessOutputType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManagerListener
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.project.ProjectManagerListener
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Computable
import com.intellij.openapi.util.Disposer
import com.intellij.task.ProjectTaskManager
import com.intellij.tunnel.auth.TunnelAuthService
import com.intellij.tunnel.terminal.TerminalSessionManager
import com.intellij.tunnel.util.NetworkUtils
import com.intellij.util.messages.MessageBusConnection
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.origin
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.DefaultWebSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import io.ktor.websocket.send
import java.net.BindException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import io.ktor.http.ContentType

class TunnelServer {
    private val logger = Logger.getInstance(TunnelServer::class.java)
    private val gson = Gson()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sessions = ConcurrentHashMap<String, DefaultWebSocketSession>()
    private val connectionContexts = ConcurrentHashMap<String, ConnectionContext>()
    private var port = 8765
    private val hostAddress = NetworkUtils.resolveHostAddress()
    private var engine: ApplicationEngine? = null
    private val terminalManager = TerminalSessionManager()
    private val authService = TunnelAuthService.getInstance()
    private val terminalSubscriptions = ConcurrentHashMap<String, MutableSet<String>>()
    private val terminalLastOutput = ConcurrentHashMap<String, TerminalSessionManager.TerminalSnapshot>()
    @Volatile
    private var terminalStreamingJob: Job? = null
    private val terminalStreamLines = 200
    private val terminalStreamIntervalMs = 1000L
    private val progressTasks = ConcurrentHashMap<String, TrackedTask>()
    @Volatile
    private var progressConnection: MessageBusConnection? = null
    @Volatile
    private var progressUpdateJob: Job? = null
    private val progressUpdateIntervalMs = 1000L
    @Volatile
    private var lastProgressSnapshot: List<Map<String, Any?>>? = null
    private val runOutputContexts = ConcurrentHashMap<ProcessHandler, RunOutputContext>()
    private val runOutputListeners = ConcurrentHashMap<ProcessHandler, ProcessListener>()
    @Volatile
    private var executionConnection: MessageBusConnection? = null
    private val buildLogDisposables = ConcurrentHashMap<Project, Disposable>()
    private val buildLogContexts = ConcurrentHashMap<Project, ConcurrentHashMap<Any, BuildLogContext>>()
    @Volatile
    private var buildLogConnection: MessageBusConnection? = null

    val deviceRegistry = DeviceRegistry()

    private data class ConnectionContext(
        val connectionId: String,
        val remoteAddress: String,
        var deviceId: String,
        var deviceName: String,
        var approved: Boolean,
        var approvalRequested: Boolean,
    )

    private enum class IdeTaskKind(val defaultTitle: String) {
        INDEXING("Indexing"),
        BUILD("Build"),
        SYNC("Sync"),
    }

    private data class TrackedTask(
        val id: String,
        val task: Task,
        val indicator: ProgressIndicator,
        val projectName: String?,
        val startedAt: Instant,
    )

    private data class RunOutputContext(
        val runId: String,
        val name: String,
        val configId: String?,
        val executorId: String,
        val projectName: String?,
    )

    private data class BuildLogContext(
        val title: String,
        val projectName: String,
    )

    private data class RunConfigurationEntry(
        val id: String,
        val name: String,
        val type: String,
        val folder: String?,
        val temporary: Boolean,
        val shared: Boolean,
    )

    fun start() {
        if (engine != null) return
        val candidate = createServer(port)
        try {
            candidate.start(wait = false)
            engine = candidate
        } catch (error: Exception) {
            if (error is BindException || error.cause is BindException) {
                val fallback = createServer(0)
                fallback.start(wait = false)
                engine = fallback
            } else {
                throw error
            }
        }
        engine?.let { port = resolvePort(it) }
        ensureTerminalStreaming()
        startProgressTracking()
        startExecutionTracking()
        startBuildLogTracking()
        logger.info("Tunnel server started at ${serverInfo().wsUrl}")
    }

    fun stop() {
        logger.info("Tunnel server stopping")
        engine?.stop(1000, 2000)
        engine = null
        terminalStreamingJob?.cancel()
        terminalStreamingJob = null
        stopProgressTracking()
        stopExecutionTracking()
        stopBuildLogTracking()
        scope.cancel()
    }

    fun serverInfo(): ServerInfo {
        val httpUrl = "http://$hostAddress:$port"
        val wsUrl = "ws://$hostAddress:$port/ws"
        return ServerInfo(
            httpUrl = httpUrl,
            wsUrl = wsUrl,
            port = port,
            hostAddress = hostAddress,
            pairingToken = authService.token(),
        )
    }

    fun disconnectDevice(deviceId: String, reason: String = "Disconnected by IDE") {
        val session = sessions[deviceId] ?: return
        logger.info("Disconnecting device id=$deviceId")
        scope.launch {
            runCatching { session.close(CloseReason(CloseReason.Codes.NORMAL, reason)) }
        }
    }

    private fun createServer(port: Int): ApplicationEngine {
        return embeddedServer(Netty, port = port, host = "0.0.0.0") {
            configureServer()
        }
    }

    private fun resolvePort(engine: ApplicationEngine): Int {
        val resolved = runBlocking { engine.resolvedConnectors().firstOrNull()?.port }
        return resolved ?: engine.environment.connectors.firstOrNull()?.port ?: port
    }

    private fun Application.configureServer() {
        install(WebSockets) {
            pingPeriodMillis = 15_000
            timeoutMillis = 30_000
            maxFrameSize = Long.MAX_VALUE
            masking = false
        }

        routing {
            get("/") {
                call.respondText("IntelliJ Tunnel server is running")
            }
            get("/pair") {
                call.respondText(gson.toJson(serverInfo()), ContentType.Application.Json)
            }
            webSocket("/ws") {
                val presentedToken = call.request.queryParameters["token"]
                    ?: call.request.headers["X-Tunnel-Token"]
                if (!authService.isTokenValid(presentedToken)) {
                    logger.warn("WebSocket rejected: invalid token from ${call.request.origin.remoteHost}")
                    runCatching {
                        send(
                            gson.toJson(
                                mapOf(
                                    "type" to "error",
                                    "code" to "invalid_token",
                                    "message" to "Invalid pairing token.",
                                )
                            )
                        )
                    }
                    close(CloseReason(CloseReason.Codes.CANNOT_ACCEPT, "Invalid pairing token"))
                    return@webSocket
                }

                val connectionId = UUID.randomUUID().toString()
                val remoteAddress = call.request.origin.remoteHost
                val context = ConnectionContext(
                    connectionId = connectionId,
                    remoteAddress = remoteAddress,
                    deviceId = connectionId,
                    deviceName = "Unknown device",
                    approved = false,
                    approvalRequested = false,
                )
                sessions[connectionId] = this
                connectionContexts[connectionId] = context
                logger.info("WebSocket connected: id=$connectionId remote=$remoteAddress")
                sendJson(this, mapOf("type" to "hello_ack", "deviceId" to connectionId), connectionId)
                try {
                    for (frame in incoming) {
                        if (frame is Frame.Text) {
                            val text = frame.readText()
                            if (logger.isDebugEnabled) {
                                logger.debug("WebSocket recv: id=$connectionId text=$text")
                            }
                            handleMessage(text, connectionId, this)
                        }
                    }
                } catch (error: Exception) {
                    logger.info("WebSocket failure for id=$connectionId", error)
                } finally {
                    val reason = runCatching { closeReason.await() }.getOrNull()
                    logger.info("WebSocket disconnected: id=$connectionId reason=${reason ?: "unknown"}")
                    sessions.remove(connectionId)
                    connectionContexts.remove(connectionId)
                    deviceRegistry.removeDevice(connectionId)
                    removeSubscriptions(connectionId)
                    close()
                }
            }
        }
    }

    private fun ensureTerminalStreaming() {
        val existing = terminalStreamingJob
        if (existing?.isActive == true) return
        terminalStreamingJob = scope.launch {
            while (true) {
                try {
                    pushTerminalUpdates()
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    logger.debug("Terminal streaming loop failed", error)
                }
                delay(terminalStreamIntervalMs)
            }
        }
    }

    private fun startProgressTracking() {
        if (progressConnection != null) return
        progressConnection = ApplicationManager.getApplication().messageBus.connect()
        progressConnection?.subscribe(ProgressManagerListener.TOPIC, object : ProgressManagerListener {
            override fun afterTaskStart(task: Task, indicator: ProgressIndicator) {
                trackProgressTask(task, indicator)
            }

            override fun afterTaskFinished(task: Task) {
                untrackProgressTask(task)
            }
        })
        ensureProgressUpdates()
    }

    private fun stopProgressTracking() {
        progressConnection?.disconnect()
        progressConnection = null
        progressUpdateJob?.cancel()
        progressUpdateJob = null
        progressTasks.clear()
        lastProgressSnapshot = null
    }

    private fun startExecutionTracking() {
        if (executionConnection != null) return
        executionConnection = ApplicationManager.getApplication().messageBus.connect()
        executionConnection?.subscribe(ExecutionManager.EXECUTION_TOPIC, object : ExecutionListener {
            override fun processStarted(
                executorId: String,
                env: com.intellij.execution.runners.ExecutionEnvironment,
                handler: ProcessHandler,
            ) {
                attachRunOutputListener(executorId, env, handler)
            }

            override fun processTerminated(
                executorId: String,
                env: com.intellij.execution.runners.ExecutionEnvironment,
                handler: ProcessHandler,
                exitCode: Int,
            ) {
                detachRunOutputListener(handler)
            }
        })
    }

    private fun stopExecutionTracking() {
        executionConnection?.disconnect()
        executionConnection = null
        runOutputListeners.forEach { (handler, listener) ->
            runCatching { handler.removeProcessListener(listener) }
        }
        runOutputListeners.clear()
        runOutputContexts.clear()
    }

    private fun startBuildLogTracking() {
        if (buildLogConnection != null) return
        ProjectManager.getInstance().openProjects.forEach { attachBuildLogger(it) }
        buildLogConnection = ApplicationManager.getApplication().messageBus.connect()
        buildLogConnection?.subscribe(ProjectManager.TOPIC, object : ProjectManagerListener {
            @Suppress("OVERRIDE_DEPRECATION")
            override fun projectOpened(project: Project) {
                attachBuildLogger(project)
            }

            @Suppress("OVERRIDE_DEPRECATION")
            override fun projectClosed(project: Project) {
                detachBuildLogger(project)
            }
        })
    }

    private fun stopBuildLogTracking() {
        buildLogConnection?.disconnect()
        buildLogConnection = null
        buildLogDisposables.values.forEach { Disposer.dispose(it) }
        buildLogDisposables.clear()
        buildLogContexts.clear()
    }

    private fun attachRunOutputListener(
        executorId: String,
        env: com.intellij.execution.runners.ExecutionEnvironment,
        handler: ProcessHandler,
    ) {
        if (runOutputContexts.containsKey(handler)) return
        val settings = env.runnerAndConfigurationSettings
        val runId = env.executionId.takeIf { it != 0L }?.toString()
            ?: "run-${System.identityHashCode(handler)}"
        val name = settings?.name?.takeIf { it.isNotBlank() }
            ?: env.runProfile.name.takeIf { it.isNotBlank() }
            ?: "Run"
        val configId = settings?.let { runConfigurationId(it) }
        val context = RunOutputContext(
            runId = runId,
            name = name,
            configId = configId,
            executorId = executorId,
            projectName = env.project.name.takeIf { it.isNotBlank() },
        )
        runOutputContexts[handler] = context
        val listener = object : ProcessListener {
            override fun onTextAvailable(event: ProcessEvent, outputType: com.intellij.openapi.util.Key<*>) {
                val text = event.text
                if (text.isBlank()) return
                val stream = when (outputType) {
                    ProcessOutputType.STDOUT -> "stdout"
                    ProcessOutputType.STDERR -> "stderr"
                    ProcessOutputType.SYSTEM -> "system"
                    else -> "system"
                }
                broadcastRunOutput(context, text, stream)
            }

            override fun processTerminated(event: ProcessEvent) {
                detachRunOutputListener(handler)
            }
        }
        runOutputListeners[handler] = listener
        handler.addProcessListener(listener)
    }

    private fun detachRunOutputListener(handler: ProcessHandler) {
        val listener = runOutputListeners.remove(handler) ?: return
        runOutputContexts.remove(handler)
        runCatching { handler.removeProcessListener(listener) }
    }

    private fun attachBuildLogger(project: Project) {
        if (project.isDisposed) return
        if (buildLogDisposables.containsKey(project)) return
        val disposable = Disposer.newDisposable("TunnelBuildLogTracker:${project.name}")
        buildLogDisposables[project] = disposable
        val contextMap = ConcurrentHashMap<Any, BuildLogContext>()
        buildLogContexts[project] = contextMap
        val manager = project.service<BuildViewManager>()
        manager.addListener(object : BuildProgressListener {
            override fun onEvent(buildId: Any, event: BuildEvent) {
                when (event) {
                    is StartBuildEvent -> {
                        val title = event.buildDescriptor.title.takeIf { it.isNotBlank() } ?: "Build"
                        contextMap[buildId] = BuildLogContext(title, project.name)
                    }
                    is FinishBuildEvent -> {
                        contextMap.remove(buildId)
                    }
                }
                val context = contextMap[buildId] ?: BuildLogContext("Build", project.name)
                when (event) {
                    is OutputBuildEvent -> {
                        val text = event.message
                        if (text.isBlank()) return
                        val level = when (event.outputType) {
                            ProcessOutputType.STDERR -> "stderr"
                            ProcessOutputType.SYSTEM -> "system"
                            else -> "stdout"
                        }
                        broadcastBuildOutput(buildId, context, text, level)
                    }
                    is MessageEvent -> {
                        val text = event.message
                        if (text.isBlank()) return
                        val level = event.kind.name.lowercase()
                        broadcastBuildOutput(buildId, context, text, level)
                    }
                }
            }
        }, disposable)
    }

    private fun detachBuildLogger(project: Project) {
        val disposable = buildLogDisposables.remove(project) ?: return
        Disposer.dispose(disposable)
        buildLogContexts.remove(project)
    }

    private fun broadcastRunOutput(context: RunOutputContext, text: String, stream: String) {
        val payload = mutableMapOf<String, Any>(
            "type" to "run_output",
            "runId" to context.runId,
            "name" to context.name,
            "text" to text,
            "stream" to stream,
            "executorId" to context.executorId,
        )
        context.configId?.let { payload["configId"] = it }
        context.projectName?.let { payload["projectName"] = it }
        broadcast(payload)
    }

    private fun broadcastBuildOutput(buildId: Any, context: BuildLogContext, text: String, level: String) {
        val payload = mutableMapOf<String, Any>(
            "type" to "build_output",
            "buildId" to buildId.toString(),
            "title" to context.title,
            "text" to text,
            "level" to level,
            "projectName" to context.projectName,
        )
        broadcast(payload)
    }

    private fun ensureProgressUpdates() {
        val existing = progressUpdateJob
        if (existing?.isActive == true) return
        progressUpdateJob = scope.launch {
            while (true) {
                try {
                    pushProgressSnapshot()
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    logger.debug("Progress tracking loop failed", error)
                }
                delay(progressUpdateIntervalMs)
            }
        }
    }

    @Synchronized
    private fun pushProgressSnapshot(force: Boolean = false) {
        val snapshot = buildProgressSnapshot()
        if (!force && snapshot == lastProgressSnapshot) return
        lastProgressSnapshot = snapshot
        broadcast(mapOf("type" to "ide_progress", "tasks" to snapshot))
    }

    private fun buildProgressSnapshot(): List<Map<String, Any?>> {
        if (progressTasks.isEmpty()) return emptyList()
        val snapshots = mutableListOf<Map<String, Any?>>()
        progressTasks.forEach { (id, task) ->
            val indicator = task.indicator
            if (!indicator.isRunning && !indicator.isIndeterminate) {
                progressTasks.remove(id)
                return@forEach
            }
            val kind = classifyTask(task.task, indicator) ?: return@forEach
            val title = resolveTaskTitle(task.task, indicator, kind)
            val textParts = listOf(indicator.text, indicator.text2)
                .mapNotNull { it?.trim()?.takeIf { value -> value.isNotEmpty() } }
                .filterNot { it.equals(title, ignoreCase = true) }
            val detail = textParts.joinToString(" - ").ifBlank { null }
            val fraction = if (!indicator.isIndeterminate) indicator.fraction else null
            val safeFraction = fraction?.takeIf { it.isFinite() && it >= 0.0 }
            snapshots.add(
                mapOf(
                    "id" to id,
                    "kind" to kind.name.lowercase(),
                    "title" to title,
                    "text" to detail,
                    "fraction" to safeFraction,
                    "indeterminate" to indicator.isIndeterminate,
                    "projectName" to task.projectName,
                    "startedAt" to task.startedAt.toString(),
                )
            )
        }
        return snapshots.sortedBy { it["startedAt"] as String }
    }

    private fun sendProgressSnapshot(session: DefaultWebSocketSession, connectionId: String) {
        val snapshot = buildProgressSnapshot()
        lastProgressSnapshot = snapshot
        sendJson(session, mapOf("type" to "ide_progress", "tasks" to snapshot), connectionId)
    }

    private fun trackProgressTask(task: Task, indicator: ProgressIndicator) {
        val id = taskId(task)
        val projectName = task.project?.name?.takeIf { it.isNotBlank() }
        progressTasks[id] = TrackedTask(id, task, indicator, projectName, Instant.now())
        pushProgressSnapshot(force = true)
    }

    private fun untrackProgressTask(task: Task) {
        val id = taskId(task)
        if (progressTasks.remove(id) != null) {
            pushProgressSnapshot(force = true)
        }
    }

    private fun classifyTask(task: Task, indicator: ProgressIndicator): IdeTaskKind? {
        val combined = sequenceOf(task.title, indicator.text, indicator.text2)
            .mapNotNull { it?.trim()?.takeIf { value -> value.isNotEmpty() } }
            .joinToString(" ")
            .lowercase()
        if (combined.isBlank()) return null
        if (combined.contains("index") || combined.contains("scann")) {
            return IdeTaskKind.INDEXING
        }
        val buildHints = listOf("build", "compile", "make", "assemble", "rebuild", "javac", "kotlinc", "compiler")
        val syncHints = listOf(
            "import",
            "sync",
            "refresh",
            "reload",
            "resolve",
            "dependency",
            "gradle",
            "maven",
            "external system",
        )
        val hasBuildHint = buildHints.any { combined.contains(it) }
        val hasSyncHint = syncHints.any { combined.contains(it) }
        if (hasBuildHint) {
            return IdeTaskKind.BUILD
        }
        if (hasSyncHint) {
            return IdeTaskKind.SYNC
        }
        return null
    }

    private fun resolveTaskTitle(task: Task, indicator: ProgressIndicator, kind: IdeTaskKind): String {
        return sequenceOf(task.title, indicator.text, indicator.text2)
            .mapNotNull { it?.trim()?.takeIf { value -> value.isNotEmpty() } }
            .firstOrNull()
            ?: kind.defaultTitle
    }

    private fun taskId(task: Task): String {
        val rawId = task.id?.toString()?.trim().orEmpty()
        return if (rawId.isNotEmpty()) rawId else "task-${System.identityHashCode(task)}"
    }

    private fun handleMessage(text: String, connectionId: String, session: DefaultWebSocketSession) {
        val payload = runCatching { gson.fromJson(text, JsonObject::class.java) }.getOrNull()
            ?: run {
                logger.warn("Invalid JSON from id=$connectionId (${text.length} chars)")
                return
            }
        val context = connectionContexts[connectionId] ?: return
        val type = payload.get("type")?.asString ?: return
        if (logger.isDebugEnabled) {
            logger.debug("WebSocket message: id=$connectionId type=$type")
        }
        try {
            when (type) {
                "hello" -> {
                    handleHello(payload, connectionId, session, context)
                }
                "list_sessions" -> {
                    if (!ensureApproved(connectionId, session, context)) return
                    val sessions = terminalManager.listSessions().map { sessionInfo(it) }
                    sendJson(session, mapOf("type" to "sessions", "items" to sessions), connectionId)
                }
                "start_terminal" -> {
                    if (!ensureApproved(connectionId, session, context)) return
                    val name = payload.get("name")?.asString
                    val workingDirectory = payload.get("workingDirectory")?.asString
                    val created = runCatching { terminalManager.createSession(name, workingDirectory) }
                        .getOrElse { error ->
                            logger.warn(
                                "Failed to start terminal for id=$connectionId name=$name dir=$workingDirectory",
                                error,
                            )
                            sendJson(
                                session,
                                mapOf(
                                    "type" to "terminal_error",
                                    "message" to (error.message ?: error::class.java.simpleName),
                                ),
                                connectionId,
                            )
                            return
                        }
                if (created == null) {
                    sendJson(session, mapOf("type" to "terminal_error", "message" to "No project is open."), connectionId)
                } else {
                    sendJson(session, mapOf("type" to "terminal_started", "session" to sessionInfo(created)), connectionId)
                }
                }
                "terminal_input" -> {
                    if (!ensureApproved(connectionId, session, context)) return
                    val sessionId = payload.get("sessionId")?.asString?.trim().orEmpty()
                    val data = payload.get("data")?.asString ?: ""
                    if (sessionId.isEmpty() || data.isEmpty()) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Missing sessionId or data."), connectionId)
                        return
                    }
                    val ok = terminalManager.sendInput(sessionId, data)
                    if (!ok) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Session not found."), connectionId)
                    }
                }
                "terminal_snapshot" -> {
                    if (!ensureApproved(connectionId, session, context)) return
                    val sessionId = payload.get("sessionId")?.asString?.trim().orEmpty()
                    val maxLines = payload.get("lines")?.asInt ?: 200
                    if (sessionId.isEmpty()) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Missing sessionId."), connectionId)
                        return
                    }
                    val snapshot = terminalManager.snapshot(sessionId, maxLines)
                    if (snapshot == null) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Session not found."), connectionId)
                    } else {
                        sendJson(
                            session,
                            mapOf(
                                "type" to "terminal_output",
                                "sessionId" to sessionId,
                                "output" to snapshot.output,
                                "cursorOffset" to snapshot.cursorOffset,
                                "styles" to snapshot.styles,
                            ),
                            connectionId,
                        )
                    }
                }
                "terminal_subscribe" -> {
                    if (!ensureApproved(connectionId, session, context)) return
                    val sessionId = payload.get("sessionId")?.asString?.trim().orEmpty()
                    if (sessionId.isEmpty()) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Missing sessionId."), connectionId)
                        return
                    }
                    subscribeToSession(connectionId, session, sessionId)
                }
                "terminal_unsubscribe" -> {
                    if (!ensureApproved(connectionId, session, context)) return
                    val sessionId = payload.get("sessionId")?.asString?.trim().orEmpty()
                    if (sessionId.isEmpty()) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Missing sessionId."), connectionId)
                        return
                    }
                    unsubscribeFromSession(connectionId, sessionId)
                }
                "close_terminal" -> {
                    if (!ensureApproved(connectionId, session, context)) return
                    val sessionId = payload.get("sessionId")?.asString?.trim().orEmpty()
                    if (sessionId.isEmpty()) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Missing sessionId."), connectionId)
                        return
                    }
                    val closed = terminalManager.closeSession(sessionId)
                    if (!closed) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Session not found."), connectionId)
                    } else {
                        sendJson(session, mapOf("type" to "terminal_closed", "sessionId" to sessionId), connectionId)
                    }
                }
                "build_project" -> {
                    if (!ensureApproved(connectionId, session, context)) return
                    triggerBuild()
                }
                "list_ide_progress" -> {
                    if (!ensureApproved(connectionId, session, context)) return
                    sendProgressSnapshot(session, connectionId)
                }
                "list_run_configurations" -> {
                    if (!ensureApproved(connectionId, session, context)) return
                    sendRunConfigurations(session, connectionId)
                }
                "run_configuration" -> {
                    if (!ensureApproved(connectionId, session, context)) return
                    val id = payload.get("id")?.asString?.trim().orEmpty()
                    if (id.isEmpty()) {
                        sendJson(
                            session,
                            mapOf(
                                "type" to "run_configuration_status",
                                "status" to "failed",
                                "id" to "",
                                "message" to "Missing id.",
                            ),
                            connectionId,
                        )
                        return
                    }
                    runConfigurationById(id, session, connectionId)
                }
                else -> {
                    sendJson(session, mapOf("type" to "error", "message" to "Unknown message type: $type"), connectionId)
                }
            }
        } catch (error: Exception) {
            val message = error.message?.takeIf { it.isNotBlank() } ?: "unknown error"
            logger.warn("Failed to handle message type '$type' from $connectionId", error)
            sendJson(session, mapOf("type" to "error", "message" to "Failed to handle '$type': $message"), connectionId)
        }
    }

    private fun handleHello(
        payload: JsonObject,
        connectionId: String,
        session: DefaultWebSocketSession,
        context: ConnectionContext,
    ) {
        val name = payload.get("deviceName")?.asString?.trim().orEmpty()
        if (name.isNotEmpty()) {
            context.deviceName = name
        }
        val deviceId = payload.get("deviceId")?.asString?.trim().orEmpty()
        if (deviceId.isNotEmpty()) {
            context.deviceId = deviceId
        }
        if (authService.isDeviceApproved(context.deviceId)) {
            approveConnection(connectionId, session, context)
        } else {
            requestApproval(connectionId, session, context)
        }
    }

    private fun ensureApproved(
        connectionId: String,
        session: DefaultWebSocketSession,
        context: ConnectionContext,
    ): Boolean {
        if (context.approved) return true
        if (context.approvalRequested) {
            sendJson(
                session,
                mapOf("type" to "approval_pending", "message" to "Waiting for IDE approval."),
                connectionId,
            )
            return false
        }
        sendJson(
            session,
            mapOf("type" to "approval_required", "message" to "Device approval required."),
            connectionId,
        )
        return false
    }

    private fun subscribeToSession(
        connectionId: String,
        session: DefaultWebSocketSession,
        sessionId: String,
    ) {
        val snapshot = terminalManager.snapshot(sessionId, terminalStreamLines)
        if (snapshot == null) {
            sendJson(session, mapOf("type" to "terminal_error", "message" to "Session not found."), connectionId)
            return
        }
        val subscriptions = terminalSubscriptions.computeIfAbsent(connectionId) {
            ConcurrentHashMap.newKeySet()
        }
        subscriptions.add(sessionId)
        terminalLastOutput[sessionId] = snapshot
        sendJson(
            session,
            mapOf(
                "type" to "terminal_output",
                "sessionId" to sessionId,
                "output" to snapshot.output,
                "cursorOffset" to snapshot.cursorOffset,
                "styles" to snapshot.styles,
            ),
            connectionId,
        )
    }

    private fun unsubscribeFromSession(connectionId: String, sessionId: String) {
        val subscriptions = terminalSubscriptions[connectionId] ?: return
        subscriptions.remove(sessionId)
        if (subscriptions.isEmpty()) {
            terminalSubscriptions.remove(connectionId, subscriptions)
        }
        cleanupTerminalOutputCache(sessionId)
    }

    private fun removeSubscriptions(connectionId: String) {
        val subscriptions = terminalSubscriptions.remove(connectionId) ?: return
        subscriptions.forEach { sessionId ->
            cleanupTerminalOutputCache(sessionId)
        }
    }

    private fun cleanupTerminalOutputCache(sessionId: String) {
        val stillSubscribed = terminalSubscriptions.values.any { it.contains(sessionId) }
        if (!stillSubscribed) {
            terminalLastOutput.remove(sessionId)
        }
    }

    private fun pushTerminalUpdates() {
        if (terminalSubscriptions.isEmpty()) return
        val sessionIds = terminalSubscriptions.values.flatMap { it.toList() }.toSet()
        if (sessionIds.isEmpty()) return
        sessionIds.forEach { sessionId ->
            val snapshot = runCatching { terminalManager.snapshot(sessionId, terminalStreamLines) }.getOrNull()
            if (snapshot == null) {
                removeSessionFromSubscriptions(sessionId)
                return@forEach
            }
            val previous = terminalLastOutput[sessionId]
            if (previous == snapshot) return@forEach
            terminalLastOutput[sessionId] = snapshot
            broadcastTerminalOutput(sessionId, snapshot)
        }
    }

    private fun removeSessionFromSubscriptions(sessionId: String) {
        terminalSubscriptions.forEach { (connectionId, subscriptions) ->
            subscriptions.remove(sessionId)
            if (subscriptions.isEmpty()) {
                terminalSubscriptions.remove(connectionId, subscriptions)
            }
        }
        terminalLastOutput.remove(sessionId)
    }

    private fun broadcastTerminalOutput(sessionId: String, snapshot: TerminalSessionManager.TerminalSnapshot) {
        terminalSubscriptions.forEach { (connectionId, subscriptions) ->
            if (!subscriptions.contains(sessionId)) return@forEach
            val context = connectionContexts[connectionId]
            if (context?.approved != true) return@forEach
            val wsSession = sessions[connectionId] ?: return@forEach
            sendJson(
                wsSession,
                mapOf(
                    "type" to "terminal_output",
                    "sessionId" to sessionId,
                    "output" to snapshot.output,
                    "cursorOffset" to snapshot.cursorOffset,
                    "styles" to snapshot.styles,
                ),
                connectionId,
            )
        }
    }

    private fun requestApproval(
        connectionId: String,
        session: DefaultWebSocketSession,
        context: ConnectionContext,
    ) {
        if (context.approvalRequested) return
        context.approvalRequested = true
        sendJson(
            session,
            mapOf("type" to "approval_required", "message" to "Device approval required."),
            connectionId,
        )
        ApplicationManager.getApplication().invokeLater {
            val title = "Approve device connection"
            val message = buildString {
                append("Device \"${context.deviceName}\" wants to connect.\n\n")
                append("Device ID: ${context.deviceId}\n")
                append("Address: ${context.remoteAddress}\n\n")
                append("Allow this device to access your IDE?")
            }
            val approved = Messages.showYesNoDialog(
                message,
                title,
                "Approve",
                "Deny",
                Messages.getQuestionIcon(),
            ) == Messages.YES
            if (!approved) {
                sendJson(
                    session,
                    mapOf("type" to "approval_denied", "message" to "Device access denied."),
                    connectionId,
                )
                scope.launch {
                    runCatching {
                        session.close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "Device denied"))
                    }
                }
                return@invokeLater
            }
            authService.approveDevice(context.deviceId)
            approveConnection(connectionId, session, context)
        }
    }

    private fun approveConnection(
        connectionId: String,
        session: DefaultWebSocketSession,
        context: ConnectionContext,
    ) {
        if (context.approved) return
        context.approved = true
        val device = DeviceInfo(
            id = connectionId,
            name = context.deviceName,
            connectedAt = Instant.now(),
            remoteAddress = context.remoteAddress,
        )
        deviceRegistry.addDevice(device)
        sendJson(
            session,
            mapOf("type" to "approval_granted", "deviceId" to context.deviceId),
            connectionId,
        )
        sendRunConfigurations(session, connectionId)
        sendProgressSnapshot(session, connectionId)
    }

    private fun runConfigurationId(settings: RunnerAndConfigurationSettings): String {
        val uniqueId = settings.uniqueID.trim()
        return if (uniqueId.isNotEmpty()) uniqueId else "${settings.type.id}:${settings.name}"
    }

    private fun sendRunConfigurations(session: DefaultWebSocketSession, connectionId: String) {
        val project = ProjectManager.getInstance().openProjects.firstOrNull()
        if (project == null) {
            sendJson(session, mapOf("type" to "run_configurations", "items" to emptyList<Any>()), connectionId)
            return
        }
        val entries = collectRunConfigurations(project)
        sendJson(session, mapOf("type" to "run_configurations", "items" to entries), connectionId)
    }

    private fun collectRunConfigurations(project: Project): List<RunConfigurationEntry> {
        return ApplicationManager.getApplication().runReadAction<List<RunConfigurationEntry>> {
            val runManager = RunManager.getInstance(project)
            runManager.allSettings
                .asSequence()
                .filter { !it.isTemplate }
                .sortedBy { it.name.lowercase() }
                .map { settings ->
                    val id = runConfigurationId(settings)
                    RunConfigurationEntry(
                        id = id,
                        name = settings.name,
                        type = settings.type.displayName,
                        folder = settings.folderName?.takeIf { it.isNotBlank() },
                        temporary = settings.isTemporary,
                        shared = settings.isShared,
                    )
                }
                .toList()
        }
    }

    private fun runConfigurationById(
        id: String,
        session: DefaultWebSocketSession,
        connectionId: String,
    ) {
        val project = ProjectManager.getInstance().openProjects.firstOrNull()
        if (project == null) {
            sendJson(
                session,
                mapOf(
                    "type" to "run_configuration_status",
                    "status" to "failed",
                    "id" to id,
                    "message" to "No open project",
                ),
                connectionId,
            )
            return
        }
        val settings = ApplicationManager.getApplication().runReadAction(
            Computable<RunnerAndConfigurationSettings?> {
                RunManager.getInstance(project).allSettings.firstOrNull { runConfigurationId(it) == id }
            }
        )
        if (settings == null) {
            sendJson(
                session,
                mapOf(
                    "type" to "run_configuration_status",
                    "status" to "failed",
                    "id" to id,
                    "message" to "Run configuration not found",
                ),
                connectionId,
            )
            return
        }
        val executor = DefaultRunExecutor.getRunExecutorInstance()
        ApplicationManager.getApplication().invokeLater {
            try {
                settings.checkSettings(executor)
                ProgramRunnerUtil.executeConfiguration(project, settings, executor)
                sendJson(
                    session,
                    mapOf(
                        "type" to "run_configuration_status",
                        "status" to "started",
                        "id" to id,
                        "name" to settings.name,
                    ),
                    connectionId,
                )
            } catch (error: Exception) {
                sendJson(
                    session,
                    mapOf(
                        "type" to "run_configuration_status",
                        "status" to "failed",
                        "id" to id,
                        "name" to settings.name,
                        "message" to (error.message ?: "Failed to run configuration"),
                    ),
                    connectionId,
                )
            }
        }
    }

    private fun triggerBuild() {
        val project = ProjectManager.getInstance().openProjects.firstOrNull()
        if (project == null) {
            broadcast(mapOf("type" to "build_status", "status" to "failed", "message" to "No open project"))
            return
        }

        broadcast(mapOf("type" to "build_status", "status" to "started"))
        val taskManager = ProjectTaskManager.getInstance(project)
        taskManager.buildAllModules()
            .onSuccess { result ->
                if (result == null) {
                    broadcast(mapOf("type" to "build_status", "status" to "finished"))
                    return@onSuccess
                }
                val (status, message) = when {
                    result.isAborted -> "failed" to "Build aborted"
                    result.hasErrors() -> "failed" to "Build finished with errors"
                    else -> "finished" to null
                }
                val payload = mutableMapOf<String, Any>(
                    "type" to "build_status",
                    "status" to status,
                )
                if (message != null) {
                    payload["message"] = message
                }
                broadcast(payload)
            }
            .onError { error ->
                broadcast(
                    mapOf(
                        "type" to "build_status",
                        "status" to "failed",
                        "message" to (error?.message ?: "Build failed"),
                    )
                )
            }
    }

    private fun broadcast(message: Any) {
        val text = gson.toJson(message)
        scope.launch {
            sessions.forEach { (deviceId, session) ->
                val context = connectionContexts[deviceId]
                if (context?.approved != true) return@forEach
                try {
                    if (logger.isDebugEnabled) {
                        logger.debug("WebSocket send(broadcast): id=$deviceId text=$text")
                    }
                    session.send(text)
                } catch (_: Exception) {
                    // Ignore send failures on closed sessions.
                }
            }
        }
    }

    private fun sendJson(session: DefaultWebSocketSession, payload: Any, deviceId: String? = null) {
        scope.launch {
            try {
                val text = gson.toJson(payload)
                if (logger.isDebugEnabled) {
                    val idLabel = deviceId?.let { " id=$it" } ?: ""
                    logger.debug("WebSocket send:$idLabel text=$text")
                }
                session.send(text)
            } catch (_: Exception) {
                // Ignore send failures on closed sessions.
            }
        }
    }

    private fun sessionInfo(session: TerminalSessionManager.Session): Map<String, Any> {
        return mapOf(
            "id" to session.id,
            "name" to session.name,
            "workingDirectory" to session.workingDirectory,
            "createdAt" to session.createdAt.toString(),
        )
    }
}
