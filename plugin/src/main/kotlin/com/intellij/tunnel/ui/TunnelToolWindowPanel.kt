package com.intellij.tunnel.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.ui.ComboBox
import com.intellij.tunnel.auth.TunnelAuthService
import com.intellij.tunnel.exposure.ExposureMode
import com.intellij.tunnel.exposure.ExposureState
import com.intellij.tunnel.exposure.ExposureStatus
import com.intellij.tunnel.exposure.TunnelExposureListener
import com.intellij.tunnel.exposure.TunnelExposureService
import com.intellij.tunnel.server.DeviceInfo
import com.intellij.tunnel.server.DeviceListener
import com.intellij.tunnel.server.TunnelServerService
import com.intellij.tunnel.util.QrCodeRenderer
import com.intellij.ui.ScrollPaneFactory
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBPanel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.ImageIcon
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.SwingConstants
import java.awt.datatransfer.StringSelection

class TunnelToolWindowPanel : Disposable {
    private val serverService = TunnelServerService.getInstance()
    private val exposureService = TunnelExposureService.getInstance()
    private val authService = TunnelAuthService.getInstance()
    private val listModel = DefaultListModel<String>()
    private val deviceList = JBList(listModel)
    private val urlLabel = JBLabel("")
    private val qrLabel = JBLabel()
    private val tokenCopyButton = JButton("Copy Token")
    private val exposureStatusLabel = JBLabel("")
    private val exposureButton = JButton("Start")
    private val exposureBox = ComboBox(ExposureMode.values())
    private val connectionPanel = JBPanel<JBPanel<*>>()
    private var lastUrl: String? = null
    private var showSetup = true
    val component: JComponent

    init {
        val header = JBPanel<JBPanel<*>>()
        header.layout = BoxLayout(header, BoxLayout.Y_AXIS)
        header.border = JBUI.Borders.empty(12)

        val subtitle = JBLabel("Scan to connect")
        subtitle.alignmentX = JComponent.CENTER_ALIGNMENT
        subtitle.horizontalAlignment = SwingConstants.CENTER
        val qrImage = QrCodeRenderer.render(serverService.serverInfo().httpUrl, 220)
        qrLabel.icon = ImageIcon(qrImage)
        qrLabel.alignmentX = JComponent.CENTER_ALIGNMENT
        qrLabel.horizontalAlignment = SwingConstants.CENTER
        urlLabel.text = serverService.serverInfo().httpUrl
        urlLabel.border = JBUI.Borders.emptyTop(6)
        urlLabel.alignmentX = JComponent.CENTER_ALIGNMENT
        urlLabel.horizontalAlignment = SwingConstants.CENTER
        tokenCopyButton.alignmentX = JComponent.CENTER_ALIGNMENT
        tokenCopyButton.addActionListener {
            CopyPasteManager.getInstance().setContents(StringSelection(authService.token()))
            tokenCopyButton.text = "Copied"
        }

        exposureBox.renderer = SimpleListCellRenderer.create("") { it.displayName }
        exposureBox.selectedItem = exposureService.state().mode
        exposureBox.addActionListener {
            val mode = exposureBox.selectedItem as? ExposureMode ?: ExposureMode.LOCAL
            exposureService.setMode(mode)
        }
        exposureButton.addActionListener {
            val state = exposureService.state()
            if (state.status == ExposureStatus.RUNNING) {
                exposureService.stop()
            } else {
                exposureService.start()
            }
        }

        val exposureRow = JBPanel<JBPanel<*>>()
        exposureRow.layout = BoxLayout(exposureRow, BoxLayout.X_AXIS)
        exposureRow.border = JBUI.Borders.emptyTop(8)
        exposureRow.alignmentX = JComponent.CENTER_ALIGNMENT
        exposureRow.add(Box.createHorizontalGlue())
        exposureRow.add(JBLabel("Exposure"))
        exposureRow.add(Box.createHorizontalStrut(8))
        exposureRow.add(exposureBox)
        exposureRow.add(Box.createHorizontalStrut(8))
        exposureRow.add(exposureButton)
        exposureRow.add(Box.createHorizontalGlue())

        connectionPanel.layout = BoxLayout(connectionPanel, BoxLayout.Y_AXIS)
        connectionPanel.alignmentX = JComponent.CENTER_ALIGNMENT
        connectionPanel.add(subtitle)
        connectionPanel.add(qrLabel)
        connectionPanel.add(urlLabel)
        connectionPanel.add(Box.createVerticalStrut(4))
        connectionPanel.add(tokenCopyButton)
        connectionPanel.add(exposureRow)
        exposureStatusLabel.alignmentX = JComponent.CENTER_ALIGNMENT
        exposureStatusLabel.horizontalAlignment = SwingConstants.CENTER
        connectionPanel.add(exposureStatusLabel)

        val devicesHeader = JBPanel<JBPanel<*>>()
        devicesHeader.layout = BoxLayout(devicesHeader, BoxLayout.X_AXIS)
        devicesHeader.border = JBUI.Borders.emptyTop(8)
        devicesHeader.add(JBLabel("Connected devices"))

        header.add(connectionPanel)
        header.add(devicesHeader)

        deviceList.emptyText.text = "No devices connected"
        val scrollPane = ScrollPaneFactory.createScrollPane(deviceList, true)
        scrollPane.border = JBUI.Borders.empty(0, 12, 12, 12)

        val root = JBPanel<JBPanel<*>>(BorderLayout())
        root.add(header, BorderLayout.NORTH)
        root.add(scrollPane, BorderLayout.CENTER)

        component = root

        updateSetupVisibility()
        updateExposureUi(exposureService.state())
        exposureService.addListener(object : TunnelExposureListener {
            override fun stateChanged(state: ExposureState) {
                ApplicationManager.getApplication().invokeLater {
                    updateExposureUi(state)
                }
            }
        }, this)

        serverService.addDeviceListener(object : DeviceListener {
            override fun devicesChanged(devices: List<DeviceInfo>) {
                ApplicationManager.getApplication().invokeLater {
                    listModel.removeAllElements()
                    devices.forEach { device ->
                        listModel.addElement("${device.name} - ${device.remoteAddress}")
                    }
                    showSetup = devices.isEmpty()
                    updateSetupVisibility()
                }
            }
        }, this)
    }

