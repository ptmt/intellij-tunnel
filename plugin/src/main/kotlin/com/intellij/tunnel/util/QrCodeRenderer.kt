package com.intellij.tunnel.util

import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import com.google.zxing.client.j2se.MatrixToImageWriter
import java.awt.image.BufferedImage

object QrCodeRenderer {
    fun render(data: String, size: Int): BufferedImage {
        val matrix = MultiFormatWriter().encode(data, BarcodeFormat.QR_CODE, size, size)
        return MatrixToImageWriter.toBufferedImage(matrix)
    }
}
