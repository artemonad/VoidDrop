<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { page } from '$app/stores';
	import { env } from '$env/dynamic/public';
	import { buildManifestFileTree } from '$lib/fileTree';
	import { isTauri } from '$lib/isTauri';
	import { saveFile as tauriSaveFile } from '$lib/tauriFs';
	import FileExplorer from '$lib/components/FileExplorer.svelte';
	import JSZip from 'jszip';

	let worker: Worker;
	let isWorkerReady = $state(false);
	
	let connectionLogs: string[] = $state([]);
	let flowState: 'LOADING' | 'READY' | 'STREAMING' | 'DONE' | 'ERROR' = $state('LOADING');

	let wakeLock: any = null;
	async function requestWakeLock() {
		try {
			if ("wakeLock" in navigator) {
				wakeLock = await (navigator as any).wakeLock.request("screen");
			}
		} catch { /* non-critical */ }
	}
	function releaseWakeLock() {
		if (wakeLock) { wakeLock.release(); wakeLock = null; }
	}

	$effect(() => {
		if (flowState === 'STREAMING') {
			requestWakeLock();
		} else if (flowState === 'DONE' || flowState === 'ERROR') {
			releaseWakeLock();
		}
	});

	let bytesTransferred = $state(0);
	let fileTotalSize = $state(0);
	let fileName = $state('');
	let fileStreamWriter: any = $state(null);
	let receiverSaveLocationName = $state('');

	let toastMessage = $state('');
	let toastTimer: ReturnType<typeof setTimeout> | null = null;
	function showToast(msg: string) {
		toastMessage = msg;
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => { toastMessage = ''; }, 4000);
	}

	let psk: Uint8Array;
	let downloadUrl = "";
	let s3Offset = 0;
	let rawBytesFetched = 0;

	// Deframing buffer
	let streamBuffer = new Uint8Array(0);

	// Fallback: collect decrypted chunks in memory if File System Access API unavailable
	let fallbackChunks: Uint8Array[] = [];
	let fallbackBundleFiles: { path: string; chunks: Uint8Array[] }[] = [];
	let useFallback = $state(false);
	let fileMime = '';

	// Bundle state
	let receiverManifest: any = $state(null);
	let receiverDirHandle: any = $state(null);
	let receiverFileIndex = $state(0);
	let receiverFileBytesWritten = $state(0);
	let isBundle = $state(false);
	let selectedFilesState: boolean[] = $state([]);
	let selectedTotalSize = $derived.by(() => {
		if (isBundle && receiverManifest) {
			return receiverManifest.files.reduce((sum: number, file: any, i: number) => sum + (selectedFilesState[i] ? file.size : 0), 0);
		}
		return fileTotalSize;
	});
	let selectedFilesCount = $derived.by(() => {
		if (isBundle && selectedFilesState) {
			return selectedFilesState.filter(Boolean).length;
		}
		return 1;
	});
	let currentPage = $state(0);

	// FileExplorer view state
	let searchQuery = $state('');
	let sortMode = $state('name_asc');
	let viewMode = $state<'list' | 'tree'>('list');
	let treeOpenState = $state(new Set<string>());

	// Derived: build tree and file entries for FileExplorer
	let fileTree = $derived.by(() => {
		if (!receiverManifest?.files) return { name: 'root', path: '', isDirectory: true, children: {}, size: 0, allOriginalIndexes: [] as number[] };
		return buildManifestFileTree(receiverManifest.files);
	});

	let explorerFiles = $derived(
		(receiverManifest?.files || []).map((file: any, i: number) => ({
			path: file.path,
			size: file.size,
			originalIndex: i,
		}))
	);

	function log(msg: string) {
		connectionLogs = [...connectionLogs, `[${new Date().toLocaleTimeString()}] ${msg}`];
	}

	let scrollEl: HTMLDivElement | undefined = undefined;
	$effect(() => {
		if (connectionLogs.length && scrollEl) {
			tick().then(() => {
				if (scrollEl) {
					scrollEl.scrollTop = scrollEl.scrollHeight;
					setTimeout(() => {
						if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
					}, 0);
				}
			});
		}
	});

	onDestroy(() => {
		if (worker) worker.terminate();
	});

	onMount(async () => {
		const fileId = $page.params.id;
		const hash = window.location.hash.substring(1);
		
		if (!hash || !fileId) {
			flowState = 'ERROR';
			log("Invalid link. Missing Decryption Key or File ID.");
			return;
		}

		if (!/^[0-9a-fA-F]+$/.test(hash) || hash.length < 64) {
			flowState = 'ERROR';
			log("Invalid decryption key format. The link may be corrupted.");
			return;
		}
		psk = new Uint8Array(hash.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
		log("Link Parsed. Extracted PSK locally.");

		worker = new Worker(new URL('$lib/worker/crypto.worker.ts', import.meta.url), { type: 'module' });
		
		worker.onmessage = async (e: MessageEvent) => {
			const { type, payload } = e.data;
			
			if (type === 'WASM_LOADED') {
				isWorkerReady = true;
				await fetchAndDecryptManifest(fileId);
			}
			else if (type === 'RESULT_DECRYPT_MANIFEST') {
				receiverManifest = payload;
				isBundle = payload.type === 'bundle' && payload.files.length > 1;
				fileTotalSize = payload.totalSize;
				receiverFileIndex = 0;
				receiverFileBytesWritten = 0;
				
				if (isBundle) {
					fileName = `${payload.files.length} files`;
					selectedFilesState = new Array(payload.files.length).fill(true);
					log(`Manifest Unlocked: Bundle (${payload.files.length} files, ${(payload.totalSize/1024/1024).toFixed(2)} MB)`);
				} else {
					fileName = payload.files[0].path;
					fileMime = payload.files[0].mime || 'application/octet-stream';
					log(`Manifest Unlocked: ${fileName} (${(payload.totalSize/1024/1024).toFixed(2)} MB)`);
				}
				flowState = 'READY';
				log(isBundle ? "Click 'Save Files' to choose a directory." : "Click 'Save File' to begin secure download.");
			}
			else if (type === 'RESULT_CHUNK') {
				if (payload && payload.length > 0) {
					if (isBundle && receiverManifest) {
						await writeBundleChunk(payload);
					} else if (useFallback) {
						fallbackChunks.push(new Uint8Array(payload));
						bytesTransferred += payload.length;
					} else if (fileStreamWriter) {
						await fileStreamWriter.write(payload);
						bytesTransferred += payload.length;
					}
					
					if (bytesTransferred >= fileTotalSize) {
						if (useFallback) {
							if (isBundle && receiverManifest) {
								log("Assembling ZIP archive in RAM (diskless mode)...");
								const zip = new JSZip();
								for (const item of fallbackBundleFiles) {
									if (!item) continue;
									const totalLen = item.chunks.reduce((s, c) => s + c.length, 0);
									const fileData = new Uint8Array(totalLen);
									let offset = 0;
									for (const chunk of item.chunks) {
										fileData.set(chunk, offset);
										offset += chunk.length;
									}
									zip.file(item.path, fileData);
								}
								const zipBlob = await zip.generateAsync({ type: "blob" });
								const zipName = receiverManifest.name ? `${receiverManifest.name}.zip` : "voiddrop-bundle.zip";
								
								if (isTauri()) {
									const bytes = new Uint8Array(await zipBlob.arrayBuffer());
									await tauriSaveFile(zipName, bytes);
								} else {
									const url = URL.createObjectURL(zipBlob);
									const a = document.createElement('a');
									a.href = url;
									a.download = zipName;
									a.click();
									URL.revokeObjectURL(url);
								}
								fallbackBundleFiles = [];
							} else {
								const blob = new Blob(fallbackChunks as BlobPart[], { type: fileMime });
								if (isTauri()) {
									const bytes = new Uint8Array(await blob.arrayBuffer());
									await tauriSaveFile(fileName, bytes);
								} else {
									const url = URL.createObjectURL(blob);
									const a = document.createElement('a');
									a.href = url;
									a.download = fileName;
									a.click();
									URL.revokeObjectURL(url);
								}
								fallbackChunks = [];
							}
						} else if (fileStreamWriter) {
							await fileStreamWriter.close();
						}
						fileStreamWriter = null;
						flowState = 'DONE';
						const savedCount = selectedFilesState.filter(Boolean).length;
						log(isBundle ? `DOWNLOAD COMPLETE! ${savedCount} file(s) saved.` : "DOWNLOAD COMPLETE! File verified and saved.");
						// Burn-on-read is handled server-side — no client notification needed
					}
				}
			}
			else if (type === 'ERROR') {
				log(`Crypto Error: ${payload}`);
				flowState = 'ERROR';
			}
		};
	});

	// triggerBurnAfterReading removed — burn-on-read is now enforced server-side in download_get

	async function fetchAndDecryptManifest(fileId: string) {
		try {
			log(`Validating Cloud Allocation...`);
			
			const apiBase = env.PUBLIC_API_BASE || 'https://api.voiddrop.ru';
			downloadUrl = `${apiBase}/api/download/${fileId}`;
			log(`Target located. Fetching Cryptographic Manifest...`);
			
			// Fetch first 1MB to decode header + manifest.
			// Fixed constant Range ensures the server cannot distinguish bundles from single files.
			const rangeRes = await fetch(downloadUrl, { headers: { 'Range': 'bytes=0-1048575' } });
			if (!rangeRes.ok) throw new Error("Metadata Fetch Failed: " + await rangeRes.text());
			const buffer = await rangeRes.arrayBuffer();
			const data = new Uint8Array(buffer);
			
			const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
			const manifestLen = view.getUint32(22, true);
			
			const header = data.slice(0, 26);
			const manifestCiphertext = data.slice(26, 26 + manifestLen);
			const streamHeader = data.slice(26 + manifestLen, 26 + manifestLen + 24);
			
			s3Offset = 26 + manifestLen + 24;
			
			worker.postMessage({ 
				id: 'init_dec', 
				type: 'INIT_OFFLINE_DECRYPT',
                sessionId: fileId,
				payload: { psk, header, manifestCiphertext, streamHeader, fileId } 
			});

		} catch (err) {
			log(`Download Error: ${err}`);
			flowState = 'ERROR';
		}
	}

	async function openFileInDir(rootDir: any, relativePath: string): Promise<any> {
		if (!rootDir) {
			throw new Error("No root directory specified for writing files.");
		}
		const parts = relativePath.split('/');
		let dirHandle = rootDir;
		
		if (!rootDir._dirCache) {
			rootDir._dirCache = new Map();
		}
		const cache = rootDir._dirCache;
		let currentPath = "";
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i];
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			if (cache.has(currentPath)) {
				dirHandle = cache.get(currentPath);
			} else {
				dirHandle = await dirHandle.getDirectoryHandle(part, { create: true });
				cache.set(currentPath, dirHandle);
			}
		}
		
		let baseName = parts[parts.length - 1];
		let ext = "";
		const dotIdx = baseName.lastIndexOf(".");
		if (dotIdx !== -1) {
			ext = baseName.substring(dotIdx);
			baseName = baseName.substring(0, dotIdx);
		}

		let fileHandle: any = null;
		let nameToTry = parts[parts.length - 1];
		let counter = 1;

		while (true) {
			try {
				// Check if file already exists
				fileHandle = await dirHandle.getFileHandle(nameToTry, { create: false });
				// If it succeeded, it exists. Try a new name.
				nameToTry = `${baseName} (${counter})${ext}`;
				counter++;
			} catch (e: any) {
				// If it throws NotFoundError, it does not exist, so we can create it
				if (e.name === 'NotFoundError') {
					try {
						fileHandle = await dirHandle.getFileHandle(nameToTry, { create: true });
					} catch (createErr: any) {
						throw new Error(`Failed to create file "${nameToTry}": ${createErr.message || createErr}`);
					}
					break;
				} else {
					// If it's another error, try creating it directly
					try {
						fileHandle = await dirHandle.getFileHandle(nameToTry, { create: true });
					} catch (createErr: any) {
						throw new Error(`Failed to create file "${nameToTry}": ${createErr.message || createErr}`);
					}
					break;
				}
			}
		}

		return fileHandle.createWritable();
	}

	async function writeBundleChunk(data: Uint8Array) {
		if (!receiverManifest) return;
		let remaining = data;
		while (remaining.length > 0) {
			// Skip zero-byte files to prevent infinite loop
			while (receiverFileIndex < receiverManifest.files.length &&
				   receiverManifest.files[receiverFileIndex].size === 0) {
				const isSelected = selectedFilesState[receiverFileIndex];
				if (isSelected) {
					if (useFallback) {
						if (!fallbackBundleFiles[receiverFileIndex]) {
							fallbackBundleFiles[receiverFileIndex] = {
								path: receiverManifest.files[receiverFileIndex].path,
								chunks: []
							};
						}
					} else if (receiverDirHandle) {
						try {
							const tempWriter = await openFileInDir(receiverDirHandle, receiverManifest.files[receiverFileIndex].path);
							await tempWriter.close();
						} catch (e) {
							console.warn("Failed to create empty file:", e);
						}
					}
				}
				fileStreamWriter = null;
				receiverFileBytesWritten = 0;
				receiverFileIndex++;
				await new Promise(resolve => setTimeout(resolve, 0));
			}
			if (receiverFileIndex >= receiverManifest.files.length) break;

			const currentFile = receiverManifest.files[receiverFileIndex];
			const bytesLeft = currentFile.size - receiverFileBytesWritten;
			const isSelected = selectedFilesState[receiverFileIndex];

			if (isSelected) {
				if (useFallback) {
					if (!fallbackBundleFiles[receiverFileIndex]) {
						fallbackBundleFiles[receiverFileIndex] = {
							path: currentFile.path,
							chunks: []
						};
					}
				} else if (!fileStreamWriter) {
					if (receiverDirHandle) {
						try {
							fileStreamWriter = await openFileInDir(receiverDirHandle, currentFile.path);
						} catch (err) {
							console.warn("Failed to create file, falling back to ZIP:", err);
							log("Error creating file on disk (Downloads folder may be protected). Switching to RAM ZIP...");
							useFallback = true;
							receiverSaveLocationName = receiverManifest.files.length > 1 ? 'RAM ZIP (In-Memory)' : 'RAM (In-Memory)';
							if (!fallbackBundleFiles || fallbackBundleFiles.length === 0) {
								fallbackBundleFiles = new Array(receiverManifest.files.length);
							}
							fallbackBundleFiles[receiverFileIndex] = {
								path: currentFile.path,
								chunks: []
							};
						}
					}
				}
			}

			if (remaining.length <= bytesLeft) {
				if (isSelected) {
					if (useFallback) {
						fallbackBundleFiles[receiverFileIndex].chunks.push(remaining);
					} else if (fileStreamWriter) {
						try {
							await fileStreamWriter.write(remaining);
						} catch (writeErr) {
							console.warn("Failed to write, falling back to ZIP:", writeErr);
							log("Error writing to disk. Switching to RAM ZIP...");
							useFallback = true;
							receiverSaveLocationName = receiverManifest.files.length > 1 ? 'RAM ZIP (In-Memory)' : 'RAM (In-Memory)';
							if (!fallbackBundleFiles || fallbackBundleFiles.length === 0) {
								fallbackBundleFiles = new Array(receiverManifest.files.length);
							}
							fallbackBundleFiles[receiverFileIndex] = {
								path: currentFile.path,
								chunks: [remaining]
							};
							try { await fileStreamWriter.close(); } catch {}
							fileStreamWriter = null;
						}
					}
				}
				bytesTransferred += remaining.length;
				receiverFileBytesWritten += remaining.length;
				
				if (receiverFileBytesWritten === currentFile.size) {
					if (isSelected && !useFallback && fileStreamWriter) {
						try { await fileStreamWriter.close(); } catch {}
					}
					fileStreamWriter = null;
					receiverFileBytesWritten = 0;
					receiverFileIndex++;
				}
				remaining = new Uint8Array(0);
			} else {
				if (bytesLeft > 0) {
					if (isSelected) {
						if (useFallback) {
							fallbackBundleFiles[receiverFileIndex].chunks.push(remaining.slice(0, bytesLeft));
						} else if (fileStreamWriter) {
							try {
								await fileStreamWriter.write(remaining.slice(0, bytesLeft));
							} catch (writeErr) {
								console.warn("Failed to write, falling back to ZIP:", writeErr);
								log("Error writing to disk. Switching to RAM ZIP...");
								useFallback = true;
								receiverSaveLocationName = 'RAM ZIP (In-Memory)';
								if (!fallbackBundleFiles || fallbackBundleFiles.length === 0) {
									fallbackBundleFiles = new Array(receiverManifest.files.length);
								}
								fallbackBundleFiles[receiverFileIndex] = {
									path: currentFile.path,
									chunks: [remaining.slice(0, bytesLeft)]
								};
								try { await fileStreamWriter.close(); } catch {}
								fileStreamWriter = null;
							}
						}
					}
					bytesTransferred += bytesLeft;
				}
				if (isSelected && !useFallback && fileStreamWriter) {
					try {
						await fileStreamWriter.close();
					} catch {}
				}
				fileStreamWriter = null;
				receiverFileBytesWritten = 0;
				receiverFileIndex++;
				remaining = remaining.slice(bytesLeft);
			}
		}

		// Trailing zero-byte files check
		while (receiverFileIndex < receiverManifest.files.length &&
			   receiverManifest.files[receiverFileIndex].size === 0) {
			const isSelected = selectedFilesState[receiverFileIndex];
			if (isSelected) {
				if (useFallback) {
					if (!fallbackBundleFiles[receiverFileIndex]) {
						fallbackBundleFiles[receiverFileIndex] = {
							path: receiverManifest.files[receiverFileIndex].path,
							chunks: []
						};
					}
				} else if (receiverDirHandle) {
					try {
						const tempWriter = await openFileInDir(receiverDirHandle, receiverManifest.files[receiverFileIndex].path);
						await tempWriter.close();
					} catch (e) {
						console.warn("Failed to create trailing empty file:", e);
					}
				}
			}
			fileStreamWriter = null;
			receiverFileBytesWritten = 0;
			receiverFileIndex++;
			await new Promise(resolve => setTimeout(resolve, 0));
		}
	}

	async function startDownload() {
		try {
			if (isBundle) {
				if (isTauri()) {
					// Tauri: use native folder picker
					const { open } = await import('@tauri-apps/plugin-dialog');
					const dir = await open({ directory: true, title: 'Choose download folder' });
					if (!dir) { log('Save cancelled.'); return; }
					const { TauriDirHandle } = await import('$lib/tauriFs');
					receiverDirHandle = new TauriDirHandle(dir);
					useFallback = false;
					const folderName = dir.substring(Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\')) + 1) || dir;
					receiverSaveLocationName = folderName;
					log(`Streaming bundle to directory (native)...`);
				} else if ('showDirectoryPicker' in window) {
					// Browser: use File System Access API
					try {
						receiverDirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
						useFallback = false;
						receiverSaveLocationName = receiverDirHandle.name;
						log(`Streaming bundle to directory...`);
					} catch (pickerErr: any) {
						console.warn("Directory picker error or blocked folder, falling back to RAM ZIP:", pickerErr);
						if (pickerErr?.name === 'SecurityError') {
							log("Browser blocks access to the root Downloads folder. Create a subfolder (e.g. Downloads/VoidDrop) and select it, or continue downloading as a ZIP archive.");
							showToast("Root Downloads folder is blocked by browser. Select a subfolder.");
						} else {
							log("Browser system protection is active or access denied. Downloading as a single ZIP archive...");
						}
						useFallback = true;
						receiverSaveLocationName = receiverManifest.files.length > 1 ? 'RAM ZIP (In-Memory)' : 'RAM (In-Memory)';
						fallbackBundleFiles = new Array(receiverManifest.files.length);
					}
				} else {
					log("Browser does not support folder selection. Downloading as a single ZIP archive...");
					useFallback = true;
					receiverSaveLocationName = receiverManifest.files.length > 1 ? 'RAM ZIP (In-Memory)' : 'RAM (In-Memory)';
					fallbackBundleFiles = new Array(receiverManifest.files.length);
				}
			} else if (isTauri()) {
				// Tauri single file: use native Save As, collect in memory
				useFallback = true;
				fallbackChunks = [];
				receiverSaveLocationName = 'Local Disk (System Default)';
				log(`Streaming to native file system...`);
			} else if ('showSaveFilePicker' in window) {
				try {
					const handle = await (window as any).showSaveFilePicker({ suggestedName: fileName });
					fileStreamWriter = await handle.createWritable();
					useFallback = false;
					receiverSaveLocationName = handle.name;
					log(`Streaming directly to disk...`);
				} catch (pickerErr: any) {
					console.warn("Save file picker error, falling back to RAM:", pickerErr);
					if (pickerErr?.name === 'SecurityError') {
						log("Browser blocks access to the selected file. Downloading to RAM...");
						showToast("Selected file is blocked by the browser. Downloading to RAM...");
					} else {
						log("Browser system protection is active. Downloading to RAM...");
					}
					useFallback = true;
					receiverSaveLocationName = 'RAM (In-Memory)';
					fallbackChunks = [];
				}
			} else {
				useFallback = true;
				receiverSaveLocationName = 'RAM (In-Memory)';
				fallbackChunks = [];
				log(`Using in-memory download (no streaming API)...`);
			}
			flowState = 'STREAMING';
			startBodyStream();
		} catch (err) {
			log("File save picker cancelled.");
		}
	}

	async function startBodyStream(retryCount = 0) {
		try {
			log(retryCount === 0 ? "Initiating encrypted body stream..." : `Resuming stream (Attempt ${retryCount})...`);
			const res = await fetch(downloadUrl, { headers: { 'Range': `bytes=${s3Offset + rawBytesFetched}-` } });
			if (!res.ok) throw new Error("Stream Fetch Failed: " + await res.text());
			const reader = res.body!.getReader();
			
			while (true) {
				const { done, value } = await reader.read();
				
				if (value) {
					rawBytesFetched += value.length;
					const temp = new Uint8Array(streamBuffer.length + value.length);
					temp.set(streamBuffer, 0);
					temp.set(value, streamBuffer.length);
					streamBuffer = temp;
				}

				// Deframe loop based on 4-byte length prefix
				while (streamBuffer.length >= 4) {
					const nextChunkLen = new DataView(streamBuffer.buffer, streamBuffer.byteOffset, streamBuffer.byteLength).getUint32(0, true);
					const totalRequired = 4 + nextChunkLen;

					if (streamBuffer.length >= totalRequired) {
						const completeChunk = streamBuffer.slice(0, totalRequired);
						worker.postMessage({ id: 'dec_chunk', type: 'DECRYPT_CHUNK', sessionId: $page.params.id, payload: { chunk: completeChunk, isFinal: false } });
						streamBuffer = streamBuffer.slice(totalRequired);
					} else {
						break;
					}
				}

				if (done) {
					if (streamBuffer.length > 0) log(`Warning: Stream ended with ${streamBuffer.length} unprocessed bytes.`);
					worker.postMessage({ id: 'done', type: 'STREAM_DONE', sessionId: $page.params.id });
					break;
				}
			}
		} catch (err) {
			log(`Stream Error: ${err}`);
			if (retryCount < 5) {
				// Discard incomplete frame buffer — mid-frame data would corrupt the secretstream state
				if (streamBuffer.length > 0) {
					log(`Discarding ${streamBuffer.length} bytes of incomplete frame data from broken connection.`);
					rawBytesFetched -= streamBuffer.length; // Re-fetch these bytes
					streamBuffer = new Uint8Array(0);
				}
				log(`Connection dropped. Resuming in 3 seconds...`);
				setTimeout(() => startBodyStream(retryCount + 1), 3000);
			} else {
				flowState = 'ERROR';
			}
		}
	}
</script>

<main class="container">
	<div class="glass-panel text-center">
		{#if flowState === 'LOADING'}
			<h2 class="animate-pulse">Locating File Geometry...</h2>
		{:else if flowState === 'READY'}
			<h2>File Ready</h2>
			<p class="file-info">{fileName}</p>
			{#if isBundle && receiverManifest}
				<p class="text-muted" style="margin-bottom: 1rem;">
					{selectedFilesCount} file{selectedFilesCount !== 1 ? 's' : ''} — {(selectedTotalSize / 1024 / 1024).toFixed(2)} MB total
				</p>
			{:else}
				<p class="text-muted">{(fileTotalSize / 1024 / 1024).toFixed(2)} MB — End-to-end encrypted</p>
			{/if}
			
			{#if isBundle && receiverManifest}
				<FileExplorer
					files={explorerFiles}
					{fileTree}
					mode="receiver"
					bind:viewMode
					bind:searchQuery
					bind:sortMode
					bind:currentPage
					bind:treeOpenState
					bind:selectedFiles={selectedFilesState}
				/>
			{/if}

			<button class="btn-download" onclick={startDownload} disabled={isBundle && !selectedFilesState.some(s => s)}>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
					<polyline points="7 10 12 15 17 10"></polyline>
					<line x1="12" y1="15" x2="12" y2="3"></line>
				</svg>
				{isBundle ? 'Save Files' : 'Save File'}
			</button>
		{:else if flowState === 'STREAMING'}
			<h2 style="color: #4ade80">Secure Download Active</h2>
			
			{#if fileTotalSize > 0}
				<div class="progress-bar-container">
					<div class="progress-bar" style="width: {(bytesTransferred / fileTotalSize) * 100}%"></div>
				</div>
				<p class="text-muted">
					{(bytesTransferred / 1024 / 1024).toFixed(1)} MB / {(fileTotalSize / 1024 / 1024).toFixed(1)} MB
				</p>
			{/if}

			{#if receiverManifest && receiverManifest.files}
				{@const currentFile = receiverManifest.files[receiverFileIndex]}
				{#if currentFile}
					<div class="current-transfer-info" style="margin-top: 1.2rem; font-size: 0.85rem; color: var(--color-text-muted); height: 90px; display: flex; flex-direction: column; justify-content: center; box-sizing: border-box; overflow-y: auto;">
						<p>
							Saving: <span style="color: #ffffff; font-family: monospace; word-break: break-all;">{currentFile.path}</span>
							<span style="color: var(--color-accent); font-weight: bold;"> &rarr; </span>
							<span style="color: var(--color-text-muted);">
								{receiverSaveLocationName || 'none'}
							</span>
						</p>
						<p style="margin-top: 0.25rem;">File {receiverFileIndex + 1} of {receiverManifest.files.length}</p>
					</div>
				{/if}
			{:else}
				<div class="current-transfer-info" style="margin-top: 1.2rem; font-size: 0.85rem; color: var(--color-text-muted); height: 90px; display: flex; flex-direction: column; justify-content: center; box-sizing: border-box; overflow-y: auto;">
					<p>Saving: <span style="color: #ffffff; font-family: monospace; word-break: break-all;">{fileName}</span>
						<span style="color: var(--color-accent); font-weight: bold;"> &rarr; </span>
						<span style="color: var(--color-text-muted);">
							{receiverSaveLocationName || 'none'}
						</span>
					</p>
				</div>
			{/if}
		{:else if flowState === 'DONE'}
			<h2 style="color: #4ade80">Download Complete!</h2>
			<p class="text-muted">File has been successfully secured to disk.</p>
		{:else if flowState === 'ERROR'}
			<h2 style="color: #ef4444">Error</h2>
			<p class="text-muted">Connection failed or file is unavailable.</p>
		{/if}

		<div class="logs-panel mt-4" bind:this={scrollEl}>
			{#each connectionLogs as msg}
				<div class="log-line">{msg}</div>
			{/each}
		</div>
	</div>
</main>

{#if toastMessage}
	<div class="toast">{toastMessage}</div>
{/if}

<style>
	.container { max-width: 720px; margin: 4rem auto; padding: 2rem; }
	.glass-panel { padding: 3rem; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; }
	.text-center { text-align: center; }
	.mt-4 { margin-top: 2rem; }
	h2 { margin-bottom: 0.5rem; font-weight: 600; }
	.text-muted { color: #a1a1aa; }
	.animate-pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
	@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
	
	.file-info {
		font-size: 1.2rem;
		font-weight: 600;
		color: #e4e4e7;
		margin: 0.5rem 0 0.25rem;
		word-break: break-all;
	}

	.btn-download {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1.5rem;
		padding: 0.85rem 2.5rem;
		background: linear-gradient(135deg, #8b5cf6, #d946ef);
		color: white;
		border: none;
		border-radius: 10px;
		font-size: 1.05rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s ease;
	}
	.btn-download:hover:not(:disabled) {
		filter: brightness(1.15);
		transform: translateY(-2px);
		box-shadow: 0 6px 20px rgba(139, 92, 246, 0.35);
	}
	.btn-download:disabled {
		opacity: 0.5;
		cursor: not-allowed;
		filter: grayscale(1);
	}

	.progress-bar-container { background: rgba(255,255,255,0.1); height: 8px; border-radius: 4px; overflow: hidden; margin: 1.5rem 0 0.5rem; }
	.progress-bar { background: #4ade80; height: 100%; transition: width 0.1s linear; }
	
	.logs-panel { text-align: left; background: rgba(0,0,0,0.4); padding: 1rem; border-radius: 8px; max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 0.8rem; color: #d4d4d8; }
	.log-line { border-bottom: 1px solid rgba(255,255,255,0.02); padding: 2px 0; }

	.toast {
		position: fixed;
		bottom: 2rem;
		left: 50%;
		transform: translateX(-50%);
		background: rgba(139, 92, 246, 0.9);
		backdrop-filter: blur(12px);
		color: #fff;
		padding: 0.75rem 1.5rem;
		border-radius: 12px;
		font-size: 0.9rem;
		font-weight: 500;
		z-index: 9999;
		animation: toastIn 0.3s ease;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
	}
	@keyframes toastIn {
		from {
			opacity: 0;
			transform: translateX(-50%) translateY(1rem);
		}
		to {
			opacity: 1;
			transform: translateX(-50%) translateY(0);
		}
	}
</style>
