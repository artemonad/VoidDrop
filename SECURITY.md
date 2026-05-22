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

**Please do not open public issues for security-sensitive bugs or cryptographic vulnerabilities.**

If you discover a vulnerability or potential security issue, please report it privately:

1. **GitHub Private Vulnerability Reporting:** Go to the [Security tab](https://github.com/artemonad/VoidDrop/security) of the VoidDrop repository on GitHub and click on **Report a vulnerability** to submit a private report directly to the maintainers.
2. **Codeberg:** If you are using Codeberg, please contact the maintainers privately or request a secure private disclosure channel through your profile contact options.

### What to Include in the Report:
- A detailed description of the vulnerability.
- A proof-of-concept (PoC) or step-by-step instructions to reproduce the issue.
- Potential impact (e.g., local memory leaks, remote key exhaustion, signaling manipulation).

Thank you for helping keep VoidDrop secure!
