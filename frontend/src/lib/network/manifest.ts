import { encode, decode } from 'cbor-x';

export interface FileEntry {
    path: string;
    size: number;
    mime?: string;
}

export interface ContainerManifest {
    type: 'single' | 'bundle';
    totalSize: number;
    files: FileEntry[];
}

export function encodeManifest(manifest: ContainerManifest): Uint8Array {
    return encode(manifest);
}

export function decodeManifest(buffer: Uint8Array): ContainerManifest {
    return decode(buffer) as ContainerManifest;
}
