# VoidDrop Protocol v1 Specification

This document details the exact cryptographic schedule, signaling structures, and binary layouts required for the VoidDrop E2EE file-sharing protocol.

> **Naming:** "VoidDrop" (`VDDP`) is the internal wire-protocol name, used in magic bytes and key derivation contexts. Database names (`voiddrop_dev`) and binary magic (`VDDP01`) all use this protocol-level name.

## 1. Cryptographic Primitives
VoidDrop relies on WebCrypto within the browser and `libsodium` / PQC primitives within a WebAssembly (WASM) Worker.

- **AEAD (Manifest)**: XChaCha20-Poly1305 via Rust-compiled WebAssembly (`crypto-worker`).
- **Stream Cipher (Segments)**: Custom counter-based stream cipher (XChaCha20-Poly1305) via Rust-compiled WebAssembly (`crypto-worker`).
- **KDF**: HKDF-SHA-256 via WebCrypto.
- **MAC**: HMAC-SHA-256 via WebCrypto.
- **Key Exchange (Online P2P)**: X25519 (libsodium) + Optional ML-KEM-768 (WASM).

## 2. Key Derivation Schedule

The URL contains `#<secret>`. This high-entropy `PSK` acts as the root of trust.

### Common Identifiers
- `PSK` = Hex-decoded bytes from URL fragment. Must be $\ge$ 32 bytes.
- `Context` = `"voiddrop-v1"`
- `Salt` = `SHA-256(Context)`

### Signaling Key (Derived strictly from PSK, pre-handshake)
Used to authenticate WebRTC signaling messages before the key exchange completes.
This key is available immediately since it depends only on the PSK shared via the URL.
- `k_sig_mac` = `HKDF-Expand(HKDF-Extract(salt=empty, IKM=PSK), info="signaling-mac", L=32)`

### Data Keys (PSK + ECDH + PQC Handshake)
Used for encrypting data over WebRTC DataChannels. Derived after the hybrid key exchange completes.
- `SharedSecret` = `ML-KEM_shared` || `X25519_shared`
- `IKM` = `PSK` || `SharedSecret`
- `PRK` = `HKDF-Extract(salt=Salt, IKM=IKM)`
- `k_manifest` = `HKDF-Expand(PRK, info="manifest", L=32)`
- `k_seg_base` = `HKDF-Expand(PRK, info="p2p-seg-base", L=32)`

---

## 3. WebRTC Signaling Schema (Canonical CBOR)

All signaling messages relayed through the WebSocket backend are encoded as Canonical CBOR and appended with an HMAC-SHA256 signature to prevent MITM and replay attacks.

### Raw Message Format (Without MAC)
```cbor
{
  "v": 1,                     // Protocol version
  "rid": "room_uuid",         // Room ID string
  "sid": "sender_uuid",       // Random 16-32 byte ID generated on client start
  "seq": 42,                  // Monotonic sequence number (A -> B)
  "type": "offer",            // "offer", "answer", "ice", "close"
  "payload": { ... }          // SDP strings or ICE candidate objects
}
```

### Wire Format
Messages over the WebSocket consist of the CBOR serialization appended with a 32-byte MAC tag.

```text
Message Over Wire (32+N bytes):
[ HMAC-SHA-256 Tag (32 bytes) ] [ Canonical CBOR Payload (N bytes) ]
```
**Verification constraint:** `Tag = HMAC-SHA-256(k_sig_mac, CanonicalCBOR(Payload))`

### Perfect Negotiation Glare Resolution
- `Polite Peer`: Peer with the lexicographically *larger* `sender_id`.
- `Impolite Peer`: Peer with the lexicographically *smaller* `sender_id`.
- (Follows standard WebRTC perfect negotiation rollback logic).

---

## 4. Binary Container Layout

The binary stream is partitioned into a non-secret global header, an encrypted manifest, and independent segmented secretstreams.

