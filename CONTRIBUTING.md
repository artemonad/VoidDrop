# Contributing to VoidDrop

First off, thank you for taking the time to contribute! VoidDrop is an open-source, non-profit community project built for absolute privacy and secure file sharing.

We welcome contributions of all kinds: bug fixes, feature implementations, UI improvements, documentation, translation, and security audits.

## Core Principle

**The server must remain blind.** 

Any contribution that introduces feature-bloat which exposes plaintext files, filenames, folders, or user identity secrets to the signaling backend (or any third-party telemetry server) will be rejected immediately. Privacy is our absolute priority.

## Development Setup

VoidDrop consists of three primary components:
1. **Frontend / Desktop Client:** SvelteKit 5 + TypeScript + Tauri 2.
2. **Backend:** High-performance Axum (Rust) WebSocket signaling relay.
3. **Crypto Module:** Rust-based WebAssembly module compiled using `wasm-pack`.

### Prerequisites
- Node.js ≥ 20 (LTS recommended)
- Rust stable
- wasm-pack (`cargo install wasm-pack`)
- Docker (for local STUN/TURN reverse-proxy testing)

---

## Workflow

### 1. Build the WebAssembly Module
The cryptography module is compiled from Rust to WASM so it runs at native speeds in Web Workers.
```bash
cd crypto-worker
wasm-pack build --target web
```

### 2. Start the Axum Backend
```bash
cd backend
cargo run
```
*The backend runs on `http://localhost:3300` (or `3301` on Windows fallback).*

### 3. Start the Svelte 5 Dev Server
```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```
*The app will run on `http://localhost:5173`.*

---

## Coding Guidelines

### Frontend (Svelte 5 & TypeScript)
- Use Svelte 5 **Runes** (`$state`, `$derived`, `$effect`) instead of Svelte 4 legacy store architectures.
- Keep components focused and modular. Avoid giant "God-components".
- Use Vanilla CSS variables inside component `<style>` blocks for the beautiful Glassmorphic and Neumorphic design system.

### Backend (Rust)
- Follow standard Rust idiomatic code (`cargo clippy` and `cargo fmt`).
- Use structured logging via the `tracing` library. Avoid raw `println!` or `eprintln!`.
- Ensure all shared state is thread-safe and protected from race conditions (TOCTOU) using atomic operations or explicit exclusive collection locks.

---

## Running Tests

We maintain strict test suites for all parts of the application. All contributions must pass their respective test suites before being merged.

### Frontend Unit & Integration Tests (Vitest)
```bash
cd frontend
npx vitest run
```

### End-to-End P2P Tests (Playwright)
Make sure the local backend is running, then execute:
```bash
cd frontend
npx playwright test
```

### Backend Integration Tests (Cargo)
```bash
cd backend
cargo test
```

---

## Submitting Pull Requests

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/amazing-feature`).
3. Write clean, readable code and verify it passes all tests.
4. Commit your changes (`git commit -m 'feat: Add amazing feature'`).
5. Push to your branch (`git push origin feature/amazing-feature`).
6. Open a Pull Request on GitHub or Codeberg.

Thank you for helping us build the future of private P2P file transfers! 🌐🔐
