package com.intellij.tunnel.util

import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.util.Collections

object NetworkUtils {
    fun resolveHostAddress(): String {
        val hostName = resolveHostName()
        if (hostName != null) {
            return hostName
        }
        val interfaces = NetworkInterface.getNetworkInterfaces() ?: return "127.0.0.1"
        val candidates = Collections.list(interfaces).flatMap { iface ->
            if (!iface.isUp || iface.isLoopback) {
                emptyList()
            } else {
                Collections.list(iface.inetAddresses)
            }
        }
        val ipv4 = candidates.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
        return ipv4?.hostAddress ?: "127.0.0.1"
    }

    private fun resolveHostName(): String? {
        val local = runCatching { InetAddress.getLocalHost() }.getOrNull()
        val candidates = sequenceOf(
            local?.canonicalHostName,
            local?.hostName,
            System.getenv("HOSTNAME"),
            System.getenv("COMPUTERNAME"),
        )
        candidates.firstOrNull { isUsableHostName(it) }?.let { return it.trim() }

        val interfaces = NetworkInterface.getNetworkInterfaces() ?: return null
        for (iface in Collections.list(interfaces)) {
            if (!iface.isUp || iface.isLoopback) continue
            for (address in Collections.list(iface.inetAddresses)) {
                if (address !is Inet4Address || address.isLoopbackAddress) continue
                val hostName = address.canonicalHostName
                if (isUsableHostName(hostName)) {
                    return hostName.trim()
                }
            }
        }
        return null
    }

    private fun isUsableHostName(value: String?): Boolean {
        val trimmed = value?.trim().orEmpty()
        if (trimmed.isEmpty()) return false
        val lower = trimmed.lowercase()
        if (lower == "localhost" || lower == "localhost.localdomain") return false
        if (isIpLiteral(trimmed)) return false
        return true
    }

    private fun isIpLiteral(value: String): Boolean {
        if (value.contains(':')) return true
        val parts = value.split('.')
        if (parts.size != 4) return false
        return parts.all { part ->
            val num = part.toIntOrNull() ?: return@all false
            num in 0..255
        }
    }
}
