package com.uvlink.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DualViewLayoutTest {
    private val full = Box(0, 0, 1920, 1080)
    private val portraitPhone = 886f / 1920f // an iPhone held upright
    private val landscapePhone = 1920f / 886f

    private fun place(layout: DualLayout, aspect: Float, pc: Boolean = true, phone: Boolean = true) =
        DualViewLayout.place(layout, 1920, 1080, aspect, pcCasting = pc, phoneMirroring = phone, margin = 32)

    @Test
    fun withoutAnIphoneThePcFillsTheScreen() {
        val placement = place(DualLayout.SIDE_BY_SIDE, portraitPhone, phone = false)
        assertEquals(full, placement.pc)
        assertNull(placement.phone)
    }

    @Test
    fun withoutAPcCastTheIphoneFillsTheScreen() {
        assertEquals(full, place(DualLayout.SIDE_BY_SIDE, portraitPhone, pc = false).phone)
        assertEquals(full, place(DualLayout.PICTURE_IN_PICTURE, landscapePhone, pc = false).phone)
    }

    @Test
    fun sideBySideGivesAPortraitPhoneAFullHeightColumn() {
        val placement = place(DualLayout.SIDE_BY_SIDE, portraitPhone)
        val phoneWidth = Math.round(1080 * portraitPhone) // 498
        assertEquals(Box(1920 - phoneWidth, 0, phoneWidth, 1080), placement.phone)
        assertEquals(Box(0, 0, 1920 - phoneWidth, 1080), placement.pc)
    }

    @Test
    fun sideBySideSplitsInHalfForALandscapePhone() {
        val placement = place(DualLayout.SIDE_BY_SIDE, landscapePhone)
        assertEquals(Box(960, 0, 960, 1080), placement.phone)
        assertEquals(Box(0, 0, 960, 1080), placement.pc)
    }

    @Test
    fun pictureInPictureSitsBottomRightAtTheVideosShape() {
        val portrait = place(DualLayout.PICTURE_IN_PICTURE, portraitPhone)
        assertEquals(full, portrait.pc)
        val height = Math.round(1080 * 0.42f)
        val width = Math.round(height * portraitPhone)
        assertEquals(Box(1920 - width - 32, 1080 - height - 32, width, height), portrait.phone)

        val landscape = place(DualLayout.PICTURE_IN_PICTURE, 16f / 9f)
        assertEquals(Box(1920 - 576 - 32, 1080 - 324 - 32, 576, 324), landscape.phone)
    }

    @Test
    fun unknownAspectFallsBackTo16By9() {
        assertEquals(place(DualLayout.SIDE_BY_SIDE, 16f / 9f), place(DualLayout.SIDE_BY_SIDE, 0f))
    }

    @Test
    fun layoutsCycleBothWays() {
        assertEquals(DualLayout.PICTURE_IN_PICTURE, DualLayout.SIDE_BY_SIDE.next())
        assertEquals(DualLayout.SIDE_BY_SIDE, DualLayout.PHONE_FULL.next())
        assertEquals(DualLayout.PHONE_FULL, DualLayout.SIDE_BY_SIDE.previous())
    }
}
