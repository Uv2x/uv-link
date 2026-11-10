package com.uvlink.tv

import android.content.Context
import android.widget.FrameLayout

/** Sizes its children to the largest rectangle of [aspect] (width / height) that fits, centered. */
class AspectFitLayout(context: Context) : FrameLayout(context) {

    var aspect: Float = 16f / 9f
        set(value) {
            if (value > 0f && value != field) {
                field = value
                requestLayout()
            }
        }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height = MeasureSpec.getSize(heightMeasureSpec)
        var childWidth = width
        var childHeight = Math.round(width / aspect)
        if (childHeight > height) {
            childHeight = height
            childWidth = Math.round(height * aspect)
        }
        val childWidthSpec = MeasureSpec.makeMeasureSpec(childWidth, MeasureSpec.EXACTLY)
        val childHeightSpec = MeasureSpec.makeMeasureSpec(childHeight, MeasureSpec.EXACTLY)
        for (i in 0 until childCount) getChildAt(i).measure(childWidthSpec, childHeightSpec)
        setMeasuredDimension(width, height)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            val x = (right - left - child.measuredWidth) / 2
            val y = (bottom - top - child.measuredHeight) / 2
            child.layout(x, y, x + child.measuredWidth, y + child.measuredHeight)
        }
    }
}
