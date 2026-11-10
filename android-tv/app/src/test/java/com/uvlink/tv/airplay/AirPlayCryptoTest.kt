package com.uvlink.tv.airplay

import com.uvlink.tv.airplay.fairplay.FairPlayHandshake
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.EdECPublicKey
import java.security.interfaces.XECPublicKey
import java.security.spec.EdECPoint
import java.security.spec.EdECPublicKeySpec
import java.security.spec.NamedParameterSpec
import java.security.spec.XECPublicKeySpec
import java.util.Random
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

class AirPlayCryptoTest {

    @Test
    fun fairPlayHandshakeRepliesLikeAnAppleTv() {
        val fairPlay = FairPlayHandshake()
        assertArrayEquals(IphoneCapture.fpSetup1Reply, fairPlay.setup(IphoneCapture.fpSetup1Request))
        assertArrayEquals(IphoneCapture.fpSetup2Reply, fairPlay.setup(IphoneCapture.fpSetup2Request))
        assertTrue(fairPlay.isReady)
    }

    /** The real proof: our keys decrypt a video packet captured from an iPhone into valid H.264. */
    @Test
    fun decryptsRealIphoneVideo() {
        val fairPlay = FairPlayHandshake()
        fairPlay.setup(IphoneCapture.fpSetup1Request)
        fairPlay.setup(IphoneCapture.fpSetup2Request)
        val sessionKey = AirPlayKeys.sessionKey(fairPlay.decryptAesKey(IphoneCapture.ekey), IphoneCapture.sharedSecret)
        val cipher = MirrorCipher(sessionKey, IphoneCapture.STREAM_CONNECTION_ID.toULong().toString())

        val packet = IphoneCapture.videoPacket()
        cipher.crypt(packet)

        val nalLength = ((packet[0].toInt() and 0xff) shl 24) or ((packet[1].toInt() and 0xff) shl 16) or
            ((packet[2].toInt() and 0xff) shl 8) or (packet[3].toInt() and 0xff)
        assertEquals("first NAL unit fills the packet", packet.size - 4, nalLength)
        assertTrue(AirPlayServer.lengthPrefixedToAnnexB(packet))
        assertArrayEquals(byteArrayOf(0, 0, 0, 1), packet.copyOfRange(0, 4))
        val nalType = packet[4].toInt() and 0x1f
        assertTrue("H.264 slice NAL, got type $nalType", nalType == 1 || nalType == 5)
    }

    @Test
    fun mirrorCipherKeystreamRunsAcrossPackets() {
        val random = Random(42)
        val key = ByteArray(16).also { random.nextBytes(it) }
        val plain = ByteArray(10_000).also { random.nextBytes(it) }

        val whole = plain.copyOf()
        MirrorCipher(key, "123").crypt(whole)

        val pieces = plain.copyOf()
        val split = MirrorCipher(key, "123")
        var pos = 0
        val sizes = intArrayOf(1, 15, 16, 17, 3, 100, 31, 2, 4000)
        var i = 0
        while (pos < pieces.size) {
            val size = minOf(sizes[i++ % sizes.size], pieces.size - pos)
            split.crypt(pieces, pos, size)
            pos += size
        }
        assertArrayEquals(whole, pieces)

        // And the same as plain AES-CTR over the whole stream.
        val reference = Cipher.getInstance("AES/CTR/NoPadding")
        val streamKey = AirPlayKeys.sha512("AirPlayStreamKey123".toByteArray(), key).copyOf(16)
        val streamIv = AirPlayKeys.sha512("AirPlayStreamIV123".toByteArray(), key).copyOf(16)
        reference.init(Cipher.ENCRYPT_MODE, SecretKeySpec(streamKey, "AES"), IvParameterSpec(streamIv))
        assertArrayEquals(reference.doFinal(plain), whole)
    }

    @Test
    fun audioCipherLeavesTheShortTailInTheClear() {
        val key = ByteArray(16) { it.toByte() }
        val iv = ByteArray(16) { (it * 3).toByte() }
        val plain = ByteArray(37) { (it + 1).toByte() }
        val encrypt = Cipher.getInstance("AES/CBC/NoPadding")
        encrypt.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        val packet = encrypt.doFinal(plain, 0, 32) + plain.copyOfRange(32, 37)

        AudioCipher(key, iv).decrypt(packet)
        assertArrayEquals(plain, packet)
    }

