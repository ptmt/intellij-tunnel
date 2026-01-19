package com.intellij.tunnel.server

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

class DeviceRegistry {
    private val devices = ConcurrentHashMap<String, DeviceInfo>()
    private val listeners = CopyOnWriteArrayList<DeviceListener>()

    fun snapshot(): List<DeviceInfo> = devices.values.sortedBy { it.connectedAt }

    fun addDevice(device: DeviceInfo) {
        devices[device.id] = device
        notifyListeners()
    }

    fun updateDeviceName(deviceId: String, name: String) {
        val existing = devices[deviceId] ?: return
        devices[deviceId] = existing.copy(name = name)
        notifyListeners()
    }

    fun removeDevice(deviceId: String) {
        devices.remove(deviceId)
        notifyListeners()
    }

    fun addListener(listener: DeviceListener) {
        listeners.add(listener)
        listener.devicesChanged(snapshot())
    }

    fun removeListener(listener: DeviceListener) {
        listeners.remove(listener)
    }

    private fun notifyListeners() {
        val snapshot = snapshot()
        listeners.forEach { it.devicesChanged(snapshot) }
    }
}
