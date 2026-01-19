package com.intellij.tunnel.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.tunnel.server.DeviceInfo
import com.intellij.tunnel.server.DeviceListener
import com.intellij.tunnel.server.TunnelServerService
import com.intellij.tunnel.util.QrCodeRenderer
import com.intellij.ui.ScrollPaneFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBPanel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import javax.swing.DefaultListModel
import javax.swing.ImageIcon
import javax.swing.JComponent
import javax.swing.BoxLayout

class TunnelToolWindowPanel : Disposable {
    private val serverService = TunnelServerService.getInstance()
    private val listModel = DefaultListModel<String>()
    private val deviceList = JBList(listModel)
    val component: JComponent

    init {
        val info = serverService.serverInfo()
        val qrImage = QrCodeRenderer.render(info.httpUrl, 220)

        val header = JBPanel<JBPanel<*>>()
        header.layout = BoxLayout(header, BoxLayout.Y_AXIS)
        header.border = JBUI.Borders.empty(12)

        val title = JBLabel("IntelliJ Tunnel")
        title.font = title.font.deriveFont(title.font.size2D + 2f)
        val subtitle = JBLabel("Scan to connect")
        val qrLabel = JBLabel(ImageIcon(qrImage))
        val urlLabel = JBLabel(info.httpUrl)
        urlLabel.border = JBUI.Borders.emptyTop(6)

        header.add(title)
        header.add(subtitle)
        header.add(qrLabel)
        header.add(urlLabel)
        header.add(JBLabel("Connected devices"))

        deviceList.emptyText.text = "No devices connected"
        val scrollPane = ScrollPaneFactory.createScrollPane(deviceList, true)
        scrollPane.border = JBUI.Borders.empty(0, 12, 12, 12)

        val root = JBPanel<JBPanel<*>>(BorderLayout())
        root.add(header, BorderLayout.NORTH)
        root.add(scrollPane, BorderLayout.CENTER)

        component = root

        serverService.addDeviceListener(object : DeviceListener {
            override fun devicesChanged(devices: List<DeviceInfo>) {
                ApplicationManager.getApplication().invokeLater {
                    listModel.removeAllElements()
                    devices.forEach { device ->
                        listModel.addElement("${device.name} - ${device.remoteAddress}")
                    }
                }
            }
        }, this)
    }

    override fun dispose() {
        // Listeners are detached by the service.
    }
}
