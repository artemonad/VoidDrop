import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const buildDir = path.join(__dirname, 'build');

function processHtmlFile(filePath) {
    console.log(`Processing CSP for ${filePath}...`);
    let content = fs.readFileSync(filePath, 'utf8');

    // Find all inline scripts: <script>...</script> without src attribute
    const scriptRegex = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    const hashes = [];

    while ((match = scriptRegex.exec(content)) !== null) {
        const scriptContent = match[1];
        // Calculate SHA-256 hash of the exact script content
        const hash = crypto.createHash('sha256').update(scriptContent).digest('base64');
        hashes.push(`'sha256-${hash}'`);
    }

    if (hashes.length === 0) {
        console.log(`No inline scripts found in ${filePath}`);
        return;
    }

    console.log(`Found inline scripts with hashes:`, hashes);

    // Find Content Security Policy meta tag
    // Example: <meta http-equiv="content-security-policy" content="...">
    const cspRegex = /(<meta\s+http-equiv="content-security-policy"\s+content=")([^"]+)("\s*\/?>)/i;
    
    content = content.replace(cspRegex, (m, prefix, cspContent, suffix) => {
        // Parse the CSP content
        // Directives are separated by semicolons
        const directives = cspContent.split(';').map(d => d.trim()).filter(Boolean);
        
        let scriptSrcIndex = directives.findIndex(d => d.startsWith('script-src'));
        if (scriptSrcIndex !== -1) {
            let scriptSrc = directives[scriptSrcIndex];
            
            // Remove existing hashes to avoid duplicates or outdated hashes
            const tokens = scriptSrc.split(/\s+/).filter(t => !t.startsWith("'sha256-"));
            
            // Append the new hashes
            tokens.push(...hashes);
            directives[scriptSrcIndex] = tokens.join(' ');
        } else {
            // If script-src is not present, add it
            directives.push(`script-src 'self' ${hashes.join(' ')}`);
        }
        
        const newCspContent = directives.join('; ');
        console.log(`Updated CSP: ${newCspContent}`);
        return `${prefix}${newCspContent}${suffix}`;
    });

    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Successfully updated CSP for ${filePath}`);
}

function walkDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            walkDir(fullPath);
        } else if (file.endsWith('.html')) {
            processHtmlFile(fullPath);
        }
    }
}

if (fs.existsSync(buildDir)) {
    walkDir(buildDir);
} else {
    console.error(`Build directory ${buildDir} does not exist.`);
}
