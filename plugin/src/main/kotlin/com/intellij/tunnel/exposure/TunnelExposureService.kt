package com.intellij.tunnel.exposure

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.RoamingType
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.Disposer
import com.intellij.tunnel.server.TunnelServerService
import com.intellij.util.concurrency.AppExecutorUtil
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlin.concurrent.Volatile

enum class ExposureMode(val displayName: String) {
    LOCAL("Local network"),
    CLOUDFLARE("Cloudflare (quick tunnel)"),
    TAILSCALE("Tailscale (tailnet)"),
}

enum class ExposureStatus {
    STOPPED,
    STARTING,
    RUNNING,
    ERROR,
}

data class ExposureState(
    val mode: ExposureMode,
    val status: ExposureStatus,
    val publicUrl: String?,
    val error: String?,
)

interface TunnelExposureListener {
    fun stateChanged(state: ExposureState)
}

class TunnelExposureSettingsState {
    var modeId: String = ExposureMode.LOCAL.name
}

@Service(Service.Level.APP)
@State(
    name = "TunnelExposureSettings",
    storages = [Storage(value = "tunnel-exposure.xml", roamingType = RoamingType.DISABLED)],
)
class TunnelExposureService : PersistentStateComponent<TunnelExposureSettingsState>, Disposable {
    private val logger = Logger.getInstance(TunnelExposureService::class.java)
    private val gson = Gson()
    private val listeners = CopyOnWriteArrayList<TunnelExposureListener>()
    private val executor = AppExecutorUtil.getAppExecutorService()

    @Volatile
    private var settingsState = TunnelExposureSettingsState()

    @Volatile
    private var exposureState = ExposureState(ExposureMode.LOCAL, ExposureStatus.STOPPED, null, null)

    @Volatile
    private var cloudflaredProcess: Process? = null

    override fun getState(): TunnelExposureSettingsState = settingsState

    override fun loadState(state: TunnelExposureSettingsState) {
        settingsState = state
        val mode = ExposureMode.values().firstOrNull { it.name == state.modeId } ?: ExposureMode.LOCAL
        exposureState = ExposureState(mode, ExposureStatus.STOPPED, null, null)
        notifyListeners()
    }

    fun state(): ExposureState = exposureState

    fun setMode(mode: ExposureMode) {
        if (mode == exposureState.mode) return
        stopInternal()
        settingsState.modeId = mode.name
        updateState(ExposureState(mode, ExposureStatus.STOPPED, null, null))
    }

    fun start() {
        when (exposureState.mode) {
            ExposureMode.LOCAL -> return
            ExposureMode.CLOUDFLARE -> startCloudflared()
            ExposureMode.TAILSCALE -> startTailscale()
        }
    }

    fun stop() {
        stopInternal()
        updateState(ExposureState(exposureState.mode, ExposureStatus.STOPPED, null, null))
    }

    fun addListener(listener: TunnelExposureListener, parentDisposable: Disposable) {
        listeners.add(listener)
        listener.stateChanged(exposureState)
        Disposer.register(parentDisposable) { listeners.remove(listener) }
    }

    override fun dispose() {
        stopInternal()
    }

    private fun stopInternal() {
        when (exposureState.mode) {
            ExposureMode.CLOUDFLARE -> stopCloudflared()
            ExposureMode.TAILSCALE -> stopTailscale()
            ExposureMode.LOCAL -> {}
        }
    }

    private fun startCloudflared() {
        if (cloudflaredProcess?.isAlive == true) return
        val port = TunnelServerService.getInstance().serverInfo().port
        val command = listOf(
            "cloudflared",
            "tunnel",
            "--url",
            "http://127.0.0.1:$port",
            "--no-autoupdate",
        )
        updateState(ExposureState(ExposureMode.CLOUDFLARE, ExposureStatus.STARTING, null, null))
        executor.execute {
            try {
                val process = ProcessBuilder(command)
                    .redirectErrorStream(true)
                    .start()
                cloudflaredProcess = process
                val reader = BufferedReader(InputStreamReader(process.inputStream))
                var publicUrl: String? = null
                reader.forEachLine { line ->
                    if (logger.isDebugEnabled) {
                        logger.debug("cloudflared: $line")
                    }
                    if (publicUrl == null) {
                        publicUrl = extractCloudflareUrl(line)
                        if (publicUrl != null) {
                            updateState(
                                ExposureState(
                                    ExposureMode.CLOUDFLARE,
                                    ExposureStatus.RUNNING,
                                    publicUrl,
                                    null,
                                ),
                            )
                        }
                    }
                }
                val exitCode = process.waitFor()
                if (cloudflaredProcess === process) {
                    cloudflaredProcess = null
                }
                if (exposureState.mode != ExposureMode.CLOUDFLARE) return@execute
                if (exitCode == 0) {
                    updateState(ExposureState(ExposureMode.CLOUDFLARE, ExposureStatus.STOPPED, publicUrl, null))
                } else {
                    updateState(
                        ExposureState(
                            ExposureMode.CLOUDFLARE,
                            ExposureStatus.ERROR,
                            publicUrl,
                            "cloudflared exited with code $exitCode",
                        ),
                    )
                }
            } catch (error: Exception) {
                cloudflaredProcess = null
                logger.warn("Failed to start cloudflared", error)
                updateState(
                    ExposureState(
                        ExposureMode.CLOUDFLARE,
                        ExposureStatus.ERROR,
                        null,
                        error.message ?: "cloudflared failed",
                    ),
                )
            }
        }
    }

