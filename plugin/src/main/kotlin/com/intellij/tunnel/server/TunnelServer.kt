package com.intellij.tunnel.server

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.project.ProjectManager
import com.intellij.task.ProjectTaskManager
import com.intellij.tunnel.auth.TunnelAuthService
import com.intellij.tunnel.terminal.TerminalSessionManager
import com.intellij.tunnel.util.NetworkUtils
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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

    val deviceRegistry = DeviceRegistry()

    private data class ConnectionContext(
        val connectionId: String,
        val remoteAddress: String,
        var deviceId: String,
        var deviceName: String,
        var approved: Boolean,
        var approvalRequested: Boolean,
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
        logger.info("Tunnel server started at ${serverInfo().wsUrl}")
    }

    fun stop() {
        logger.info("Tunnel server stopping")
        engine?.stop(1000, 2000)
        engine = null
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
                    close()
                }
            }
        }
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
                    val output = terminalManager.snapshot(sessionId, maxLines)
                    if (output == null) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Session not found."), connectionId)
                    } else {
                        sendJson(
                            session,
                            mapOf("type" to "terminal_output", "sessionId" to sessionId, "output" to output),
                            connectionId,
                        )
                    }
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
            .onSuccess { broadcast(mapOf("type" to "build_status", "status" to "finished")) }
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
