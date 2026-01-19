package com.intellij.tunnel.util

import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections

object NetworkUtils {
    fun resolveHostAddress(): String {
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
}
