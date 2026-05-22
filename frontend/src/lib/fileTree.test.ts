import { describe, it, expect } from 'vitest';
import {
    buildFileTree,
    buildManifestFileTree,
    filterAndSortFiles,
    buildManifest,
    estimateManifestSize,
    MAX_MANIFEST_BYTES,
    type FileWithMeta,
    type TreeNode,
} from './fileTree';

// ─── Helper: create a mock File ───
function mockFile(name: string, size: number, type = ''): File {
    const buffer = new ArrayBuffer(size);
    return new File([buffer], name, { type });
}

function mockFileWithMeta(path: string, size: number, type = ''): FileWithMeta {
    return { file: mockFile(path.split('/').pop()!, size, type), path };
}

// ═══════════════════════════════════════════════════════
// buildFileTree — Sender file tree from FileWithMeta[]
// ═══════════════════════════════════════════════════════
describe('buildFileTree', () => {
    it('empty list → root with no children', () => {
        const tree = buildFileTree([]);
        expect(tree.name).toBe('root');
        expect(tree.isDirectory).toBe(true);
        expect(Object.keys(tree.children).length).toBe(0);
        expect(tree.size).toBe(0);
        expect(tree.allOriginalIndexes).toEqual([]);
    });

    it('single flat file → one leaf child', () => {
        const files = [mockFileWithMeta('readme.txt', 100)];
        const tree = buildFileTree(files);

        expect(Object.keys(tree.children).length).toBe(1);
        expect(tree.children['readme.txt'].isDirectory).toBe(false);
        expect(tree.children['readme.txt'].size).toBe(100);
        expect(tree.children['readme.txt'].originalIndex).toBe(0);
        expect(tree.size).toBe(100);
    });

    it('multiple flat files → all direct children of root', () => {
        const files = [
            mockFileWithMeta('a.txt', 10),
            mockFileWithMeta('b.txt', 20),
            mockFileWithMeta('c.txt', 30),
        ];
        const tree = buildFileTree(files);

        expect(Object.keys(tree.children).length).toBe(3);
        expect(tree.size).toBe(60);
        expect(tree.allOriginalIndexes).toEqual([0, 1, 2]);
    });

    it('nested directory structure builds correct hierarchy', () => {
        const files = [
            mockFileWithMeta('docs/report.pdf', 500),
            mockFileWithMeta('docs/notes.txt', 200),
            mockFileWithMeta('images/cat.jpg', 1000),
        ];
        const tree = buildFileTree(files);

        expect(tree.children['docs'].isDirectory).toBe(true);
        expect(tree.children['docs'].size).toBe(700);
        expect(tree.children['docs'].allOriginalIndexes).toEqual([0, 1]);
        expect(tree.children['images'].isDirectory).toBe(true);
        expect(tree.children['images'].children['cat.jpg'].size).toBe(1000);
        expect(tree.size).toBe(1700);
    });

    it('deeply nested paths (5+ levels)', () => {
        const files = [
            mockFileWithMeta('a/b/c/d/e/deep.txt', 42),
        ];
        const tree = buildFileTree(files);

        let node: TreeNode = tree;
        for (const part of ['a', 'b', 'c', 'd', 'e']) {
            expect(node.children[part]).toBeDefined();
            expect(node.children[part].isDirectory).toBe(true);
            node = node.children[part];
        }
        expect(node.children['deep.txt'].isDirectory).toBe(false);
        expect(node.children['deep.txt'].size).toBe(42);
    });

    it('files with same directory prefix are grouped', () => {
        const files = [
            mockFileWithMeta('src/main.ts', 100),
            mockFileWithMeta('src/utils.ts', 200),
            mockFileWithMeta('src/lib/helper.ts', 300),
        ];
        const tree = buildFileTree(files);

        const src = tree.children['src'];
        expect(src.isDirectory).toBe(true);
        expect(src.allOriginalIndexes).toEqual([0, 1, 2]);
        expect(src.children['main.ts'].isDirectory).toBe(false);
        expect(src.children['lib'].isDirectory).toBe(true);
        expect(src.children['lib'].children['helper.ts'].size).toBe(300);
    });

    it('sizes propagate correctly up the tree', () => {
        const files = [
            mockFileWithMeta('a/x.bin', 100),
            mockFileWithMeta('a/b/y.bin', 200),
            mockFileWithMeta('a/b/c/z.bin', 300),
        ];
        const tree = buildFileTree(files);

        expect(tree.size).toBe(600);
        expect(tree.children['a'].size).toBe(600);
        expect(tree.children['a'].children['b'].size).toBe(500);
        expect(tree.children['a'].children['b'].children['c'].size).toBe(300);
    });

    it('zero-byte files are included', () => {
        const files = [mockFileWithMeta('empty.txt', 0)];
        const tree = buildFileTree(files);

        expect(tree.children['empty.txt'].size).toBe(0);
        expect(tree.size).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════
// buildManifestFileTree — Download page tree from path+size
// ═══════════════════════════════════════════════════════
describe('buildManifestFileTree', () => {
    it('builds same structure as buildFileTree for matching data', () => {
        const manifestFiles = [
            { path: 'docs/a.txt', size: 100 },
            { path: 'docs/b.txt', size: 200 },
            { path: 'img/c.jpg', size: 300 },
        ];
        const tree = buildManifestFileTree(manifestFiles);

        expect(tree.size).toBe(600);
        expect(tree.children['docs'].isDirectory).toBe(true);
        expect(tree.children['docs'].size).toBe(300);
        expect(tree.children['img'].children['c.jpg'].originalIndex).toBe(2);
    });

    it('empty list → empty root', () => {
        const tree = buildManifestFileTree([]);
        expect(Object.keys(tree.children).length).toBe(0);
        expect(tree.size).toBe(0);
    });

    it('allOriginalIndexes are correctly propagated', () => {
        const files = [
            { path: 'folder/a.txt', size: 10 },
            { path: 'folder/b.txt', size: 20 },
            { path: 'other/c.txt', size: 30 },
        ];
        const tree = buildManifestFileTree(files);

        expect(tree.allOriginalIndexes).toEqual([0, 1, 2]);
        expect(tree.children['folder'].allOriginalIndexes).toEqual([0, 1]);
        expect(tree.children['other'].allOriginalIndexes).toEqual([2]);
    });
});

// ═══════════════════════════════════════════════════════
// filterAndSortFiles
// ═══════════════════════════════════════════════════════
describe('filterAndSortFiles', () => {
    const files: FileWithMeta[] = [
        mockFileWithMeta('alpha.txt', 300),
        mockFileWithMeta('beta.png', 100),
        mockFileWithMeta('gamma.doc', 200),
    ];

    it('no filter, sort by name asc', () => {
        const result = filterAndSortFiles(files, '', 'name_asc');
        expect(result.map(f => f.path)).toEqual(['alpha.txt', 'beta.png', 'gamma.doc']);
    });

    it('no filter, sort by name desc', () => {
        const result = filterAndSortFiles(files, '', 'name_desc');
        expect(result.map(f => f.path)).toEqual(['gamma.doc', 'beta.png', 'alpha.txt']);
    });

    it('no filter, sort by size asc', () => {
        const result = filterAndSortFiles(files, '', 'size_asc');
        expect(result.map(f => f.path)).toEqual(['beta.png', 'gamma.doc', 'alpha.txt']);
    });

    it('no filter, sort by size desc', () => {
        const result = filterAndSortFiles(files, '', 'size_desc');
        expect(result.map(f => f.path)).toEqual(['alpha.txt', 'gamma.doc', 'beta.png']);
    });

    it('filter by query (case-insensitive)', () => {
        const result = filterAndSortFiles(files, 'ALPHA', 'name_asc');
        expect(result.length).toBe(1);
        expect(result[0].path).toBe('alpha.txt');
    });

    it('filter returns empty when no match', () => {
        const result = filterAndSortFiles(files, 'nonexistent', 'name_asc');
        expect(result.length).toBe(0);
    });

    it('preserves originalIndex', () => {
        const result = filterAndSortFiles(files, '', 'size_desc');
        expect(result[0].originalIndex).toBe(0); // alpha.txt was index 0
        expect(result[2].originalIndex).toBe(1); // beta.png was index 1
    });

    it('filter with partial match', () => {
        const result = filterAndSortFiles(files, '.png', 'name_asc');
        expect(result.length).toBe(1);
        expect(result[0].path).toBe('beta.png');
    });

    it('empty file list → empty result', () => {
        expect(filterAndSortFiles([], 'query', 'name_asc')).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════
// buildManifest
// ═══════════════════════════════════════════════════════
describe('buildManifest', () => {
    it('single file → type "single"', () => {
        const files = [mockFileWithMeta('solo.bin', 1024, 'application/octet-stream')];
        const manifest = buildManifest(files, 1024);

        expect(manifest.type).toBe('single');
        expect(manifest.totalSize).toBe(1024);
        expect(manifest.files.length).toBe(1);
        expect(manifest.files[0].path).toBe('solo.bin');
        expect(manifest.files[0].size).toBe(1024);
        expect(manifest.files[0].mime).toBe('application/octet-stream');
    });

    it('multiple files → type "bundle"', () => {
        const files = [
            mockFileWithMeta('a.txt', 10),
            mockFileWithMeta('b.txt', 20),
        ];
        const manifest = buildManifest(files, 30);

        expect(manifest.type).toBe('bundle');
        expect(manifest.totalSize).toBe(30);
        expect(manifest.files.length).toBe(2);
    });

    it('preserves file paths and sizes', () => {
        const files = [
            mockFileWithMeta('docs/report.pdf', 5000),
            mockFileWithMeta('images/photo.jpg', 3000),
        ];
        const manifest = buildManifest(files, 8000);

        expect(manifest.files[0].path).toBe('docs/report.pdf');
        expect(manifest.files[0].size).toBe(5000);
        expect(manifest.files[1].path).toBe('images/photo.jpg');
        expect(manifest.files[1].size).toBe(3000);
    });

    it('files with no mime → undefined mime', () => {
        const files = [mockFileWithMeta('unknown', 100)];
        const manifest = buildManifest(files, 100);
        expect(manifest.files[0].mime).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════
// estimateManifestSize
// ═══════════════════════════════════════════════════════
describe('estimateManifestSize', () => {
    it('empty file list → only base overhead', () => {
        expect(estimateManifestSize([])).toBe(30);
    });

    it('short filename → small estimate', () => {
        const files = [mockFileWithMeta('a.txt', 10)];
        const size = estimateManifestSize(files);
        expect(size).toBeGreaterThan(30);
        expect(size).toBeLessThan(100);
    });

    it('many files → large estimate', () => {
        const files = Array.from({ length: 1000 }, (_, i) =>
            mockFileWithMeta(`file_${i}.bin`, 100)
        );
        const size = estimateManifestSize(files);
        expect(size).toBeGreaterThan(10000);
    });

    it('files with mime increase estimate', () => {
        const filesNoMime = [mockFileWithMeta('a.txt', 10)];
        const filesWithMime = [mockFileWithMeta('a.txt', 10, 'text/plain')];
        expect(estimateManifestSize(filesWithMime)).toBeGreaterThan(
            estimateManifestSize(filesNoMime)
        );
    });

    it('unicode filenames increase estimate', () => {
        const ascii = [mockFileWithMeta('abc.txt', 10)];
        const unicode = [mockFileWithMeta('documents/réport.txt', 10)];
        expect(estimateManifestSize(unicode)).toBeGreaterThan(
            estimateManifestSize(ascii)
        );
    });

    it('MAX_MANIFEST_BYTES is 900KB', () => {
        expect(MAX_MANIFEST_BYTES).toBe(900_000);
    });
});
