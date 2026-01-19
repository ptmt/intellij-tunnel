package com.intellij.tunnel.startup

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity
import com.intellij.tunnel.server.TunnelServerService

class TunnelStartupActivity : StartupActivity.DumbAware {
    override fun runActivity(project: Project) {
        TunnelServerService.getInstance().ensureStarted()
    }
}
