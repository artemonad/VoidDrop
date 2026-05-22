# Security Policy

## Supported Versions

We actively maintain and support the latest release of VoidDrop. We highly recommend all users and self-hosters update to the latest version immediately when updates are published.

| Version | Supported |
| ------- | --------- |
| v1.0.x  | ✅ Yes     |
| < v1.0  | ❌ No      |

## Our Commitment to Privacy & Security

VoidDrop is built on the principle of absolute, zero-knowledge privacy. Plaintext file contents, metadata, and encryption keys never touch any server. All cryptographic operations (ML-KEM, XChaCha20-Poly1305) run strictly on the client side inside the browser sandbox or native Tauri application.

Because of this architectural design, any potential security vulnerability is treated with the highest priority.

## Reporting a Vulnerability

**Please do not open public GitHub or Codeberg issues for security-sensitive bugs or cryptographic vulnerabilities.** 

If you discover a vulnerability or potential security issue, please report it privately:

1. **Email:** Send a detailed report to [security@voiddrop.ru](mailto:security@voiddrop.ru).
2. **Encrypted Communication:** If you wish to encrypt your report, please let us know in a brief introductory email, and we will coordinate a secure PGP-encrypted or Signal channel.

### What to Include in the Report:
- A detailed description of the vulnerability.
- A proof-of-concept (PoC) or step-by-step instructions to reproduce the issue.
- Potential impact (e.g., local memory leaks, remote key exhaustion, signaling manipulation).
- Your name/pseudonym if you would like to be credited in our changelog once the patch is published.

## Disclosure Process

We follow coordinated vulnerability disclosure principles:

1. We will acknowledge receipt of your report within **48 hours**.
2. We will analyze the issue, determine its severity, and develop a patch.
3. We will keep you updated throughout the process.
4. Once the patch is successfully merged, deployed to production (`voiddrop.ru`), and native binaries are updated, we will publish the release notes and credit you for the discovery (unless you request anonymity).

Thank you for helping keep VoidDrop secure!
