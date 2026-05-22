/**
 * Utility to identify system junk files that should not be transferred.
 */
export function isJunkFile(filename: string): boolean {
    const lowerName = filename.toLowerCase();
    return (
        lowerName === 'desktop.ini' ||
        lowerName === 'thumbs.db' ||
        lowerName === '.ds_store' ||
        lowerName.startsWith('~$') ||
        lowerName.startsWith('._')
    );
}
