package com.uvlink.tv

import kotlin.math.min
import kotlin.math.roundToInt

/** How the PC cast and an iPhone share the screen when both are showing. */
enum class DualLayout(val label: String) {
    SIDE_BY_SIDE("Side by side"),
    PICTURE_IN_PICTURE("Picture in picture"),
    PHONE_FULL("iPhone full screen");

    fun next(): DualLayout = entries[(ordinal + 1) % entries.size]

    fun previous(): DualLayout = entries[(ordinal + entries.size - 1) % entries.size]
}

/** A rectangle in screen pixels. */
data class Box(val left: Int, val top: Int, val width: Int, val height: Int)

/** Where each picture goes; null means it isn't on screen. */
data class DualPlacement(val pc: Box, val phone: Box?)

/** Pure layout math (no Android classes), so it's tested on the JVM. */
object DualViewLayout {
    /**
     * @param phoneAspect the iPhone video's width / height (portrait < 1); 0 if not known yet.
     * @param margin gap between the picture-in-picture window and the screen edge.
     */
    fun place(
        layout: DualLayout,
        screenWidth: Int,
        screenHeight: Int,
        phoneAspect: Float,
        pcCasting: Boolean,
        phoneMirroring: Boolean,
        margin: Int
    ): DualPlacement {
        val full = Box(0, 0, screenWidth, screenHeight)
        if (!phoneMirroring) return DualPlacement(pc = full, phone = null)
        // Nothing to share the screen with, or the viewer asked for it: the iPhone fills it.
        if (!pcCasting || layout == DualLayout.PHONE_FULL) return DualPlacement(pc = full, phone = full)

        val aspect = if (phoneAspect > 0f) phoneAspect else 16f / 9f
        return when (layout) {
            DualLayout.SIDE_BY_SIDE -> {
                // A portrait phone takes only the width it needs at full height (at most 45%);
                // a landscape one gets half the screen.
                val phoneWidth = if (aspect < 1f) {
                    min((screenHeight * aspect).roundToInt(), (screenWidth * 0.45f).roundToInt())
                } else {
                    screenWidth / 2
                }
                DualPlacement(
                    pc = Box(0, 0, screenWidth - phoneWidth, screenHeight),
                    phone = Box(screenWidth - phoneWidth, 0, phoneWidth, screenHeight)
                )
            }
            DualLayout.PICTURE_IN_PICTURE -> {
                val width: Int
                val height: Int
                if (aspect < 1f) {
                    height = (screenHeight * 0.42f).roundToInt()
                    width = (height * aspect).roundToInt()
                } else {
                    width = (screenWidth * 0.3f).roundToInt()
                    height = (width / aspect).roundToInt()
                }
                DualPlacement(pc = full, phone = Box(screenWidth - width - margin, screenHeight - height - margin, width, height))
            }
            DualLayout.PHONE_FULL -> DualPlacement(pc = full, phone = full)
        }
    }
}
