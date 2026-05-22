/**
 * Native file system operations for Tauri desktop app.
 * Falls back to browser download when not running in Tauri.
 */
import { isTauri } from '$lib/isTauri';
export { isTauri };
import type { FileWithMeta } from './fileTree';
import { isJunkFile } from './junkFilter';

// ─── Tauri File shim classes for lazy loading ──────────────────────────

export class TauriFileSlice {
    path: string;
    start: number;
    end: number;

    constructor(path: string, start: number, end: number) {
        this.path = path;
        this.start = start;
        this.end = end;
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        const { open } = await import('@tauri-apps/plugin-fs');
        const handle = await open(this.path, { read: true });
        try {
            // Seek to start position
            // SeekMode.Start is 0
            await handle.seek(this.start, 0);

            const length = this.end - this.start;
            const buffer = new Uint8Array(length);
            let bytesRead = 0;
            while (bytesRead < length) {
                const chunkBuf = new Uint8Array(length - bytesRead);
                const n = await handle.read(chunkBuf);
                if (n === null || n === 0) {
                    break;
                }
                buffer.set(chunkBuf.subarray(0, n), bytesRead);
                bytesRead += n;
            }
            const finalBuffer = bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
            return finalBuffer.buffer.slice(finalBuffer.byteOffset, finalBuffer.byteOffset + finalBuffer.byteLength) as ArrayBuffer;
        } finally {
            await handle.close();
        }
    }
}

export class TauriFile {
    name: string;
    size: number;
    type: string = '';
    path: string;
    webkitRelativePath: string;

    constructor(name: string, size: number, path: string, webkitRelativePath: string = '') {
        this.name = name;
        this.size = size;
        this.path = path;
        this.webkitRelativePath = webkitRelativePath;
    }

    slice(start?: number, end?: number): TauriFileSlice {
        const s = start === undefined ? 0 : start < 0 ? Math.max(0, this.size + start) : Math.min(start, this.size);
        const e = end === undefined ? this.size : end < 0 ? Math.max(0, this.size + end) : Math.min(end, this.size);
        return new TauriFileSlice(this.path, s, e);
    }
}

// ─── Recursive Directory Explorer ─────────────────────────────────────

export async function readDirRecursive(
    dirPath: string,
    relativePath: string = ''
): Promise<FileWithMeta[]> {
    const { readDir, stat } = await import('@tauri-apps/plugin-fs');
    const { join } = await import('@tauri-apps/api/path');

    const entries = await readDir(dirPath);
    const results: FileWithMeta[] = [];

    for (const entry of entries) {
        if (isJunkFile(entry.name)) {
            continue;
        }
        const fullPath = await join(dirPath, entry.name);
        const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory) {
            const subResults = await readDirRecursive(fullPath, relPath);
            results.push(...subResults);
        } else if (entry.isFile) {
            const fileInfo = await stat(fullPath);
            const file = new TauriFile(entry.name, fileInfo.size, fullPath, relPath);
            results.push({
                file: file as unknown as File,
                path: relPath
            });
        }
    }

    return results;
}

export async function getTauriFilesFromPaths(paths: string[]): Promise<FileWithMeta[]> {
    const { stat } = await import('@tauri-apps/plugin-fs');
    const { basename } = await import('@tauri-apps/api/path');

    const results: FileWithMeta[] = [];
    for (const path of paths) {
        const name = await basename(path);
        const fileInfo = await stat(path);
        const file = new TauriFile(name, fileInfo.size, path, name);
        results.push({
            file: file as unknown as File,
            path: name
        });
    }
    return results;
}

// ─── Tauri directory handle shim for P2P / Cloud downloads ─────────────

class TauriWritableFileStream {
    filePath: string;
    isInitialized: boolean = false;
    keepExistingData: boolean = false;
    seekOffset: number = 0;
    handle: any = null;

    constructor(filePath: string, options?: { keepExistingData?: boolean; seekOffset?: number }) {
        this.filePath = filePath;
        this.keepExistingData = !!options?.keepExistingData;
        this.seekOffset = options?.seekOffset ?? 0;
        
        if (this.keepExistingData || this.seekOffset > 0) {
            this.isInitialized = true;
        }
    }

    async write(chunk: Uint8Array): Promise<void> {
        const { open, mkdir } = await import('@tauri-apps/plugin-fs');
        
        if (!this.handle) {
            const lastSlash = this.filePath.lastIndexOf('/');
            const lastBackslash = this.filePath.lastIndexOf('\\');
            const lastIndex = Math.max(lastSlash, lastBackslash);
            if (lastIndex !== -1) {
                const parentDir = this.filePath.substring(0, lastIndex);
                await mkdir(parentDir, { recursive: true }).catch(() => {});
            }

            this.handle = await open(this.filePath, {
                create: true,
                write: true,
                truncate: !this.isInitialized
            });

            this.isInitialized = true;

            if (this.seekOffset > 0) {
                await this.handle.seek(this.seekOffset, 0); // SeekMode.Start is 0
            }
        }

        await this.handle.write(chunk);
    }

    async close(): Promise<void> {
        const { open, mkdir } = await import('@tauri-apps/plugin-fs');
        
        if (this.handle) {
            await this.handle.close();
            this.handle = null;
        } else {
            const lastSlash = this.filePath.lastIndexOf('/');
            const lastBackslash = this.filePath.lastIndexOf('\\');
            const lastIndex = Math.max(lastSlash, lastBackslash);
            if (lastIndex !== -1) {
                const parentDir = this.filePath.substring(0, lastIndex);
                await mkdir(parentDir, { recursive: true }).catch(() => {});
            }
            const h = await open(this.filePath, {
                create: true,
                write: true,
                truncate: !this.isInitialized
            });
            await h.close();
            this.isInitialized = true;
        }
    }
}

