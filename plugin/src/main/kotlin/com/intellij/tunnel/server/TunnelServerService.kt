package com.intellij.tunnel.server

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.util.Disposer

@Service(Service.Level.APP)
class TunnelServerService : Disposable {
    private val server = TunnelServer()

    init {
        server.start()
    }

    fun ensureStarted() {
        server.start()
    }

    fun serverInfo(): ServerInfo = server.serverInfo()

    fun deviceSnapshot(): List<DeviceInfo> = server.deviceRegistry.snapshot()

    fun addDeviceListener(listener: DeviceListener, parentDisposable: Disposable) {
        server.deviceRegistry.addListener(listener)
        Disposer.register(parentDisposable) { server.deviceRegistry.removeListener(listener) }
    }

    override fun dispose() {
        server.stop()
    }

    companion object {
        fun getInstance(): TunnelServerService = service()
    }
}
