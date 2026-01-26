package com.intellij.tunnel.ui

import com.intellij.icons.AllIcons
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
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.datatransfer.StringSelection
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.time.Duration
import java.time.Instant
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.ImageIcon
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JList
import javax.swing.JMenuItem
import javax.swing.JPopupMenu
import javax.swing.ListCellRenderer
import javax.swing.ListSelectionModel
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.Timer

class TunnelToolWindowPanel : Disposable {
    private val serverService = TunnelServerService.getInstance()
    private val exposureService = TunnelExposureService.getInstance()
    private val authService = TunnelAuthService.getInstance()
    private val listModel = DefaultListModel<DeviceInfo>()
    private val deviceList = JBList(listModel)
    private val urlLabel = JBLabel("")
    private val qrLabel = JBLabel()
    private val tokenCopyButton = JButton("Copy Token")
    private val exposureStatusLabel = JBLabel("")
    private val exposureButton = JButton("Start")
    private val exposureBox = ComboBox(ExposureMode.values())
    private val pairDeviceButton = JButton("Pair another device")
    private val connectionPanel = JBPanel<JBPanel<*>>()
    private val deviceMenuHotspot = JBUI.scale(28)
    private val deviceUptimeTimer = Timer(1000) { deviceList.repaint() }
    private val clientIcon = AppleIcon(JBUI.scale(16))
    private var lastUrl: String? = null
    private var pairingPanelVisible = false
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
        devicesHeader.add(Box.createHorizontalGlue())
        pairDeviceButton.icon = AllIcons.General.Add
        pairDeviceButton.isFocusable = false
        pairDeviceButton.addActionListener { togglePairingPanel() }
        devicesHeader.add(pairDeviceButton)

        header.add(connectionPanel)
        header.add(devicesHeader)

