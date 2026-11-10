package com.uvlink.tv.airplay

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The receiver's long-term Ed25519 key. Its public half is advertised over mDNS as "pk" and
 * returned by /pair-setup; keep the seed stable so iPhones recognise the TV again.
 */
class AirPlayIdentity(seed: ByteArray) {
    val seed: ByteArray = seed.copyOf()
    val publicKey: ByteArray = Curve25519.edPublicKey(this.seed)

    fun sign(message: ByteArray): ByteArray = Curve25519.edSign(seed, message)

    companion object {
        fun generate(random: SecureRandom = SecureRandom()): AirPlayIdentity =
            AirPlayIdentity(ByteArray(32).also { random.nextBytes(it) })
    }
}

class PairingException(message: String) : Exception(message)

/**
 * AirPlay "legacy pairing": POST /pair-setup, then the two-step POST /pair-verify, which agrees
 * an X25519 secret and proves both sides' Ed25519 keys. One instance per connection.
 */
internal class PairingSession(
    private val identity: AirPlayIdentity,
    private val random: SecureRandom = SecureRandom()
) {
    var sharedSecret: ByteArray? = null
        private set
    var verified = false
        private set

    private var clientX25519: ByteArray? = null
    private var clientEd25519: ByteArray? = null
    private var serverX25519: ByteArray? = null

    fun setup(): ByteArray = identity.publicKey.copyOf()

    /** Reply body for one /pair-verify request. Throws [PairingException] when it can't be trusted. */
    fun verify(request: ByteArray): ByteArray {
        if (request.size < 4) throw PairingException("pair-verify body too short (${request.size} bytes)")
        return when (request[0].toInt()) {
            1 -> {
                if (request.size != 4 + 32 + 32) throw PairingException("pair-verify step 1 is ${request.size} bytes")
                val clientX = request.copyOfRange(4, 36)
                val clientEd = request.copyOfRange(36, 68)
                val privateKey = ByteArray(32).also { random.nextBytes(it) }
                val serverX = Curve25519.xPublicKey(privateKey)
                val secret = Curve25519.xSharedSecret(privateKey, clientX)
                clientX25519 = clientX
                clientEd25519 = clientEd
                serverX25519 = serverX
                sharedSecret = secret
                verified = false
                val signature = identity.sign(serverX + clientX)
                serverX + verifyCipher(secret).doFinal(signature)
            }
            0 -> {
                if (request.size != 4 + 64) throw PairingException("pair-verify step 2 is ${request.size} bytes")
                val secret = sharedSecret ?: throw PairingException("pair-verify step 2 came before step 1")
                val cipher = verifyCipher(secret)
                cipher.update(ByteArray(64)) // skip the keystream that encrypted our own signature
                val signature = cipher.doFinal(request, 4, 64)
                if (!Curve25519.edVerify(clientEd25519!!, clientX25519!! + serverX25519!!, signature)) {
                    throw PairingException("the sender's pair-verify signature is wrong")
                }
                verified = true
                ByteArray(0)
            }
            else -> throw PairingException("unknown pair-verify step ${request[0]}")
        }
    }

    private fun verifyCipher(secret: ByteArray): Cipher {
        val key = AirPlayKeys.sha512("Pair-Verify-AES-Key".toByteArray(), secret).copyOf(16)
        val iv = AirPlayKeys.sha512("Pair-Verify-AES-IV".toByteArray(), secret).copyOf(16)
        return Cipher.getInstance("AES/CTR/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        }
    }
}

internal object AirPlayKeys {
    fun sha512(vararg parts: ByteArray): ByteArray {
        val digest = MessageDigest.getInstance("SHA-512")
        parts.forEach { digest.update(it) }
        return digest.digest()
    }

    /**
     * Key for this session's audio and video: the FairPlay key, hashed with the pairing secret
     * when the sender paired (it always does, because we advertise "supports legacy pairing").
     */
    fun sessionKey(fairPlayKey: ByteArray, sharedSecret: ByteArray?): ByteArray =
        if (sharedSecret == null) fairPlayKey.copyOf(16) else sha512(fairPlayKey, sharedSecret).copyOf(16)
}

/**
 * AES-CTR over the screen-mirroring video payloads. The keystream runs on across packets: when a
 * packet ends inside a block, the rest of that block's keystream starts the next packet.
 */
internal class MirrorCipher(sessionKey: ByteArray, streamConnectionId: String) {
    private val cipher: Cipher = Cipher.getInstance("AES/CTR/NoPadding")
    private val leftover = ByteArray(16)
    private var leftoverCount = 0

    init {
        val key = AirPlayKeys.sha512("AirPlayStreamKey$streamConnectionId".toByteArray(), sessionKey).copyOf(16)
        val iv = AirPlayKeys.sha512("AirPlayStreamIV$streamConnectionId".toByteArray(), sessionKey).copyOf(16)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
    }

    /** Decrypts (or encrypts: CTR is symmetric) [length] bytes of [data] in place. */
    fun crypt(data: ByteArray, offset: Int = 0, length: Int = data.size - offset) {
        var pos = offset
        var remaining = length
        if (leftoverCount > 0 && remaining > 0) {
            val use = minOf(leftoverCount, remaining)
            val start = 16 - leftoverCount
            for (i in 0 until use) data[pos + i] = (data[pos + i].toInt() xor leftover[start + i].toInt()).toByte()
            leftoverCount -= use
            pos += use
            remaining -= use
        }
        val whole = remaining / 16 * 16
        if (whole > 0) {
            val out = cipher.update(data, pos, whole)
            check(out != null && out.size == whole) { "AES-CTR returned ${out?.size} of $whole bytes" }
            System.arraycopy(out, 0, data, pos, whole)
            pos += whole
            remaining -= whole
        }
        if (remaining > 0) {
            leftover.fill(0)
            System.arraycopy(data, pos, leftover, 0, remaining)
            val block = cipher.update(leftover, 0, 16)
            check(block != null && block.size == 16) { "AES-CTR returned a short block" }
            System.arraycopy(block, 0, leftover, 0, 16)
            System.arraycopy(leftover, 0, data, pos, remaining)
            leftoverCount = 16 - remaining
        }
    }
}

/** AES-CBC over audio packets: each packet starts again from the session IV; a tail shorter than a block is sent in the clear. */
internal class AudioCipher(sessionKey: ByteArray, iv: ByteArray) {
    private val key = SecretKeySpec(sessionKey.copyOf(16), "AES")
    private val iv = IvParameterSpec(iv.copyOf(16))
    private val cipher: Cipher = Cipher.getInstance("AES/CBC/NoPadding")

    fun decrypt(data: ByteArray, offset: Int = 0, length: Int = data.size - offset) {
        val whole = length / 16 * 16
        if (whole == 0) return
        cipher.init(Cipher.DECRYPT_MODE, key, iv)
        val plain = cipher.doFinal(data, offset, whole)
        System.arraycopy(plain, 0, data, offset, whole)
    }
}