    override fun dispose() {
        // Listeners are detached by the service.
    }

    private fun updateExposureUi(state: ExposureState) {
        val baseUrl = serverService.serverInfo().httpUrl
        val url = state.publicUrl ?: baseUrl
        if (url != lastUrl) {
            qrLabel.icon = ImageIcon(QrCodeRenderer.render(url, 220))
            urlLabel.text = url
            lastUrl = url
        }
        exposureBox.selectedItem = state.mode
        when (state.mode) {
            ExposureMode.LOCAL -> {
                exposureStatusLabel.text = "Local network only"
                exposureButton.isEnabled = false
                exposureButton.text = "Start"
            }
            ExposureMode.CLOUDFLARE -> {
                exposureStatusLabel.text = formatStatus("Cloudflare", state)
                exposureButton.isEnabled = state.status != ExposureStatus.STARTING
                exposureButton.text = if (state.status == ExposureStatus.RUNNING) "Stop" else "Start"
            }
            ExposureMode.TAILSCALE -> {
                exposureStatusLabel.text = formatStatus("Tailscale", state)
                exposureButton.isEnabled = state.status != ExposureStatus.STARTING
                exposureButton.text = if (state.status == ExposureStatus.RUNNING) "Stop" else "Start"
            }
        }
    }

    private fun updateSetupVisibility() {
        connectionPanel.isVisible = showSetup
        connectionPanel.revalidate()
        connectionPanel.repaint()
    }

    private fun formatStatus(label: String, state: ExposureState): String {
        return when (state.status) {
            ExposureStatus.STARTING -> "$label tunnel starting..."
            ExposureStatus.RUNNING -> "$label tunnel running"
            ExposureStatus.ERROR -> "$label error: ${state.error ?: "unknown"}"
            ExposureStatus.STOPPED -> "$label tunnel stopped"
        }
    }
}
