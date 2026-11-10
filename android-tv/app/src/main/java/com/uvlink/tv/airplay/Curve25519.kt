package com.uvlink.tv.airplay

import java.math.BigInteger
import java.security.MessageDigest

/**
 * Ed25519 signatures (RFC 8032) and X25519 key agreement (RFC 7748) for AirPlay pairing.
 *
 * Android only ships these from API 31/33, and the app runs on API 23+, so they are written out
 * here with [BigInteger]. Pairing does a handful of operations per connection, so speed is fine.
 * Not constant-time: acceptable for a LAN screen-mirroring handshake, not for long-term secrets.
 * The unit tests check both against the JDK's own implementations.
 */
internal object Curve25519 {
    private val TWO: BigInteger = BigInteger.valueOf(2)
    val P: BigInteger = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19))
    private val L: BigInteger = BigInteger.ONE.shiftLeft(252).add(BigInteger("27742317777372353535851937790883648493"))
    private val D: BigInteger = BigInteger.valueOf(-121665).multiply(inv(BigInteger.valueOf(121666))).mod(P)
    private val SQRT_M1: BigInteger = TWO.modPow(P.subtract(BigInteger.ONE).shiftRight(2), P)
    private val A24: BigInteger = BigInteger.valueOf(121665)
    private val TWO_D: BigInteger = D.shiftLeft(1).mod(P)

    private class Point(val x: BigInteger, val y: BigInteger, val z: BigInteger, val t: BigInteger)

    private val NEUTRAL = Point(BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO)
    private val BASE: Point = run {
        val y = BigInteger.valueOf(4).multiply(inv(BigInteger.valueOf(5))).mod(P)
        val x = recoverX(y, 0) ?: error("bad base point")
        Point(x, y, BigInteger.ONE, x.multiply(y).mod(P))
    }

    private fun inv(v: BigInteger): BigInteger = v.modPow(P.subtract(TWO), P)

    // ------------------------------------------------------------------ Ed25519

    fun edPublicKey(seed: ByteArray): ByteArray {
        require(seed.size == 32) { "Ed25519 seed must be 32 bytes" }
        return compress(mul(expand(seed).first, BASE))
    }

    fun edSign(seed: ByteArray, message: ByteArray): ByteArray {
        val (a, prefix) = expand(seed)
        val publicKey = compress(mul(a, BASE))
        val r = sha512ModL(prefix, message)
        val rEncoded = compress(mul(r, BASE))
        val h = sha512ModL(rEncoded, publicKey, message)
        val s = r.add(h.multiply(a)).mod(L)
        return rEncoded + toLittleEndian(s)
    }

    fun edVerify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        if (publicKey.size != 32 || signature.size != 64) return false
        val a = decompress(publicKey) ?: return false
        val rEncoded = signature.copyOfRange(0, 32)
        val r = decompress(rEncoded) ?: return false
        val s = fromLittleEndian(signature.copyOfRange(32, 64))
        if (s >= L) return false
        val h = sha512ModL(rEncoded, publicKey, message)
        return pointsEqual(mul(s, BASE), add(r, mul(h, a)))
    }

    private fun expand(seed: ByteArray): Pair<BigInteger, ByteArray> {
        val h = MessageDigest.getInstance("SHA-512").digest(seed)
        val scalarBytes = h.copyOfRange(0, 32)
        scalarBytes[0] = (scalarBytes[0].toInt() and 248).toByte()
        scalarBytes[31] = ((scalarBytes[31].toInt() and 127) or 64).toByte()
        return fromLittleEndian(scalarBytes) to h.copyOfRange(32, 64)
    }

    private fun sha512ModL(vararg parts: ByteArray): BigInteger {
        val digest = MessageDigest.getInstance("SHA-512")
        parts.forEach { digest.update(it) }
        return fromLittleEndian(digest.digest()).mod(L)
    }

    private fun add(p: Point, q: Point): Point {
        val a = p.y.subtract(p.x).multiply(q.y.subtract(q.x)).mod(P)
        val b = p.y.add(p.x).multiply(q.y.add(q.x)).mod(P)
        val c = p.t.multiply(TWO_D).multiply(q.t).mod(P)
        val d = p.z.shiftLeft(1).multiply(q.z).mod(P)
        val e = b.subtract(a)
        val f = d.subtract(c)
        val g = d.add(c)
        val h = b.add(a)
        return Point(e.multiply(f).mod(P), g.multiply(h).mod(P), f.multiply(g).mod(P), e.multiply(h).mod(P))
    }

    private fun mul(scalar: BigInteger, point: Point): Point {
        var result = NEUTRAL
        var addend = point
        var s = scalar
        while (s.signum() > 0) {
            if (s.testBit(0)) result = add(result, addend)
            addend = add(addend, addend)
            s = s.shiftRight(1)
        }
        return result
    }

    private fun pointsEqual(p: Point, q: Point): Boolean =
        p.x.multiply(q.z).subtract(q.x.multiply(p.z)).mod(P).signum() == 0 &&
            p.y.multiply(q.z).subtract(q.y.multiply(p.z)).mod(P).signum() == 0

    private fun compress(p: Point): ByteArray {
        val zInv = inv(p.z)
        val x = p.x.multiply(zInv).mod(P)
        val y = p.y.multiply(zInv).mod(P)
        val out = toLittleEndian(y)
        if (x.testBit(0)) out[31] = (out[31].toInt() or 0x80).toByte()
        return out
    }

    private fun decompress(bytes: ByteArray): Point? {
        val copy = bytes.copyOf()
        val sign = (copy[31].toInt() shr 7) and 1
        copy[31] = (copy[31].toInt() and 0x7f).toByte()
        val y = fromLittleEndian(copy)
        if (y >= P) return null
        val x = recoverX(y, sign) ?: return null
        return Point(x, y, BigInteger.ONE, x.multiply(y).mod(P))
    }

    private fun recoverX(y: BigInteger, sign: Int): BigInteger? {
        val y2 = y.multiply(y).mod(P)
        val x2 = y2.subtract(BigInteger.ONE).multiply(inv(D.multiply(y2).add(BigInteger.ONE))).mod(P)
        if (x2.signum() == 0) return if (sign == 1) null else BigInteger.ZERO
        var x = x2.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P)
        if (x.multiply(x).subtract(x2).mod(P).signum() != 0) x = x.multiply(SQRT_M1).mod(P)
        if (x.multiply(x).subtract(x2).mod(P).signum() != 0) return null
        if ((if (x.testBit(0)) 1 else 0) != sign) x = P.subtract(x)
        return x
    }

    // ------------------------------------------------------------------ X25519

    private val NINE = ByteArray(32).also { it[0] = 9 }

    fun xPublicKey(privateKey: ByteArray): ByteArray = x25519(privateKey, NINE)

    fun xSharedSecret(privateKey: ByteArray, peerPublicKey: ByteArray): ByteArray = x25519(privateKey, peerPublicKey)

    private fun x25519(scalar: ByteArray, u: ByteArray): ByteArray {
        require(scalar.size == 32 && u.size == 32) { "X25519 keys must be 32 bytes" }
        val k = scalar.copyOf()
        k[0] = (k[0].toInt() and 248).toByte()
        k[31] = ((k[31].toInt() and 127) or 64).toByte()
        val kInt = fromLittleEndian(k)
        val uBytes = u.copyOf()
        uBytes[31] = (uBytes[31].toInt() and 127).toByte()
        val x1 = fromLittleEndian(uBytes).mod(P)

        var x2 = BigInteger.ONE
        var z2 = BigInteger.ZERO
        var x3 = x1
        var z3 = BigInteger.ONE
        var swap = false
        for (t in 254 downTo 0) {
            val bit = kInt.testBit(t)
            if (swap != bit) {
                var tmp = x2; x2 = x3; x3 = tmp
                tmp = z2; z2 = z3; z3 = tmp
            }
            swap = bit
            val a = x2.add(z2)
            val aa = a.multiply(a).mod(P)
            val b = x2.subtract(z2)
            val bb = b.multiply(b).mod(P)
            val e = aa.subtract(bb)
            val c = x3.add(z3)
            val d = x3.subtract(z3)
            val da = d.multiply(a).mod(P)
            val cb = c.multiply(b).mod(P)
            val sum = da.add(cb)
            val diff = da.subtract(cb)
            x3 = sum.multiply(sum).mod(P)
            z3 = x1.multiply(diff.multiply(diff)).mod(P)
            x2 = aa.multiply(bb).mod(P)
            z2 = e.multiply(aa.add(A24.multiply(e))).mod(P)
        }
        if (swap) {
            x2 = x3
            z2 = z3
        }
        return toLittleEndian(x2.multiply(inv(z2)).mod(P))
    }

    // ------------------------------------------------------------------ Encoding

    fun fromLittleEndian(bytes: ByteArray): BigInteger = BigInteger(1, bytes.reversedArray())

    /** Unsigned little-endian, exactly 32 bytes. */
    fun toLittleEndian(value: BigInteger): ByteArray {
        val bigEndian = value.toByteArray()
        val out = ByteArray(32)
        for (i in bigEndian.indices) {
            val target = bigEndian.size - 1 - i
            if (target < 32) out[target] = bigEndian[i]
        }
        return out
    }
}
