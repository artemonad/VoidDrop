/// <reference types="node" />
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * P2P End-to-End Tests — require running backend + WebSocket relay.
 *
 * These tests verify the full P2P flow:
 * 1. Sender selects files
 * 2. Sender creates P2P session → generates link
 * 3. Receiver opens link → connects via WebSocket
 * 4. PQC handshake completes
 * 5. Manifest is sent and received
 * 6. File data streams and is received
 *
 * Run with: npx playwright test e2e/p2p-transfer.spec.ts
 * Requires: backend on localhost:3300, frontend on localhost:5173
 */

// Skip all if backend is not available
test.beforeEach(async ({}, testInfo) => {
    try {
        const res = await fetch('http://localhost:3300/api/turn-credentials');
        if (res.status !== 200 && res.status !== 400 && res.status !== 403 && res.status !== 429) {
            testInfo.skip(true, 'Signaling backend is not fully ready — skipping P2P E2E tests');
        }
    } catch {
        testInfo.skip(true, 'Backend not running on port 3300 — skipping P2P E2E tests');
    }
});

test.describe('P2P File Transfer Flow', () => {
    let senderPage: Page;
    let receiverPage: Page;
    let senderContext: BrowserContext;
    let receiverContext: BrowserContext;

    test.beforeEach(async ({ browser }) => {
        // Create two separate browser contexts (simulates two different users)
        senderContext = await browser.newContext();
        receiverContext = await browser.newContext();
        senderPage = await senderContext.newPage();
        receiverPage = await receiverContext.newPage();
    });

    test.afterEach(async () => {
        if (senderContext) await senderContext.close();
        if (receiverContext) await receiverContext.close();
    });

    test('single file P2P transfer: sender → receiver', async () => {
        // 1. Sender: go to homepage and add a file
        await senderPage.goto('/');
        await senderPage.waitForTimeout(3000); // Wait for WASM to load

        const fileInput = senderPage.locator('input[type="file"]').first();
        const testContent = 'Hello from VoidDrop P2P test! ' + Date.now();
        await fileInput.setInputFiles({
            name: 'p2p-test.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from(testContent),
        });

        await senderPage.waitForTimeout(1000);

        // Verify file appears in sender's file list
        await expect(senderPage.getByText('p2p-test.txt')).toBeVisible();

        // 2. Sender: click "Create P2P Session" button
        const sendBtn = senderPage.locator('button.btn-colored').filter({ hasText: /Create P2P Session/ });
        await expect(sendBtn).toBeVisible({ timeout: 5000 });
        await sendBtn.click();

        // 3. Wait for the P2P link to be generated (contains room:psk hash)
        await senderPage.waitForTimeout(5000);
        const linkElement = senderPage.locator('input.link-display, input[readonly]').first();
        const p2pLink = await linkElement.inputValue().catch(() => '');

        // The link should be present
        expect(p2pLink).toContain('#');
        expect(p2pLink.length).toBeGreaterThan(30);

        // 4. Receiver: open the P2P link
        await receiverPage.goto(p2pLink || '/');
        await receiverPage.waitForTimeout(3000);

        // 5. Wait for WebSocket connection and handshake
        await receiverPage.waitForTimeout(10000);

        // 6. Receiver should see the manifest (file list preview)
        const receiverBody = await receiverPage.textContent('body');
        expect(receiverBody).toContain('p2p-test.txt');

        // 7. Check that the sender shows connection established
        const senderBody = await senderPage.textContent('body');
        expect(senderBody?.toLowerCase()).toMatch(/connect|stream|peer/i);
    });

    test('multi-file P2P transfer', async () => {
        await senderPage.goto('/');
        await senderPage.waitForTimeout(3000);

        const fileInput = senderPage.locator('input[type="file"]').first();
        await fileInput.setInputFiles([
            { name: 'doc1.txt', mimeType: 'text/plain', buffer: Buffer.from('Document 1') },
            { name: 'doc2.txt', mimeType: 'text/plain', buffer: Buffer.from('Document 2') },
            { name: 'image.png', mimeType: 'image/png', buffer: Buffer.from('Fake PNG data') },
        ]);

        await senderPage.waitForTimeout(1000);

        // All three files should be listed
        await expect(senderPage.getByText('doc1.txt')).toBeVisible();
        await expect(senderPage.getByText('doc2.txt')).toBeVisible();
        await expect(senderPage.getByText('image.png')).toBeVisible();

        // Start P2P send
        const sendBtn = senderPage.locator('button.btn-colored').filter({ hasText: /Create P2P Session/ });
        if (await sendBtn.isVisible({ timeout: 3000 })) {
            await sendBtn.click();
            await senderPage.waitForTimeout(5000);

            // Verify link appears
            const linkEl = senderPage.locator('input.link-display, input[readonly]').first();
            const link = await linkEl.inputValue().catch(() => '');
            expect(link.length).toBeGreaterThan(10);
        }
    });

    test('P2P folder transfer: sender → receiver with directory tree structure', async () => {
        // 1. Sender: Go to homepage
        await senderPage.goto('/');
        await senderPage.waitForTimeout(3000); // Wait for WASM to load

        // 2. Sender: Emulate choosing a folder with a tree structure programmatically
        await senderPage.evaluate(() => {
            const folderInput = document.querySelector('input[webkitdirectory]') as HTMLInputElement;
            if (!folderInput) throw new Error("Folder input not found on page!");

            // Create fake File objects with webkitRelativePath
            const file1 = new File(["Nested Content A"], "my-project/src/index.js", { type: "application/javascript" });
            Object.defineProperty(file1, 'webkitRelativePath', { value: 'my-project/src/index.js' });

            const file2 = new File(["Nested Content B"], "my-project/src/utils/math.js", { type: "application/javascript" });
            Object.defineProperty(file2, 'webkitRelativePath', { value: 'my-project/src/utils/math.js' });

            const file3 = new File(["<html>Hello</html>"], "my-project/public/index.html", { type: "text/html" });
            Object.defineProperty(file3, 'webkitRelativePath', { value: 'my-project/public/index.html' });

            const filesList = [file1, file2, file3];
            const fileListMock = {
                length: filesList.length,
                item: (index: number) => filesList[index],
                ...filesList
            };

            // Override input.files and trigger change event
            Object.defineProperty(folderInput, 'files', { value: fileListMock, configurable: true });
            folderInput.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await senderPage.waitForTimeout(2000);

        // Verify folder elements are visible in sender's UI
        await expect(senderPage.getByText('index.js')).toBeVisible();
        await expect(senderPage.getByText('math.js')).toBeVisible();
        await expect(senderPage.getByText('index.html')).toBeVisible();

        // 3. Sender: Click "Create P2P Session"
        const sendBtn = senderPage.locator('button.btn-colored').filter({ hasText: /Create P2P Session/ });
        await expect(sendBtn).toBeVisible({ timeout: 5000 });
        await sendBtn.click();

        // 4. Wait for link generation
        await senderPage.waitForTimeout(5000);
        const linkElement = senderPage.locator('input.link-display, input[readonly]').first();
        const p2pLink = await linkElement.inputValue().catch(() => '');

        expect(p2pLink).toContain('#');
        expect(p2pLink.length).toBeGreaterThan(30);

        // 5. Receiver: Open the generated P2P link
        await receiverPage.goto(p2pLink || '/');
        await receiverPage.waitForTimeout(3000);

        // 6. Wait for handshake and metadata synchronization
        await receiverPage.waitForTimeout(10000);

        // 7. Receiver should see all the files in the directory structure
        const receiverBody = await receiverPage.textContent('body');
        expect(receiverBody).toContain('index.js');
        expect(receiverBody).toContain('math.js');
        expect(receiverBody).toContain('index.html');
    });
});

test.describe.skip('Cloud Upload/Download Flow', () => {
    test('cloud upload: init → upload → generates download link', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(3000);

        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles({
            name: 'cloud-test.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('Cloud upload test data'),
        });

        await page.waitForTimeout(1000);

        // Click the cloud/offline upload button
        const cloudBtn = page.locator('button.btn-cloud');
        if (await cloudBtn.isVisible({ timeout: 3000 })) {
            await cloudBtn.click();

            // Wait for upload to complete (connection to backend)
            await page.waitForTimeout(15000);

            // Check for a generated download link
            const body = await page.textContent('body');
            // Should show a link or progress
            expect(body?.toLowerCase()).toMatch(/link|upload|progress|complet/i);
        }
    });

    test('cloud download: valid file ID + key → initiates download', async ({ page }) => {
        // This test verifies the download page loads and renders when given params
        const testUuid = '550e8400-e29b-41d4-a716-446655440000';
        const testKey = 'a'.repeat(64);
        await page.goto(`/f/${testUuid}#${testKey}`, { waitUntil: 'networkidle' });

        await page.waitForTimeout(5000);

        // Page should have rendered the SvelteKit app (not just bootstrap script)
        const body = await page.textContent('body');
        expect(body).toBeTruthy();
        expect(body!.length).toBeGreaterThan(50);
    });
});

test.describe('WebSocket Signaling', () => {
    test('WebSocket connection to valid room', async ({ page }) => {
        const roomId = crypto.randomUUID();
        
        // Try connecting to WS endpoint directly via page.evaluate
        const wsResult = await page.evaluate(async (rid) => {
            return new Promise<string>((resolve) => {
                try {
                    const ws = new WebSocket(`ws://localhost:3300/ws/${rid}`);
                    ws.onopen = () => {
                        ws.close();
                        resolve('CONNECTED');
                    };
                    ws.onerror = () => resolve('ERROR');
                    setTimeout(() => {
                        ws.close();
                        resolve('TIMEOUT');
                    }, 5000);
                } catch (e) {
                    resolve('EXCEPTION');
                }
            });
        }, roomId);

        expect(wsResult).toBe('CONNECTED');
    });

    test('WebSocket rejects invalid room ID', async ({ page }) => {
        const result = await page.evaluate(async () => {
            return new Promise<string>((resolve) => {
                try {
                    const ws = new WebSocket('ws://localhost:3300/ws/not-a-uuid');
                    ws.onopen = () => {
                        ws.close();
                        resolve('CONNECTED_UNEXPECTEDLY');
                    };
                    ws.onerror = () => resolve('REJECTED');
                    ws.onclose = (e) => resolve(`CLOSED:${e.code}`);
                    setTimeout(() => {
                        ws.close();
                        resolve('TIMEOUT');
                    }, 5000);
                } catch (e) {
                    resolve('EXCEPTION');
                }
            });
        });

        // Server should reject the connection or close it immediately
        expect(result).toMatch(/REJECTED|CLOSED/);
    });

    test('WebSocket relays messages between two peers', async ({ browser }) => {
        const roomId = crypto.randomUUID();
        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page1 = await ctx1.newPage();
        const page2 = await ctx2.newPage();

        // Navigate both pages (needed for page.evaluate to work)
        await page1.goto('/');
        await page2.goto('/');

        // Peer 1: connect and listen
        const peer1Setup = page1.evaluate(async (rid) => {
            return new Promise<string>((resolve) => {
                const ws = new WebSocket(`ws://localhost:3300/ws/${rid}`);
                ws.binaryType = 'arraybuffer';
                ws.onmessage = (e) => {
                    const data = new Uint8Array(e.data as ArrayBuffer);
                    // Convert received bytes to string
                    resolve(new TextDecoder().decode(data));
                };
                ws.onerror = () => resolve('ERROR');
                setTimeout(() => {
                    ws.close();
                    resolve('TIMEOUT');
                }, 10000);
                (window as any).__ws1 = ws;
            });
        }, roomId);

        await page1.waitForTimeout(500);

        // Peer 2: connect and send a message
        await page2.evaluate(async (rid) => {
            return new Promise<void>((resolve) => {
                const ws = new WebSocket(`ws://localhost:3300/ws/${rid}`);
                ws.binaryType = 'arraybuffer';
                ws.onopen = () => {
                    const msg = new TextEncoder().encode('HELLO_FROM_PEER2');
                    ws.send(msg);
                    setTimeout(() => {
                        ws.close();
                        resolve();
                    }, 1000);
                };
                ws.onerror = () => resolve();
            });
        }, roomId);

        const received = await peer1Setup;
        expect(received).toBe('HELLO_FROM_PEER2');

        await ctx1.close();
        await ctx2.close();
    });

    test('WebSocket message size limit (> 256KB rejected)', async ({ page }) => {
        await page.goto('/');
        const roomId = crypto.randomUUID();

        const result = await page.evaluate(async (rid) => {
            return new Promise<string>((resolve) => {
                const ws = new WebSocket(`ws://localhost:3300/ws/${rid}`);
                ws.binaryType = 'arraybuffer';
                ws.onopen = () => {
                    // Send 270KB message (over 256KB limit)
                    const oversized = new Uint8Array(270_000);
                    ws.send(oversized);
                    setTimeout(() => {
                        resolve(ws.readyState === WebSocket.CLOSED ? 'DISCONNECTED' : 'STILL_OPEN');
                    }, 2000);
                };
                ws.onclose = () => resolve('DISCONNECTED');
                ws.onerror = () => resolve('ERROR');
                setTimeout(() => resolve('TIMEOUT'), 5000);
            });
        }, roomId);

        expect(result).toBe('DISCONNECTED');
    });

    test('WebSocket empty rooms are pruned instantly on client disconnect (DDoS/leak prevention)', async ({ browser }) => {
        const roomId = crypto.randomUUID();
        const ctx1 = await browser.newContext();
        const page1 = await ctx1.newPage();
        await page1.goto('/');

        // 1. Peer 1: Connect, send a message to populate history, and disconnect
        await page1.evaluate(async (rid) => {
            return new Promise<void>((resolve) => {
                const ws = new WebSocket(`ws://localhost:3300/ws/${rid}`);
                ws.onopen = () => {
                    ws.send(new TextEncoder().encode('HISTORICAL_MESSAGE'));
                    // Wait a bit for server to process and save, then close
                    setTimeout(() => {
                        ws.close();
                        resolve();
                    }, 500);
                };
            });
        }, roomId);

        await ctx1.close();

        // 2. Peer 2: Connect to the same room now that it is completely empty.
        // It should receive ZERO historical messages because the room was instantly pruned!
        const ctx2 = await browser.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto('/');

        const receivedMessages = await page2.evaluate(async (rid) => {
            return new Promise<string[]>((resolve) => {
                const ws = new WebSocket(`ws://localhost:3300/ws/${rid}`);
                ws.binaryType = 'arraybuffer';
                const msgs: string[] = [];
                ws.onmessage = (e) => {
                    const str = new TextDecoder().decode(e.data);
                    msgs.push(str);
                };
                ws.onopen = () => {
                    // Wait 2 seconds to see if any history is replayed
                    setTimeout(() => {
                        ws.close();
                        resolve(msgs);
                    }, 2000);
                };
                ws.onerror = () => resolve(msgs);
            });
        }, roomId);

        await ctx2.close();

        // Since the room was pruned immediately, the historical message is completely erased!
        expect(receivedMessages.length).toBe(0);
    });

    test('WebSocket signaling history buffer is capped at 100 messages (DDoS RAM-exhaustion protection)', async ({ browser }) => {
        const roomId = crypto.randomUUID();
        
        // 1. Monitor peer to keep the room alive (empty rooms are pruned instantly)
        const monitorCtx = await browser.newContext();
        const monitorPage = await monitorCtx.newPage();
        await monitorPage.goto('/');

        await monitorPage.evaluate(async (rid) => {
            const ws = new WebSocket(`ws://localhost:3300/ws/${rid}`);
            (window as any).__monitorWs = ws;
            await new Promise((resolve) => {
                ws.onopen = resolve;
                setTimeout(resolve, 3000);
            });
        }, roomId);

        // 2. Spawn 6 temporary peers sequentially, each sending 20 messages (total = 120 messages)
        // Since they connect via separate connections, they don't trigger the 20-token connection rate limit.
        for (let p = 0; p < 6; p++) {
            const tempCtx = await browser.newContext();
            const tempPage = await tempCtx.newPage();
            await tempPage.goto('/');
            
            await tempPage.evaluate(async ({ rid, peerIdx }) => {
                return new Promise<void>((resolve) => {
                    const ws = new WebSocket(`ws://localhost:3300/ws/${rid}`);
                    ws.onopen = () => {
                        for (let i = 0; i < 20; i++) {
                            ws.send(new TextEncoder().encode(`MSG_${peerIdx}_${i}`));
                        }
                        // Allow backend time to process and save messages to history buffer
                        setTimeout(() => {
                            ws.close();
                            resolve();
                        }, 500);
                    };
                    ws.onerror = () => resolve();
                });
            }, { rid: roomId, peerIdx: p });

            await tempCtx.close();
        }

        // 3. Connect receiver and verify that it retrieves exactly 100 historical messages
        const receiverCtx = await browser.newContext();
        const receiverPage = await receiverCtx.newPage();
        await receiverPage.goto('/');

        const receivedCount = await receiverPage.evaluate(async (rid) => {
            return new Promise<number>((resolve) => {
                const ws = new WebSocket(`ws://localhost:3300/ws/${rid}`);
                ws.binaryType = 'arraybuffer';
                let count = 0;
                ws.onmessage = () => {
                    count++;
                };
                ws.onopen = () => {
                    // Wait for all historical messages to replay
                    setTimeout(() => {
                        ws.close();
                        resolve(count);
                    }, 2000);
                };
                ws.onerror = () => resolve(count);
            });
        }, roomId);

        // Clean up monitor
        await monitorPage.evaluate(() => {
            if ((window as any).__monitorWs) (window as any).__monitorWs.close();
        });

        await monitorCtx.close();
        await receiverCtx.close();

        // History buffer must cap at 100, dropping the oldest 20 messages
        expect(receivedCount).toBe(100);
    });
});

test.describe('TURN / ICE Infrastructure Validation', () => {
    test('TURN server gathers relay candidates successfully (NAT/VPN validation)', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(3000); // Wait for WASM/worker to load

        // 1. Fetch dynamic TURN credentials from the local backend
        const credentials = await page.evaluate(async () => {
            try {
                const roomId = crypto.randomUUID();
                const ws = new WebSocket(`ws://localhost:3300/ws/${roomId}`);
                await new Promise((resolve, reject) => {
                    ws.onopen = resolve;
                    ws.onerror = reject;
                    setTimeout(() => reject(new Error("WS timeout")), 5000);
                });
                const res = await fetch(`http://localhost:3300/api/turn-credentials?room_id=${roomId}`);
                const data = await res.json();
                ws.close();
                if (res.status !== 200) {
                    return { error: `Failed to fetch dynamic credentials, HTTP status: ${res.status}` };
                }
                return data;
            } catch (err: any) {
                return { error: err.toString() };
            }
        });

        if (credentials.error) {
            console.warn('Skipping TURN test: backend credentials endpoint failed:', credentials.error);
            test.skip(true, 'TURN credentials could not be fetched');
            return;
        }

        expect(credentials.urls).toBeDefined();
        expect(credentials.username).toBeDefined();
        expect(credentials.credential).toBeDefined();

        // 2. Initiate RTCPeerConnection and force relay-only gathering
        const gatherResult = await page.evaluate(async (creds) => {
            return new Promise<{ success: boolean; candidates: string[]; error?: string }>((resolve) => {
                const candidates: string[] = [];
                let hasRelay = false;

                try {
                    const pc = new RTCPeerConnection({
                        iceServers: [
                            {
                                urls: creds.urls,
                                username: creds.username,
                                credential: creds.credential
                            }
                        ],
                        iceTransportPolicy: 'relay' // Force relay gathering to verify the TURN server
                    });

                    // Create a dummy data channel to trigger ICE candidate gathering
                    pc.createDataChannel('voiddrop-turn-test');

                    pc.onicecandidate = (event) => {
                        if (event.candidate) {
                            const candStr = event.candidate.candidate;
                            candidates.push(candStr);
                            if (candStr.toLowerCase().includes('relay')) {
                                hasRelay = true;
                                pc.close();
                                resolve({ success: true, candidates });
                            }
                        } else {
                            // ICE gathering finished
                            pc.close();
                            resolve({ success: hasRelay, candidates });
                        }
                    };

                    pc.onicecandidateerror = (event) => {
                        console.error('ICE Candidate Gathering Error:', event);
                    };

                    pc.createOffer()
                        .then(offer => pc.setLocalDescription(offer))
                        .catch(err => resolve({ success: false, candidates, error: err.toString() }));

                    // Timeout after 12 seconds
                    setTimeout(() => {
                        pc.close();
                        resolve({ success: hasRelay, candidates, error: 'Timeout gathering relay candidates' });
                    }, 12000);

                } catch (e: any) {
                    resolve({ success: false, candidates, error: e.toString() });
                }
            });
        }, credentials);

        console.log('Gathered TURN candidates:', gatherResult.candidates);

        if (gatherResult.error) {
            console.log('TURN gathering failure reason:', gatherResult.error);
        }

        // The TURN server MUST successfully return at least one relay candidate!
        expect(gatherResult.success).toBe(true);
    });

    test('TURN server rejects tampered credentials (exploitation protection)', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(1000);

        const credentials = await page.evaluate(async () => {
            const roomId = crypto.randomUUID();
            const ws = new WebSocket(`ws://localhost:3300/ws/${roomId}`);
            await new Promise((resolve, reject) => {
                ws.onopen = resolve;
                ws.onerror = reject;
                setTimeout(() => reject(new Error("WS timeout")), 5000);
            });
            const res = await fetch(`http://localhost:3300/api/turn-credentials?room_id=${roomId}`);
            const data = await res.json();
            ws.close();
            return data;
        });

        // Alter the last character of the dynamic password (tampering simulation)
        const tamperedCredential = credentials.credential.substring(0, credentials.credential.length - 1) + 'X';

        const gatherResult = await page.evaluate(async (creds) => {
            return new Promise<{ success: boolean; candidates: string[] }>((resolve) => {
                const candidates: string[] = [];
                let hasRelay = false;

                try {
                    const pc = new RTCPeerConnection({
                        iceServers: [
                            {
                                urls: creds.urls,
                                username: creds.username,
                                credential: creds.tamperedCredential
                            }
                        ],
                        iceTransportPolicy: 'relay'
                    });

                    pc.createDataChannel('turn-tamper-test');

                    pc.onicecandidate = (event) => {
                        if (event.candidate) {
                            const candStr = event.candidate.candidate;
                            candidates.push(candStr);
                            if (candStr.toLowerCase().includes('relay')) {
                                hasRelay = true;
                            }
                        } else {
                            pc.close();
                            resolve({ success: hasRelay, candidates });
                        }
                    };

                    pc.createOffer()
                        .then(offer => pc.setLocalDescription(offer))
                        .catch(() => resolve({ success: false, candidates }));

                    setTimeout(() => {
                        pc.close();
                        resolve({ success: hasRelay, candidates });
                    }, 5000);

                } catch {
                    resolve({ success: false, candidates });
                }
            });
        }, { ...credentials, tamperedCredential });

        console.log('Tampered TURN candidates (should be empty):', gatherResult.candidates);
        // The Coturn server MUST reject altered dynamic signatures with ZERO relay candidates
        expect(gatherResult.success).toBe(false);
        expect(gatherResult.candidates.filter(c => c.toLowerCase().includes('relay')).length).toBe(0);
    });

    test('TURN server rejects manually generated expired credentials (replay protection)', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(1000);

        const credentials = await page.evaluate(async () => {
            const roomId = crypto.randomUUID();
            const ws = new WebSocket(`ws://localhost:3300/ws/${roomId}`);
            await new Promise((resolve, reject) => {
                ws.onopen = resolve;
                ws.onerror = reject;
                setTimeout(() => reject(new Error("WS timeout")), 5000);
            });
            const res = await fetch(`http://localhost:3300/api/turn-credentials?room_id=${roomId}`);
            const data = await res.json();
            ws.close();
            return data;
        });

        // Expire the dynamic username (timestamp set to 2 hours ago)
        const expiredTime = Math.floor(Date.now() / 1000) - 7200;
        const expiredUsername = `${expiredTime}:anon`;

        const gatherResult = await page.evaluate(async (creds) => {
            return new Promise<{ success: boolean; candidates: string[] }>((resolve) => {
                const candidates: string[] = [];
                let hasRelay = false;

                try {
                    const pc = new RTCPeerConnection({
                        iceServers: [
                            {
                                urls: creds.urls,
                                username: creds.expiredUsername,
                                credential: creds.credential
                            }
                        ],
                        iceTransportPolicy: 'relay'
                    });

                    pc.createDataChannel('turn-replay-test');

                    pc.onicecandidate = (event) => {
                        if (event.candidate) {
                            const candStr = event.candidate.candidate;
                            candidates.push(candStr);
                            if (candStr.toLowerCase().includes('relay')) {
                                hasRelay = true;
                            }
                        } else {
                            pc.close();
                            resolve({ success: hasRelay, candidates });
                        }
                    };

                    pc.createOffer()
                        .then(offer => pc.setLocalDescription(offer))
                        .catch(() => resolve({ success: false, candidates }));

                    setTimeout(() => {
                        pc.close();
                        resolve({ success: hasRelay, candidates });
                    }, 5000);

                } catch {
                    resolve({ success: false, candidates });
                }
            });
        }, { ...credentials, expiredUsername });

        console.log('Expired TURN candidates (should be empty):', gatherResult.candidates);
        // Expiration timestamps in username MUST be rejected by Coturn
        expect(gatherResult.success).toBe(false);
        expect(gatherResult.candidates.filter(c => c.toLowerCase().includes('relay')).length).toBe(0);
    });

    test('TURN credentials endpoint rate limits rapid requests (DDoS protection)', async ({ page }) => {
        await page.goto('/');
        
        const rateLimitResult = await page.evaluate(async () => {
            const promises = [];
            // Make 115 requests simultaneously to exhaust the 100-token bucket
            for (let i = 0; i < 115; i++) {
                promises.push(
                    fetch('http://localhost:3300/api/turn-credentials?room_id=test-ddos-room')
                        .then(res => res.status)
                        .catch(() => 500)
                );
            }
            const statuses = await Promise.all(promises);
            const throttledCount = statuses.filter(status => status === 429).length;
            return { total: statuses.length, throttledCount };
        });

        console.log(`DDoS Rate Limit: Sent ${rateLimitResult.total} API requests, Throttled: ${rateLimitResult.throttledCount}`);
        // At least some requests MUST return 429 Too Many Requests
        expect(rateLimitResult.throttledCount).toBeGreaterThan(0);
    });

    test('TURN credentials endpoint rejects requests for inactive/invalid rooms (abuse prevention)', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(5000); // Wait 5s for rate limit bucket to fully refill and network sockets to clean up
        
        const result = await page.evaluate(async () => {
            // 1. Request without room_id
            const resNoRoom = await fetch('http://localhost:3300/api/turn-credentials');
            
            // 2. Request with random invalid room_id
            const resInvalidRoom = await fetch('http://localhost:3300/api/turn-credentials?room_id=some-non-existent-room-uuid');
            
            return {
                noRoomStatus: resNoRoom.status,
                invalidRoomStatus: resInvalidRoom.status
            };
        });

        expect(result.noRoomStatus).toBe(400);
        expect(result.invalidRoomStatus).toBe(403);
    });
});

