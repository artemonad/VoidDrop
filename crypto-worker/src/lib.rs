use wasm_bindgen::prelude::*;
use pqc_kyber::*;
use getrandom::getrandom;
use rand_core::{CryptoRng, RngCore, Error as RandError};

struct OsRng;
impl CryptoRng for OsRng {}
impl RngCore for OsRng {
    fn next_u32(&mut self) -> u32 {
        let mut buf = [0u8; 4];
        getrandom(&mut buf).unwrap();
        u32::from_le_bytes(buf)
    }
    fn next_u64(&mut self) -> u64 {
        let mut buf = [0u8; 8];
        getrandom(&mut buf).unwrap();
        u64::from_le_bytes(buf)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        getrandom(dest).unwrap();
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), RandError> {
        getrandom(dest).map_err(|e| {
            // getrandom::Error implements Into<rand_core::Error> for non-zero codes
            RandError::from(core::num::NonZeroU32::new(e.code().get()).unwrap())
        })
    }
}

#[wasm_bindgen]
pub struct MLKemKeyPair {
    ek: Vec<u8>,
    dk: Vec<u8>,
}

#[wasm_bindgen]
impl MLKemKeyPair {
    #[wasm_bindgen(getter)]
    pub fn public_key(&self) -> Vec<u8> {
        self.ek.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn secret_key(&self) -> Vec<u8> {
        self.dk.clone()
    }
}

#[wasm_bindgen]
pub struct MLKemCiphertext {
    ciphertext: Vec<u8>,
    shared_secret: Vec<u8>,
}

#[wasm_bindgen]
impl MLKemCiphertext {
    #[wasm_bindgen(getter)]
    pub fn ciphertext(&self) -> Vec<u8> {
        self.ciphertext.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn shared_secret(&self) -> Vec<u8> {
        self.shared_secret.clone()
    }
}

#[wasm_bindgen]
pub fn ml_kem_768_generate_keypair() -> Result<MLKemKeyPair, JsValue> {
    let mut rng = OsRng;
    let keys = keypair(&mut rng).map_err(|_| JsValue::from_str("Keypair generation failed"))?;
    
    Ok(MLKemKeyPair {
        ek: keys.public.into(),
        dk: keys.secret.into(),
    })
}

#[wasm_bindgen]
pub fn ml_kem_768_encapsulate(ek_bytes: &[u8]) -> Result<MLKemCiphertext, JsValue> {
    if ek_bytes.len() != KYBER_PUBLICKEYBYTES {
        return Err(JsValue::from_str(&format!(
            "Invalid public key length. Expected {} bytes, got {}.",
            KYBER_PUBLICKEYBYTES,
            ek_bytes.len()
        )));
    }
    let mut rng = OsRng;
    let res = encapsulate(ek_bytes, &mut rng).map_err(|_| JsValue::from_str("Encapsulation failed"))?;
    
    Ok(MLKemCiphertext {
        ciphertext: res.0.into(),
        shared_secret: res.1.into(),
    })
}

#[wasm_bindgen]
pub fn ml_kem_768_decapsulate(dk_bytes: &[u8], ct_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    if dk_bytes.len() != KYBER_SECRETKEYBYTES {
        return Err(JsValue::from_str(&format!(
            "Invalid secret key length. Expected {} bytes, got {}.",
            KYBER_SECRETKEYBYTES,
            dk_bytes.len()
        )));
    }
    if ct_bytes.len() != KYBER_CIPHERTEXTBYTES {
        return Err(JsValue::from_str(&format!(
            "Invalid ciphertext length. Expected {} bytes, got {}.",
            KYBER_CIPHERTEXTBYTES,
            ct_bytes.len()
        )));
    }
    let ss = decapsulate(ct_bytes, dk_bytes).map_err(|_| JsValue::from_str("Decapsulation failed"))?;
    Ok(ss.into())
}

#[wasm_bindgen]
pub fn rust_encrypt_chacha20poly1305(
    key: &[u8],
    nonce: &[u8],
    plaintext: &[u8],
    associated_data: &[u8],
) -> Result<Vec<u8>, JsValue> {
    use chacha20poly1305::{
        aead::{Aead, KeyInit, Payload},
        ChaCha20Poly1305, Nonce
    };

    if key.len() != 32 {
        return Err(JsValue::from_str("Invalid key length. Must be 32 bytes."));
    }
    if nonce.len() != 12 {
        return Err(JsValue::from_str("Invalid nonce length. Must be 12 bytes."));
    }

    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    let nonce_arr = Nonce::from_slice(nonce);

    let payload = Payload {
        msg: plaintext,
        aad: associated_data,
    };

    let ciphertext = cipher
        .encrypt(nonce_arr, payload)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    Ok(ciphertext)
}

#[wasm_bindgen]
pub fn rust_decrypt_chacha20poly1305(
    key: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
    associated_data: &[u8],
) -> Result<Vec<u8>, JsValue> {
    use chacha20poly1305::{
        aead::{Aead, KeyInit, Payload},
        ChaCha20Poly1305, Nonce
    };

    if key.len() != 32 {
        return Err(JsValue::from_str("Invalid key length. Must be 32 bytes."));
    }
    if nonce.len() != 12 {
        return Err(JsValue::from_str("Invalid nonce length. Must be 12 bytes."));
    }

    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    let nonce_arr = Nonce::from_slice(nonce);

    let payload = Payload {
        msg: ciphertext,
        aad: associated_data,
    };

    let plaintext = cipher
        .decrypt(nonce_arr, payload)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    Ok(plaintext)
}

#[wasm_bindgen]
pub fn rust_encrypt_xchacha20poly1305(
    key: &[u8],
    nonce: &[u8],
    plaintext: &[u8],
    associated_data: &[u8],
) -> Result<Vec<u8>, JsValue> {
    use chacha20poly1305::{
        aead::{Aead, KeyInit, Payload},
        XChaCha20Poly1305, XNonce
    };

    if key.len() != 32 {
        return Err(JsValue::from_str("Invalid key length. Must be 32 bytes."));
    }
    if nonce.len() != 24 {
        return Err(JsValue::from_str("Invalid nonce length. Must be 24 bytes."));
    }

    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    let nonce_arr = XNonce::from_slice(nonce);

    let payload = Payload {
        msg: plaintext,
        aad: associated_data,
    };

    let ciphertext = cipher
        .encrypt(nonce_arr, payload)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    Ok(ciphertext)
}

#[wasm_bindgen]
pub fn rust_decrypt_xchacha20poly1305(
    key: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
    associated_data: &[u8],
) -> Result<Vec<u8>, JsValue> {
    use chacha20poly1305::{
        aead::{Aead, KeyInit, Payload},
        XChaCha20Poly1305, XNonce
    };

    if key.len() != 32 {
        return Err(JsValue::from_str("Invalid key length. Must be 32 bytes."));
    }
    if nonce.len() != 24 {
        return Err(JsValue::from_str("Invalid nonce length. Must be 24 bytes."));
    }

    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    let nonce_arr = XNonce::from_slice(nonce);

    let payload = Payload {
        msg: ciphertext,
        aad: associated_data,
    };

    let plaintext = cipher
        .decrypt(nonce_arr, payload)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    Ok(plaintext)
}