### 4.1. Global Header (Plaintext, Fixed Size)
All values are Little-Endian unless otherwise noted.
- `0x00..0x07` (8b): Magic bytes `0x56 0x44 0x44 0x50 0x30 0x31 0x00 0x00` ("VDDP01\0\0")
- `0x08..0x09` (2b): `version` (u16) = `1`
- `0x0A..0x0B` (2b): `flags` (u16)
  - Bit 0: Has ML-KEM-768
  - Bits 1-15: Reserved
- `0x0C..0x0D` (2b): `cipher_suite_id` (u16) = `1` (XChaCha20Poly1305)
- `0x0E..0x11` (4b): `seg_size` (u32) (e.g., 16777216 for 16 MiB)
- `0x12..0x15` (4b): `max_frame_len` (u32) (e.g., 32768 for 32 KiB)
- `0x16..0x19` (4b): `manifest_len` (u32) (Must be $\le$ 1048576)

### 4.2. Manifest (Encrypted)
- Size: `manifest_len` bytes.
- Encryption: `AEAD_XChaCha20_Poly1305`
- `Key` = `k_manifest`
- `Nonce` = 24 bytes of `0x00`.
- `AAD` = Global Header Bytes (0x00 to 0x19).
- `Plaintext Format` (Canonical CBOR):
```cbor
{
  "type": "single",              // "single" or "bundle"
  "totalSize": 1048576000,       // Total plaintext bytes (u64)
  "files": [
    { "path": "example.mp4", "size": 1048576000, "mime": "video/mp4" }
  ]
}
```
For bundles, the `files` array contains multiple entries with relative paths preserving directory structure.

### 4.3. Data Stream
Continuing immediately after the Manifest ciphertext, the data stream starts with a 24-byte `nonce_base` followed by length-prefixed encrypted frames.

The entire file (or bundle) is encrypted as a linear sequence of frames using `k_seg_base` directly as the key. Each frame is encrypted independently using the custom counter-based stream cipher (XChaCha20-Poly1305) via the Rust-compiled WebAssembly (`crypto-worker` module) with a dynamically constructed 24-byte nonce.

> **Note on selective download (bundles):** Receivers download and decrypt the entire stream linearly. "Selective save" means the client decrypts all data but only writes selected files to disk. This is a deliberate trade-off for implementation simplicity and cryptographic reliability.

#### Stream Header (nonce_base)
- `0x00..0x17` (24b): `nonce_base` (A random 24-byte base generated by the sender on startup, or regenerated on Auto-Resume reconnects).

#### Nonce Construction
For each frame, a 24-byte nonce is constructed as follows:
1. Start with the 24-byte `nonce_base`.
2. Overwrite the last 8 bytes (`nonce[16..24]`) with the 64-bit frame counter `c` (monotonic sequence starting at 0) in Little-Endian format:
   - `nonce[16..19] = c & 0xffffffff`
   - `nonce[20..23] = Math.floor(c / 2^32)`

#### Encrypted Frames
Repeated until the last frame. Each frame is length-prefixed for reliable deframing over HTTP byte streams.
- `0x00..0x03` (4b): `frame_len` (u32 LE, ciphertext length including the 1-byte message tag and 16-byte Poly1305 AEAD tag).
- `0x04..(0x04 + frame_len)`: Ciphertext chunk.
  - Plaintext input before encryption is: `Payload || Tag` (where `Tag` is 1 byte).
  - Intermediate frames use `TAG_MESSAGE = 0x01`.
  - The last frame MUST use `TAG_FINAL = 0x02`.

#### Truncation Detection
On decryption, the receiver MUST verify that the final received frame carries `TAG_FINAL` (`0x02`). If the stream ends without a `TAG_FINAL` frame, the file is considered truncated and MUST be rejected.

---

## 5. System Limits & DoS Prevention Constraints
- `manifest_len` $\le$ 1 MiB.
- `max_frame_len` $\le$ 1 MiB (Software Hard Cap).
- The last frame MUST carry `TAG_FINAL`; absence indicates truncation.
- WebSocket signaling messages > 256 KiB are rejected.
- Room IDs must be valid UUID v4 format.