class TauriFileHandle {
    filePath: string;
    constructor(filePath: string) {
        this.filePath = filePath;
    }

    async createWritable(options?: { keepExistingData?: boolean; seekOffset?: number }): Promise<TauriWritableFileStream> {
        return new TauriWritableFileStream(this.filePath, options);
    }
}

export function sanitizeRelativePath(path: string): string {
    if (!path) return '';
    
    // Split by both forward slashes and backslashes
    const parts = path.split(/[/\\]/);
    const safeParts: string[] = [];
    
    for (const part of parts) {
        // Strip out colons to neutralize Windows drive letters (e.g. C:) and URI schemes
        const trimmed = part.trim().replace(/:/g, '');
        // Skip empty, '.', or '..' components to prevent traversing up or invalid directory creation
        if (!trimmed || trimmed === '.' || trimmed === '..') {
            continue;
        }
        safeParts.push(trimmed);
    }
    
    return safeParts.join('/');
}

export class TauriDirHandle {
    dirPath: string;
    constructor(dirPath: string) {
        this.dirPath = dirPath;
    }

    async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<TauriDirHandle> {
        const sanitizedName = sanitizeRelativePath(name);
        if (!sanitizedName) {
            throw new Error("Invalid or empty directory name");
        }
        const { join } = await import('@tauri-apps/api/path');
        const nextPath = await join(this.dirPath, sanitizedName);
        if (options?.create) {
            const { mkdir } = await import('@tauri-apps/plugin-fs');
            await mkdir(nextPath, { recursive: true }).catch(() => {});
        }
        return new TauriDirHandle(nextPath);
    }

    async getFileHandle(name: string, options?: { create?: boolean }): Promise<TauriFileHandle> {
        const sanitizedName = sanitizeRelativePath(name);
        if (!sanitizedName) {
            throw new Error("Invalid or empty file name");
        }
        const { join } = await import('@tauri-apps/api/path');
        const filePath = await join(this.dirPath, sanitizedName);
        if (options && options.create === false) {
            const { exists } = await import('@tauri-apps/plugin-fs');
            const fileExists = await exists(filePath);
            if (!fileExists) {
                const err = new Error(`File not found: ${filePath}`);
                err.name = "NotFoundError";
                throw err;
            }
        }
        return new TauriFileHandle(filePath);
    }
}

// ─── Exported Save Operations ─────────────────────────────────────────

/**
 * Save a single file using native Save As dialog (Tauri) or browser download (web).
 */
export async function saveFile(fileName: string, data: Uint8Array | Blob): Promise<void> {
    let safeName = fileName;
    const lastSlash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
    if (lastSlash !== -1) {
        safeName = fileName.substring(lastSlash + 1);
    }
    safeName = safeName.trim();
    if (!safeName || safeName === '..' || safeName === '.') {
        safeName = 'downloaded_file';
    }
    if (isTauri()) {
        return saveFileTauri(safeName, data);
    }
    return saveFileBrowser(safeName, data);
}

/**
 * Save multiple files to a user-selected directory (Tauri only).
 * In browser mode, triggers individual downloads.
 */
export async function saveBundle(
    files: Array<{ name: string; data: Uint8Array | Blob }>
): Promise<void> {
    if (isTauri()) {
        return saveBundleTauri(files);
    }
    // Browser fallback: download each file individually
    for (const file of files) {
        const safeName = sanitizeRelativePath(file.name) || 'downloaded_file';
        await saveFileBrowser(safeName, file.data);
    }
}

// ─── Tauri native implementation ─────────────────────────────────────

async function saveFileTauri(fileName: string, data: Uint8Array | Blob): Promise<void> {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');

    const path = await save({
        defaultPath: fileName,
        filters: [{
            name: 'All Files',
            extensions: ['*'],
        }],
    });

    if (!path) return; // User cancelled

    const bytes = data instanceof Blob
        ? new Uint8Array(await data.arrayBuffer())
        : data;

    await writeFile(path, bytes);
}

async function saveBundleTauri(
    files: Array<{ name: string; data: Uint8Array | Blob }>
): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { writeFile, mkdir } = await import('@tauri-apps/plugin-fs');
    const { join } = await import('@tauri-apps/api/path');

    // Ask user to pick a destination folder
    const dir = await open({
        directory: true,
        title: 'Choose download folder',
    });

    if (!dir) return; // User cancelled

    for (const file of files) {
        const sanitizedName = sanitizeRelativePath(file.name) || 'downloaded_file';
        const filePath = await join(dir as string, sanitizedName);

        // Create subdirectories if the file name contains path separators (supports / and \ for Windows)
        const lastSlash = filePath.lastIndexOf('/');
        const lastBackslash = filePath.lastIndexOf('\\');
        const lastIndex = Math.max(lastSlash, lastBackslash);
        if (lastIndex > (dir as string).length) {
            const subDir = filePath.substring(0, lastIndex);
            await mkdir(subDir, { recursive: true }).catch(() => {});
        }

        const bytes = file.data instanceof Blob
            ? new Uint8Array(await file.data.arrayBuffer())
            : file.data;

        await writeFile(filePath, bytes);
    }
}

// ─── Browser fallback implementation ────────────────────────────────

function saveFileBrowser(fileName: string, data: Uint8Array | Blob): Promise<void> {
    return new Promise((resolve) => {
        const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        
        // Extract basename to prevent iOS Safari from zipping the file if path contains slashes
        let baseName = fileName;
        const lastSlash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
        if (lastSlash !== -1) {
            baseName = fileName.substring(lastSlash + 1);
        }
        a.download = baseName;
        
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(url);
            document.body.removeChild(a);
            resolve();
        }, 100);
    });
}
