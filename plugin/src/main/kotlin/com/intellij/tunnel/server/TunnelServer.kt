package com.intellij.tunnel.server

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.ProjectManager
import com.intellij.task.ProjectTaskManager
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
    private var port = 8765
    private val hostAddress = NetworkUtils.resolveHostAddress()
    private var engine: ApplicationEngine? = null
    private val terminalManager = TerminalSessionManager()

    val deviceRegistry = DeviceRegistry()

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
        return ServerInfo(httpUrl = httpUrl, wsUrl = wsUrl, port = port, hostAddress = hostAddress)
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
                val deviceId = UUID.randomUUID().toString()
                val remoteAddress = call.request.origin.remoteHost
                val device = DeviceInfo(
                    id = deviceId,
                    name = "Unknown device",
                    connectedAt = Instant.now(),
                    remoteAddress = remoteAddress,
                )
                sessions[deviceId] = this
                deviceRegistry.addDevice(device)
                logger.info("WebSocket connected: id=$deviceId remote=$remoteAddress")
                sendJson(this, mapOf("type" to "hello_ack", "deviceId" to deviceId))
                try {
                    for (frame in incoming) {
                        if (frame is Frame.Text) {
                            handleMessage(frame.readText(), deviceId, this)
                        }
                    }
                } catch (error: Exception) {
                    logger.info("WebSocket failure for id=$deviceId", error)
                } finally {
                    val reason = runCatching { closeReason.await() }.getOrNull()
                    logger.info("WebSocket disconnected: id=$deviceId reason=${reason ?: "unknown"}")
                    sessions.remove(deviceId)
                    deviceRegistry.removeDevice(deviceId)
                    close()
                }
            }
        }
    }

    private fun handleMessage(text: String, deviceId: String, session: DefaultWebSocketSession) {
        val payload = runCatching { gson.fromJson(text, JsonObject::class.java) }.getOrNull()
            ?: run {
                logger.warn("Invalid JSON from id=$deviceId (${text.length} chars)")
                return
            }
        val type = payload.get("type")?.asString ?: return
        logger.info("WebSocket message from id=$deviceId type=$type")
        try {
            when (type) {
                "hello" -> {
                    val name = payload.get("deviceName")?.asString?.trim().orEmpty()
                    if (name.isNotEmpty()) {
                        deviceRegistry.updateDeviceName(deviceId, name)
                    }
                }
                "list_sessions" -> {
                    val sessions = terminalManager.listSessions().map { sessionInfo(it) }
                    sendJson(session, mapOf("type" to "sessions", "items" to sessions))
                }
                "start_terminal" -> {
                    val name = payload.get("name")?.asString
                    val workingDirectory = payload.get("workingDirectory")?.asString
                    val created = runCatching { terminalManager.createSession(name, workingDirectory) }
                        .getOrElse { error ->
                            logger.warn(
                                "Failed to start terminal for id=$deviceId name=$name dir=$workingDirectory",
                                error,
                            )
                            sendJson(
                                session,
                                mapOf(
                                    "type" to "terminal_error",
                                "message" to (error.message ?: error::class.java.simpleName),
                            ),
                        )
                        return
                    }
                if (created == null) {
                    sendJson(session, mapOf("type" to "terminal_error", "message" to "No project is open."))
                } else {
                    sendJson(session, mapOf("type" to "terminal_started", "session" to sessionInfo(created)))
                }
                }
                "terminal_input" -> {
                    val sessionId = payload.get("sessionId")?.asString?.trim().orEmpty()
                    val data = payload.get("data")?.asString ?: ""
                    if (sessionId.isEmpty() || data.isEmpty()) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Missing sessionId or data."))
                        return
                    }
                    val ok = terminalManager.sendInput(sessionId, data)
                    if (!ok) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Session not found."))
                    }
                }
                "terminal_snapshot" -> {
                    val sessionId = payload.get("sessionId")?.asString?.trim().orEmpty()
                    val maxLines = payload.get("lines")?.asInt ?: 200
                    if (sessionId.isEmpty()) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Missing sessionId."))
                        return
                    }
                    val output = terminalManager.snapshot(sessionId, maxLines)
                    if (output == null) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Session not found."))
                    } else {
                        sendJson(session, mapOf("type" to "terminal_output", "sessionId" to sessionId, "output" to output))
                    }
                }
                "close_terminal" -> {
                    val sessionId = payload.get("sessionId")?.asString?.trim().orEmpty()
                    if (sessionId.isEmpty()) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Missing sessionId."))
                        return
                    }
                    val closed = terminalManager.closeSession(sessionId)
                    if (!closed) {
                        sendJson(session, mapOf("type" to "terminal_error", "message" to "Session not found."))
                    } else {
                        sendJson(session, mapOf("type" to "terminal_closed", "sessionId" to sessionId))
                    }
                }
                "build_project" -> {
                    triggerBuild()
                }
                else -> {
                    sendJson(session, mapOf("type" to "error", "message" to "Unknown message type: $type"))
                }
            }
        } catch (error: Exception) {
            val message = error.message?.takeIf { it.isNotBlank() } ?: "unknown error"
            logger.warn("Failed to handle message type '$type' from $deviceId", error)
            sendJson(session, mapOf("type" to "error", "message" to "Failed to handle '$type': $message"))
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
            sessions.values.forEach { session ->
                try {
                    session.send(text)
                } catch (_: Exception) {
                    // Ignore send failures on closed sessions.
                }
            }
        }
    }

    private fun sendJson(session: DefaultWebSocketSession, payload: Any) {
        scope.launch {
            try {
                session.send(gson.toJson(payload))
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