        deviceList.emptyText.text = "No devices connected"
        deviceList.cellRenderer = DeviceCellRenderer()
        deviceList.selectionMode = ListSelectionModel.SINGLE_SELECTION
        deviceList.addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) {
                maybeShowDeviceMenu(e)
            }

            override fun mouseReleased(e: MouseEvent) {
                maybeShowDeviceMenu(e)
            }

            override fun mouseClicked(e: MouseEvent) {
                maybeShowDeviceMenu(e, allowLeftClick = true)
            }
        })
        val scrollPane = ScrollPaneFactory.createScrollPane(deviceList, true)
        scrollPane.border = JBUI.Borders.empty(0, 12, 12, 12)

        val root = JBPanel<JBPanel<*>>(BorderLayout())
        root.add(header, BorderLayout.NORTH)
        root.add(scrollPane, BorderLayout.CENTER)

        component = root

        deviceUptimeTimer.start()

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
                        listModel.addElement(device)
                    }
                    if (devices.isEmpty()) {
                        pairingPanelVisible = false
                    }
                    updateSetupVisibility(devices.isNotEmpty())
                }
            }
        }, this)
    }

    override fun dispose() {
        deviceUptimeTimer.stop()
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
        updateSetupVisibility(listModel.size > 0)
    }

    private fun updateSetupVisibility(hasDevices: Boolean) {
        val showSetup = !hasDevices || pairingPanelVisible
        connectionPanel.isVisible = showSetup
        connectionPanel.revalidate()
        connectionPanel.repaint()
        pairDeviceButton.isVisible = hasDevices
        if (hasDevices) {
            if (pairingPanelVisible) {
                pairDeviceButton.icon = AllIcons.General.Remove
                pairDeviceButton.text = "Hide pairing"
                pairDeviceButton.toolTipText = "Hide pairing info"
            } else {
                pairDeviceButton.icon = AllIcons.General.Add
                pairDeviceButton.text = "Pair another device"
                pairDeviceButton.toolTipText = "Show pairing info"
            }
        }
    }

    private fun togglePairingPanel() {
        pairingPanelVisible = !pairingPanelVisible
        updateSetupVisibility()
    }

    private fun maybeShowDeviceMenu(event: MouseEvent, allowLeftClick: Boolean = false) {
        val index = deviceList.locationToIndex(event.point)
        if (index < 0) return
        val bounds = deviceList.getCellBounds(index, index) ?: return
        if (!bounds.contains(event.point)) return
        val device = listModel.getElementAt(index)
        val isMenuClick = event.x >= bounds.x + bounds.width - deviceMenuHotspot
        if (event.isPopupTrigger || (allowLeftClick && SwingUtilities.isLeftMouseButton(event) && isMenuClick)) {
            deviceList.selectedIndex = index
            showDeviceMenu(device, event.x, event.y)
        }
    }

    private fun showDeviceMenu(device: DeviceInfo, x: Int, y: Int) {
        val menu = JPopupMenu()
        val pairItem = JMenuItem("Pair another device")
        pairItem.addActionListener {
            pairingPanelVisible = true
            updateSetupVisibility()
        }
        menu.add(pairItem)
        menu.addSeparator()
        val disconnectItem = JMenuItem("Disconnect")
        disconnectItem.addActionListener { serverService.disconnectDevice(device.id) }
        menu.add(disconnectItem)
        menu.show(deviceList, x, y)
    }

    private fun formatUptime(connectedAt: Instant): String {
        val duration = Duration.between(connectedAt, Instant.now()).coerceAtLeast(Duration.ZERO)
        val totalSeconds = duration.seconds
        val days = totalSeconds / 86_400
        val hours = (totalSeconds % 86_400) / 3_600
        val minutes = (totalSeconds % 3_600) / 60
        val seconds = totalSeconds % 60
        return when {
            days > 0 -> "${days}d ${hours}h"
            hours > 0 -> "${hours}h ${minutes}m"
            minutes > 0 -> "${minutes}m ${seconds}s"
            else -> "${seconds}s"
        }
    }

    private inner class DeviceCellRenderer : ListCellRenderer<DeviceInfo> {
        private val panel = JBPanel<JBPanel<*>>(BorderLayout())
        private val iconLabel = JBLabel(clientIcon)
        private val nameLabel = JBLabel()
        private val detailsLabel = JBLabel()
        private val uptimeLabel = JBLabel()
        private val menuLabel = JBLabel(AllIcons.Actions.More)
        private val textPanel = JBPanel<JBPanel<*>>()
        private val rightPanel = JBPanel<JBPanel<*>>()

        init {
            panel.border = JBUI.Borders.empty(6, 8)
            panel.isOpaque = true

            iconLabel.border = JBUI.Borders.emptyRight(8)

            textPanel.layout = BoxLayout(textPanel, BoxLayout.Y_AXIS)
            textPanel.isOpaque = false
            rightPanel.layout = BoxLayout(rightPanel, BoxLayout.X_AXIS)
            rightPanel.isOpaque = false

            val baseFont = nameLabel.font
            nameLabel.font = baseFont.deriveFont(Font.BOLD)
            detailsLabel.font = baseFont.deriveFont(Font.PLAIN, baseFont.size2D - 1f)
            uptimeLabel.font = baseFont.deriveFont(Font.PLAIN, baseFont.size2D - 1f)

            rightPanel.add(uptimeLabel)
            rightPanel.add(Box.createHorizontalStrut(8))
            rightPanel.add(menuLabel)

            textPanel.add(nameLabel)
            textPanel.add(detailsLabel)

            panel.add(iconLabel, BorderLayout.WEST)
            panel.add(textPanel, BorderLayout.CENTER)
            panel.add(rightPanel, BorderLayout.EAST)
        }

        override fun getListCellRendererComponent(
            list: JList<out DeviceInfo>,
            value: DeviceInfo?,
            index: Int,
            isSelected: Boolean,
            cellHasFocus: Boolean,
        ): Component {
            if (value == null) return panel
            nameLabel.text = value.name.ifBlank { "Unknown device" }
            detailsLabel.text = value.remoteAddress
            uptimeLabel.text = formatUptime(value.connectedAt)

            val background = if (isSelected) list.selectionBackground else list.background
            val foreground = if (isSelected) list.selectionForeground else list.foreground
            val secondary = if (isSelected) foreground else UIUtil.getContextHelpForeground()

            panel.background = background
            nameLabel.foreground = foreground
            detailsLabel.foreground = secondary
            uptimeLabel.foreground = secondary

            return panel
        }
    }

    private class AppleIcon(private val size: Int) : javax.swing.Icon {
        override fun getIconWidth(): Int = size

        override fun getIconHeight(): Int = size

        override fun paintIcon(c: Component?, g: Graphics, x: Int, y: Int) {
            val g2 = g.create() as Graphics2D
            try {
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                g2.color = UIUtil.getLabelForeground()
                val bodySize = size - JBUI.scale(4)
                val bodyX = x + (size - bodySize) / 2
                val bodyY = y + JBUI.scale(4)
                g2.fillOval(bodyX, bodyY, bodySize, bodySize)
                val leafWidth = JBUI.scale(6)
                val leafHeight = JBUI.scale(3)
                val leafX = x + (size - leafWidth) / 2 + JBUI.scale(2)
                val leafY = y + JBUI.scale(1)
                g2.fillOval(leafX, leafY, leafWidth, leafHeight)
                val stemWidth = JBUI.scale(2)
                val stemHeight = JBUI.scale(3)
                val stemX = x + (size - stemWidth) / 2
                val stemY = y + JBUI.scale(2)
                g2.fillRect(stemX, stemY, stemWidth, stemHeight)
            } finally {
                g2.dispose()
            }
        }
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
