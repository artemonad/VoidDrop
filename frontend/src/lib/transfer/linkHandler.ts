import type { TransferState } from './transferState.svelte';
import { joinP2PSession } from './receiverEngine';
import { setupWebRTC } from './cryptoOrchestrator';

/**
 * Handles pasting a VoidDrop link or code to join a P2P session
 */
export function handlePasteLink(s: TransferState, apiBase: string): void {
    if (!s.pasteLinkInput) return;
    let hashContent = "";
    try {
        const url = new URL(s.pasteLinkInput);
        hashContent = url.hash.substring(1);
    } catch {
        if (s.pasteLinkInput.includes("#")) {
            const parts = s.pasteLinkInput.split("#");
            hashContent = parts[parts.length - 1];
        } else {
            hashContent = s.pasteLinkInput;
        }
    }
    hashContent = decodeURIComponent(hashContent.trim());
    let sepIdx = -1;
    for (const sep of [":", ";", "^"]) {
        const idx = hashContent.indexOf(sep);
        if (idx !== -1) {
            sepIdx = idx;
            break;
        }
    }
    if (sepIdx !== -1) {
        const roomId = hashContent.substring(0, sepIdx);
        const pskHex = hashContent.substring(sepIdx + 1);
        if (roomId && pskHex.length === 64) {
            window.location.hash = hashContent;
            if (!s.isWorkerReady) {
                s.showToast("Crypto engine is still loading. Please try again.");
                return;
            }
            s.log("Joining P2P session from pasted link...");
            joinP2PSession(s, roomId, pskHex, (rid: string) =>
                setupWebRTC(s, rid, apiBase),
            );
            return;
        }
    }
    s.showToast("Invalid VoidDrop link");
}
