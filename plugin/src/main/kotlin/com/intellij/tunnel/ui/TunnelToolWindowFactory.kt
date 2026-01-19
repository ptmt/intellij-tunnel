package com.intellij.tunnel.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class TunnelToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = TunnelToolWindowPanel()
        val content = ContentFactory.getInstance().createContent(panel.component, "", false)
        Disposer.register(content, panel)
        toolWindow.contentManager.addContent(content)
    }
}