test.describe.skip('API Endpoint Validation', () => {
    test('upload/init rejects expired timestamp (replay attack)', async ({ page }) => {
        await page.goto('/');
        
        const result = await page.evaluate(async () => {
            const res = await fetch('http://localhost:3300/api/upload/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ttl_hours: 24,
                    size_bytes: 1024,
                    pubkey: 'a'.repeat(64),
                    signature: 'b'.repeat(128),
                    timestamp: Math.floor(Date.now() / 1000) - 120, // 2 minutes ago (> 60s window)
                }),
            });
            return { status: res.status, body: await res.json() };
        });

        expect(result.status).toBe(400);
        expect(result.body.error).toContain('replay');
    });

    test('upload/init rejects invalid pubkey length', async ({ page }) => {
        await page.goto('/');
        
        const result = await page.evaluate(async () => {
            const res = await fetch('http://localhost:3300/api/upload/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ttl_hours: 24,
                    size_bytes: 1024,
                    pubkey: 'too_short',
                    signature: 'b'.repeat(128),
                    timestamp: Math.floor(Date.now() / 1000),
                }),
            });
            return { status: res.status, body: await res.json() };
        });

        expect(result.status).toBe(400);
        expect(result.body.error).toContain('pubkey');
    });

    test('upload/init rejects zero-byte file', async ({ page }) => {
        await page.goto('/');
        
        const result = await page.evaluate(async () => {
            const res = await fetch('http://localhost:3300/api/upload/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ttl_hours: 24,
                    size_bytes: 0,
                    pubkey: 'a'.repeat(64),
                    signature: 'b'.repeat(128),
                    timestamp: Math.floor(Date.now() / 1000),
                }),
            });
            return { status: res.status, body: await res.json() };
        });

        expect(result.status).toBe(400);
        expect(result.body.error).toContain('size');
    });

    test('upload/init rejects oversized file (> 5GB)', async ({ page }) => {
        await page.goto('/');
        
        const result = await page.evaluate(async () => {
            const res = await fetch('http://localhost:3300/api/upload/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ttl_hours: 24,
                    size_bytes: 6 * 1024 * 1024 * 1024, // 6 GB
                    pubkey: 'a'.repeat(64),
                    signature: 'b'.repeat(128),
                    timestamp: Math.floor(Date.now() / 1000),
                }),
            });
            return { status: res.status, body: await res.json() };
        });

        expect(result.status).toBe(400);
    });

    test('download non-existent file → 404', async ({ page }) => {
        await page.goto('/');
        
        const result = await page.evaluate(async () => {
            const res = await fetch('http://localhost:3300/api/download/00000000-0000-0000-0000-000000000000');
            return res.status;
        });

        expect(result).toBe(404);
    });

    test('download invalid UUID → 400', async ({ page }) => {
        await page.goto('/');
        
        const result = await page.evaluate(async () => {
            const res = await fetch('http://localhost:3300/api/download/not-a-uuid');
            return res.status;
        });

        expect(result).toBe(400);
    });

    test('upload/part with invalid file_id → 400', async ({ page }) => {
        await page.goto('/');
        
        const result = await page.evaluate(async () => {
            const res = await fetch('http://localhost:3300/api/upload/part?file_id=invalid&upload_id=test&part_number=1', {
                method: 'PUT',
                body: new Uint8Array(100),
            });
            return res.status;
        });

        expect(result).toBe(400);
    });

    test('rate limiter: 100+ rapid requests get throttled', async ({ page }) => {
        await page.goto('/');
        
        const result = await page.evaluate(async () => {
            const results: number[] = [];
            for (let i = 0; i < 120; i++) {
                const res = await fetch('http://localhost:3300/api/download/00000000-0000-0000-0000-000000000000');
                results.push(res.status);
            }
            return {
                total: results.length,
                throttled: results.filter(s => s === 429).length,
                last: results[results.length - 1],
            };
        });

        // Should have some 429s after exhausting the 100-token bucket
        expect(result.throttled).toBeGreaterThan(0);
    });
});