    private fun stopCloudflared() {
        val process = cloudflaredProcess ?: return
        cloudflaredProcess = null
        process.destroy()
        if (!process.waitFor(3, TimeUnit.SECONDS)) {
            process.destroyForcibly()
        }
    }

    private fun startTailscale() {
        updateState(ExposureState(ExposureMode.TAILSCALE, ExposureStatus.STARTING, null, null))
        executor.execute {
            val port = TunnelServerService.getInstance().serverInfo().port
            val target = "http://127.0.0.1:$port"
            val attempts = listOf(
                listOf("tailscale", "serve", "--https=443", "--set-path=/", target),
                listOf("tailscale", "serve", "https", "/", target),
            )
            val result = attempts.firstNotNullOfOrNull { command ->
                val run = runCommand(command, 10)
                if (run.success) run else null
            }
            if (result == null) {
                updateState(
                    ExposureState(
                        ExposureMode.TAILSCALE,
                        ExposureStatus.ERROR,
                        null,
                        "Failed to configure tailscale serve. Ensure tailscale is installed and running.",
                    ),
                )
                return@execute
            }
            val url = resolveTailscaleUrl()
            if (url == null) {
                updateState(
                    ExposureState(
                        ExposureMode.TAILSCALE,
                        ExposureStatus.ERROR,
                        null,
                        "Tailscale URL not found. Ensure MagicDNS is enabled.",
                    ),
                )
            } else {
                updateState(ExposureState(ExposureMode.TAILSCALE, ExposureStatus.RUNNING, url, null))
            }
        }
    }

    private fun stopTailscale() {
        runCommand(listOf("tailscale", "serve", "--off"), 10)
    }

    private fun resolveTailscaleUrl(): String? {
        val status = runCommand(listOf("tailscale", "status", "--json"), 5)
        if (!status.success) return null
        val json = runCatching { gson.fromJson(status.output, JsonObject::class.java) }.getOrNull()
        val dnsName = json?.getAsJsonObject("Self")?.get("DNSName")?.asString?.trim()
        val host = dnsName?.trimEnd('.')?.trim()
        if (host.isNullOrEmpty()) return null
        return "https://$host/"
    }

    private fun extractCloudflareUrl(line: String): String? {
        val match = Regex("https://[\\w.-]+\\.trycloudflare\\.com").find(line)
            ?: Regex("https://\\S+").find(line)
        return match?.value?.trimEnd('.', ',', ')', ';')
    }

    private fun runCommand(command: List<String>, timeoutSeconds: Long): CommandResult {
        return try {
            val process = ProcessBuilder(command)
                .redirectErrorStream(true)
                .start()
            val output = process.inputStream.bufferedReader().readText().trim()
            val finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)
            if (!finished) {
                process.destroyForcibly()
                CommandResult(false, "Command timed out: ${command.joinToString(" ")}")
            } else if (process.exitValue() == 0) {
                CommandResult(true, output)
            } else {
                CommandResult(false, output)
            }
        } catch (error: Exception) {
            logger.warn("Command failed: ${command.joinToString(" ")}", error)
            CommandResult(false, error.message ?: "command failed")
        }
    }

    private fun updateState(state: ExposureState) {
        exposureState = state
        notifyListeners()
    }

    private fun notifyListeners() {
        listeners.forEach { it.stateChanged(exposureState) }
    }

    private data class CommandResult(val success: Boolean, val output: String)

    companion object {
        fun getInstance(): TunnelExposureService = service()
    }
}
