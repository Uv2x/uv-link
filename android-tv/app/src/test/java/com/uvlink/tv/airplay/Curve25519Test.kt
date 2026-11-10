package com.uvlink.tv.airplay

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.EdECPrivateKey
import java.security.interfaces.EdECPublicKey
import java.security.interfaces.XECPrivateKey
import java.security.interfaces.XECPublicKey
import java.security.spec.NamedParameterSpec
import java.security.spec.XECPublicKeySpec
import javax.crypto.KeyAgreement

/** Our Ed25519 and X25519 must agree byte for byte with the JDK's (RFC 8032 / RFC 7748). */
class Curve25519Test {

    @Test
    fun x25519MatchesJdk() {
        val generator = KeyPairGenerator.getInstance("X25519")
        repeat(20) {
            val alice = generator.generateKeyPair()
            val bob = generator.generateKeyPair()
            val alicePrivate = (alice.private as XECPrivateKey).scalar.get()
            val bobPublic = Curve25519.toLittleEndian((bob.public as XECPublicKey).u)

            assertArrayEquals(Curve25519.toLittleEndian((alice.public as XECPublicKey).u), Curve25519.xPublicKey(alicePrivate))

            val agreement = KeyAgreement.getInstance("X25519")
            agreement.init(alice.private)
            agreement.doPhase(bob.public, true)
            assertArrayEquals(agreement.generateSecret(), Curve25519.xSharedSecret(alicePrivate, bobPublic))
        }
    }

    @Test
    fun x25519PublicKeyWorksWithJdkAgreement() {
        val ours = ByteArray(32) { (it * 7 + 3).toByte() }
        val oursPublic = Curve25519.xPublicKey(ours)
        val jdk = KeyPairGenerator.getInstance("X25519").generateKeyPair()
        val agreement = KeyAgreement.getInstance("X25519")
        agreement.init(jdk.private)
        val peer = KeyFactory.getInstance("X25519")
            .generatePublic(XECPublicKeySpec(NamedParameterSpec.X25519, Curve25519.fromLittleEndian(oursPublic)))
        agreement.doPhase(peer, true)
        val jdkPublic = Curve25519.toLittleEndian((jdk.public as XECPublicKey).u)
        assertArrayEquals(agreement.generateSecret(), Curve25519.xSharedSecret(ours, jdkPublic))
    }

    @Test
    fun ed25519MatchesJdk() {
        val generator = KeyPairGenerator.getInstance("Ed25519")
        repeat(10) { round ->
            val pair = generator.generateKeyPair()
            val seed = (pair.private as EdECPrivateKey).bytes.get()
            val jdkPublic = encode(pair.public as EdECPublicKey)
            assertArrayEquals(jdkPublic, Curve25519.edPublicKey(seed))

            val message = ByteArray(round * 13) { (it xor round).toByte() }
            val signer = Signature.getInstance("Ed25519")
            signer.initSign(pair.private)
            signer.update(message)
            val jdkSignature = signer.sign()
            // Ed25519 is deterministic, so both must produce the same signature.
            assertArrayEquals(jdkSignature, Curve25519.edSign(seed, message))
            assertTrue(Curve25519.edVerify(jdkPublic, message, jdkSignature))

            val tampered = jdkSignature.copyOf().also { it[5] = (it[5].toInt() xor 1).toByte() }
            assertFalse(Curve25519.edVerify(jdkPublic, message, tampered))
            assertFalse(Curve25519.edVerify(jdkPublic, message + 1.toByte(), jdkSignature))
        }
    }

    private fun encode(key: EdECPublicKey): ByteArray {
        val out = Curve25519.toLittleEndian(key.point.y)
        if (key.point.isXOdd) out[31] = (out[31].toInt() or 0x80).toByte()
        return out
    }

    @Test
    fun littleEndianRoundTrip() {
        val value = BigInteger("123456789012345678901234567890")
        assertTrue(Curve25519.fromLittleEndian(Curve25519.toLittleEndian(value)) == value)
    }
}