    /** pair-verify against an iPhone simulated with the JDK's own X25519 and Ed25519. */
    @Test
    fun pairVerifyWithJdkClient() {
        val identity = AirPlayIdentity.generate()
        val pairing = PairingSession(identity)
        assertArrayEquals(identity.publicKey, pairing.setup())

        val client = JdkPairingClient()
        val reply = pairing.verify(client.step1())
        assertEquals(96, reply.size)
        assertTrue(client.checkServer(reply, identity.publicKey))
        assertEquals(0, pairing.verify(client.step2()).size)
        assertTrue(pairing.verified)
        assertArrayEquals(client.sharedSecret, pairing.sharedSecret)
    }

    @Test(expected = PairingException::class)
    fun pairVerifyRejectsAForgedSignature() {
        val identity = AirPlayIdentity.generate()
        val pairing = PairingSession(identity)
        val client = JdkPairingClient()
        assertTrue(client.checkServer(pairing.verify(client.step1()), identity.publicKey))
        val forged = client.step2().also { it[10] = (it[10].toInt() xor 0x40).toByte() }
        pairing.verify(forged)
    }
}

/** The iPhone side of legacy pairing, written against the JDK so it checks ours independently. */
internal class JdkPairingClient {
    private val x = KeyPairGenerator.getInstance("X25519").generateKeyPair()
    private val ed = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    val x25519Public: ByteArray = Curve25519.toLittleEndian((x.public as XECPublicKey).u)
    val ed25519Public: ByteArray = encodeEd(ed.public as EdECPublicKey)
    lateinit var sharedSecret: ByteArray
    private lateinit var serverX: ByteArray
    private lateinit var cipher: Cipher

    fun step1(): ByteArray = byteArrayOf(1, 0, 0, 0) + x25519Public + ed25519Public

    /** Checks the receiver's signature over (serverX || clientX) with its advertised key. */
    fun checkServer(reply: ByteArray, serverPublicKey: ByteArray): Boolean {
        serverX = reply.copyOfRange(0, 32)
        val agreement = KeyAgreement.getInstance("X25519")
        agreement.init(x.private)
        agreement.doPhase(
            KeyFactory.getInstance("X25519").generatePublic(
                XECPublicKeySpec(NamedParameterSpec.X25519, Curve25519.fromLittleEndian(serverX))
            ),
            true
        )
        sharedSecret = agreement.generateSecret()
        val key = AirPlayKeys.sha512("Pair-Verify-AES-Key".toByteArray(), sharedSecret).copyOf(16)
        val iv = AirPlayKeys.sha512("Pair-Verify-AES-IV".toByteArray(), sharedSecret).copyOf(16)
        cipher = Cipher.getInstance("AES/CTR/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        val signature = cipher.update(reply, 32, 64)
        val verifier = Signature.getInstance("Ed25519")
        verifier.initVerify(decodeEd(serverPublicKey))
        verifier.update(serverX + x25519Public)
        return verifier.verify(signature)
    }

    /** Our signature over (clientX || serverX), encrypted with the keystream after the server's. */
    fun step2(): ByteArray {
        val signer = Signature.getInstance("Ed25519")
        signer.initSign(ed.private)
        signer.update(x25519Public + serverX)
        return byteArrayOf(0, 0, 0, 0) + cipher.update(signer.sign())
    }

    private fun encodeEd(key: EdECPublicKey): ByteArray {
        val out = Curve25519.toLittleEndian(key.point.y)
        if (key.point.isXOdd) out[31] = (out[31].toInt() or 0x80).toByte()
        return out
    }

    private fun decodeEd(encoded: ByteArray): java.security.PublicKey {
        val copy = encoded.copyOf()
        val xOdd = copy[31].toInt() and 0x80 != 0
        copy[31] = (copy[31].toInt() and 0x7f).toByte()
        val point = EdECPoint(xOdd, Curve25519.fromLittleEndian(copy))
        return KeyFactory.getInstance("Ed25519").generatePublic(EdECPublicKeySpec(NamedParameterSpec.ED25519, point))
    }
}
