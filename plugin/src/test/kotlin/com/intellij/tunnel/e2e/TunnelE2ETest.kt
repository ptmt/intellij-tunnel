package com.intellij.tunnel.e2e

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.tunnel.server.TunnelServerService
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue

class TunnelE2ETest : BasePlatformTestCase() {
    private val gson = Gson()

    override fun runInDispatchThread(): Boolean = false

    fun testTerminalSessionLifecycle() {
        val service = TunnelServerService.getInstance()
        service.ensureStarted()

        val port = service.serverInfo().port
        val webSocket = connectWebSocket(URI("ws://127.0.0.1:$port/ws"))
        val client = webSocket.first
        val socket = webSocket.second

        client.awaitType("hello_ack", 5_000)
        socket.sendText(gson.toJson(mapOf("type" to "hello", "deviceName" to "e2e")), true).join()
        socket.sendText(gson.toJson(mapOf("type" to "list_sessions")), true).join()
        client.awaitType("sessions", 5_000)

        socket.sendText(
            gson.toJson(
                mapOf(
                    "type" to "start_terminal",
                    "name" to "e2e",
                    "workingDirectory" to project.basePath,
                )
            ),
            true,
        ).join()

        val started = client.awaitAnyType(setOf("terminal_started", "terminal_error"), 10_000)
        if (started.get("type")?.asString == "terminal_error") {
            val message = started.get("message")?.asString ?: "Unknown error"
            throw AssertionError("Terminal start failed: $message")
        }
        val sessionId = started.getAsJsonObject("session").get("id").asString

        val marker = "__itunnel_test__"
        socket.sendText(
            gson.toJson(
                mapOf(
                    "type" to "terminal_input",
                    "sessionId" to sessionId,
                    "data" to "echo $marker\n",
                )
            ),
            true,
        ).join()

        val output = waitForOutput(client, socket, sessionId, marker)
            ?: throw AssertionError("Expected terminal output to include marker")
        assertTrue("Expected terminal output to include marker", output.contains(marker))

        socket.sendText(gson.toJson(mapOf("type" to "close_terminal", "sessionId" to sessionId)), true).join()
        client.awaitType("terminal_closed", 5_000, sessionId)
        socket.sendClose(WebSocket.NORMAL_CLOSURE, "done").join()
    }

    private fun connectWebSocket(uri: URI): Pair<WebSocketClient, WebSocket> {
        val client = WebSocketClient(gson)
        val httpClient = HttpClient.newBuilder().build()
        var lastError: Exception? = null
        repeat(40) {
            try {
                val socket = httpClient.newWebSocketBuilder().buildAsync(uri, client).join()
                client.awaitOpen(5_000)
                return client to socket
            } catch (error: Exception) {
                lastError = error
                Thread.sleep(250)
            }
        }
        throw AssertionError("Failed to connect to $uri", lastError)
    }

    private fun waitForOutput(
        client: WebSocketClient,
        socket: WebSocket,
        sessionId: String,
        marker: String,
    ): String? {
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            socket.sendText(
                gson.toJson(mapOf("type" to "terminal_snapshot", "sessionId" to sessionId, "lines" to 200)),
                true,
            ).join()
            val outputMessage = client.pollType("terminal_output", 2_000, sessionId)
            val output = outputMessage?.get("output")?.asString
            if (output != null && output.contains(marker)) {
                return output
            }
            Thread.sleep(250)
        }
        return null
    }

    private class WebSocketClient(private val gson: Gson) : WebSocket.Listener {
        private val openLatch = CountDownLatch(1)
        private val queue = LinkedBlockingQueue<String>()
        private val buffer = StringBuilder()
        private val recentMessages = ArrayDeque<String>()

        fun awaitOpen(timeoutMs: Long) {
            if (!openLatch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                throw AssertionError("WebSocket did not open")
            }
        }

        fun awaitType(
            type: String,
            timeoutMs: Long,
            sessionId: String? = null,
        ): JsonObject {
            return pollType(type, timeoutMs, sessionId)
                ?: throw AssertionError("Timed out waiting for message type: $type. Recent: ${recentSnapshot()}")
        }

        fun pollType(
            type: String,
            timeoutMs: Long,
            sessionId: String? = null,
        ): JsonObject? {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                val message = queue.poll(200, TimeUnit.MILLISECONDS) ?: continue
                val json = gson.fromJson(message, JsonObject::class.java)
                val messageType = json.get("type")?.asString
                if (messageType != type) continue
                if (sessionId != null && json.get("sessionId")?.asString != sessionId) continue
                return json
            }
            return null
        }

        fun awaitAnyType(types: Set<String>, timeoutMs: Long): JsonObject {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                val message = queue.poll(200, TimeUnit.MILLISECONDS) ?: continue
                val json = gson.fromJson(message, JsonObject::class.java)
                val messageType = json.get("type")?.asString ?: continue
                if (messageType in types) {
                    return json
                }
            }
            throw AssertionError("Timed out waiting for message types: $types. Recent: ${recentSnapshot()}")
        }

        override fun onOpen(webSocket: WebSocket) {
            openLatch.countDown()
            webSocket.request(1)
        }

        override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*> {
            buffer.append(data)
            if (last) {
                val message = buffer.toString()
                queue.offer(message)
                recordMessage(message)
                buffer.setLength(0)
            }
            webSocket.request(1)
            return CompletableFuture.completedFuture(null)
        }

        private fun recordMessage(message: String) {
            if (recentMessages.size >= 10) {
                recentMessages.removeFirst()
            }
            recentMessages.addLast(message)
        }

        private fun recentSnapshot(): String {
            return recentMessages.joinToString(separator = " | ")
        }
    }
}
