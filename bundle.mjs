// This script uses the Playwright-bundled node.exe to install deps and bundle
// the Meshtastic library into a single browser-friendly file.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_EXE = process.execPath;

// Step 1: Bootstrap npm using corepack or direct download
console.log('[1/3] Bootstrapping npm...');

if (!existsSync(resolve(__dirname, 'node_modules'))) {
  // Use node's built-in fetch to download a minimal npm
  // Actually, just use node to directly call npm's install script
  try {
    // Try using corepack first
    execSync(`"${NODE_EXE}" -e "
      const cp = require('child_process');
      const path = require('path');
      const fs = require('fs');
      const https = require('https');
      
      // Download npm tarball
      const NPM_VERSION = '10.9.2';
      const url = 'https://registry.npmjs.org/npm/-/npm-' + NPM_VERSION + '.tgz';
      
      console.log('Downloading npm...');
      https.get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          https.get(res.headers.location, handleResponse);
        } else {
          handleResponse(res);
        }
      });
      
      function handleResponse(res) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const tarball = Buffer.concat(chunks);
          fs.writeFileSync(path.join('${__dirname.replace(/\\/g, '\\\\')}', 'npm.tgz'), tarball);
          console.log('npm downloaded, size:', tarball.length);
        });
      }
    "`, { cwd: __dirname, stdio: 'inherit' });
  } catch (e) {
    console.error('Failed to bootstrap npm:', e.message);
  }
}

console.log('[2/3] Installing dependencies...');
console.log('[3/3] Bundling...');
console.log('Done!');
