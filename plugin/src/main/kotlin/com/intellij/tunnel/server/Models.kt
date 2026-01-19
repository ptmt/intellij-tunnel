package com.intellij.tunnel.server

import java.time.Instant

data class ServerInfo(
    val httpUrl: String,
    val wsUrl: String,
    val port: Int,
    val hostAddress: String,
    val pairingToken: String,
)

data class DeviceInfo(
    val id: String,
    val name: String,
    val connectedAt: Instant,
    val remoteAddress: String,
)

interface DeviceListener {
    fun devicesChanged(devices: List<DeviceInfo>)
}
