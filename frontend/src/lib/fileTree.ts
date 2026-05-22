/**
 * File tree builder and filtering utilities for the upload page.
 * Extracted from +page.svelte to reduce file size.
 */

export type FileWithMeta = {
    file: File;
    path: string;
};

import { isJunkFile } from './junkFilter';

export type TreeNode = {
    name: string;
    path: string;
    isDirectory: boolean;
    children: Record<string, TreeNode>;
    size: number;
    originalIndex?: number;
    allOriginalIndexes: number[];
};

/**
 * Build a hierarchical file tree from a flat list of FileWithMeta items.
 */
export function buildFileTree(files: FileWithMeta[]): TreeNode {
    const root: TreeNode = {
        name: 'root',
        path: '',
        isDirectory: true,
        children: {},
        size: 0,
        allOriginalIndexes: [],
    };

    for (let i = 0; i < files.length; i++) {
        const item = files[i];
        const parts = item.path.split('/');
        let current = root;
        current.size += item.file.size;
        current.allOriginalIndexes.push(i);

        for (let j = 0; j < parts.length; j++) {
            const part = parts[j];
            if (j === parts.length - 1) {
                // Leaf file node
                current.children[part] = {
                    name: part,
                    path: item.path,
                    isDirectory: false,
                    children: {},
                    size: item.file.size,
                    originalIndex: i,
                    allOriginalIndexes: [i],
                };
            } else {
                // Intermediate directory node
                if (!current.children[part]) {
                    current.children[part] = {
                        name: part,
                        path: parts.slice(0, j + 1).join('/'),
                        isDirectory: true,
                        children: {},
                        size: 0,
                        allOriginalIndexes: [],
                    };
                }
                current = current.children[part];
                current.size += item.file.size;
                current.allOriginalIndexes.push(i);
            }
        }
    }
    return root;
}

/**
 * Build a hierarchical file tree from manifest file entries (path + size).
 * Used by the download page where we have no File objects.
 */
export function buildManifestFileTree(files: { path: string; size: number }[]): TreeNode {
    const root: TreeNode = {
        name: 'root',
        path: '',
        isDirectory: true,
        children: {},
        size: 0,
        allOriginalIndexes: [],
    };

    for (let i = 0; i < files.length; i++) {
        const item = files[i];
        const parts = item.path.split('/');
        let current = root;
        current.size += item.size;
        current.allOriginalIndexes.push(i);

        for (let j = 0; j < parts.length; j++) {
            const part = parts[j];
            if (j === parts.length - 1) {
                current.children[part] = {
                    name: part,
                    path: item.path,
                    isDirectory: false,
                    children: {},
                    size: item.size,
                    originalIndex: i,
                    allOriginalIndexes: [i],
                };
            } else {
                if (!current.children[part]) {
                    current.children[part] = {
                        name: part,
                        path: parts.slice(0, j + 1).join('/'),
                        isDirectory: true,
                        children: {},
                        size: 0,
                        allOriginalIndexes: [],
                    };
                }
                current = current.children[part];
                current.size += item.size;
                current.allOriginalIndexes.push(i);
            }
        }
    }
    return root;
}

export type FilteredFile = FileWithMeta & { originalIndex: number };

/**
 * Filter and sort files by search query and sort mode.
 */
export function filterAndSortFiles(
    files: FileWithMeta[],
    searchQuery: string,
    sortMode: string,
): FilteredFile[] {
    return files
        .map((meta, originalIndex) => ({ ...meta, originalIndex }))
        .filter((meta) => meta.path.toLowerCase().includes(searchQuery.toLowerCase()))
        .sort((a, b) => {
            if (sortMode === 'name_asc') return a.path.localeCompare(b.path);
            if (sortMode === 'name_desc') return b.path.localeCompare(a.path);
            if (sortMode === 'size_asc') return a.file.size - b.file.size;
            if (sortMode === 'size_desc') return b.file.size - a.file.size;
            return 0;
        });
}

/**
 * Recursively traverse a dropped directory entry to collect all files.
 * Handles the spec limitation where readEntries() may not return all entries in one call.
 */
export async function traverseDropEntry(entry: any, path: string): Promise<FileWithMeta[]> {
    const results: FileWithMeta[] = [];
    if (isJunkFile(entry.name)) {
        return [];
    }

    if (entry.isFile) {
        const file = await new Promise<File>((resolve) => {
            entry.file((f: File) => resolve(f));
        });
        results.push({ file, path: path + file.name });
    } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let allEntries: any[] = [];
        let batch: any[];
        do {
            batch = await new Promise((resolve) => reader.readEntries(resolve));
            allEntries = allEntries.concat(batch);
        } while (batch.length > 0);

        const subResults = await Promise.all(
            allEntries.map((e) => traverseDropEntry(e, path + entry.name + '/')),
        );
        for (const sub of subResults) {
            results.push(...sub);
        }
    }

    return results;
}

/**
 * Maximum manifest size in bytes (before AEAD encryption overhead).
 * Must fit in the first Range fetch (1MB) minus header (26B), AEAD tag (16B), nonce (24B), stream header (24B).
 */
export const MAX_MANIFEST_BYTES = 900_000;

/**
 * Build a manifest object for the crypto worker.
 */
export function buildManifest(files: FileWithMeta[], totalSize: number) {
    const isSingle = files.length === 1;
    let name: string | undefined = undefined;
    if (files.length > 0) {
        const firstPath = files[0].path;
        const parts = firstPath.split('/');
        if (parts.length > 1) {
            const potentialName = parts[0];
            const allShareFirstSegment = files.every((f) => f.path.startsWith(potentialName + '/'));
            if (allShareFirstSegment && potentialName.trim() !== '') {
                name = potentialName;
            }
        }
        if (!name) {
            const firstFile = files[0].file.name;
            const lastDot = firstFile.lastIndexOf('.');
            const baseName = lastDot > 0 ? firstFile.substring(0, lastDot) : firstFile;
            name = `${baseName}-bundle`;
        }
    }

    return {
        type: isSingle ? 'single' : 'bundle',
        name,
        totalSize,
        files: files.map((f) => ({
            path: f.path,
            size: f.file.size,
            mime: f.file.type || undefined,
        })),
    };
}

/**
 * Estimate the CBOR-encoded size of the manifest.
 * Conservative: actual CBOR is slightly smaller due to compact integer encoding.
 */
export function estimateManifestSize(files: FileWithMeta[]): number {
    // Base overhead: type string, totalSize number, "files" array key
    let size = 30;
    for (const f of files) {
        // Per-file: CBOR map overhead (~10B) + path + size (8B) + mime
        size += 10 + new TextEncoder().encode(f.path).length + 8;
        if (f.file.type) size += new TextEncoder().encode(f.file.type).length + 5;
    }
    return size;
}
