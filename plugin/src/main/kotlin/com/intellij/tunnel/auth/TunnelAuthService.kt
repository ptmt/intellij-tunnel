package com.intellij.tunnel.auth

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.RoamingType
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import java.security.SecureRandom
import java.util.Locale

data class TunnelAuthState(
    var token: String = "",
    var approvedDeviceIds: MutableList<String> = mutableListOf(),
)

@Service(Service.Level.APP)
@State(
    name = "TunnelAuthState",
    storages = [Storage(value = "tunnel-auth.xml", roamingType = RoamingType.DISABLED)],
)
class TunnelAuthService : PersistentStateComponent<TunnelAuthState> {
    private var state = TunnelAuthState()

    override fun getState(): TunnelAuthState = state

    override fun loadState(state: TunnelAuthState) {
        this.state = state
        ensureToken()
    }

    fun token(): String {
        ensureToken()
        return state.token
    }

    fun regenerateToken(): String {
        state.token = generateToken()
        state.approvedDeviceIds.clear()
        return state.token
    }

    fun isTokenValid(value: String?): Boolean {
        val expected = token()
        return !value.isNullOrBlank() && value == expected
    }

    fun isDeviceApproved(deviceId: String): Boolean {
        return state.approvedDeviceIds.contains(deviceId)
    }

    fun approveDevice(deviceId: String) {
        if (!state.approvedDeviceIds.contains(deviceId)) {
            state.approvedDeviceIds.add(deviceId)
        }
    }

    private fun ensureToken() {
        if (state.token.isBlank()) {
            state.token = generateToken()
        }
    }

    private fun generateToken(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(Locale.US, it) }
    }

    companion object {
        fun getInstance(): TunnelAuthService = service()
    }
}
