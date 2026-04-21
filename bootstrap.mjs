// Bootstrap: download npm, install deps, ready for Vite
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const npmDir = join(__dirname, '.npm-local');
const npmBin = join(npmDir, 'package', 'bin', 'npm-cli.js');
const NODE = process.execPath;

async function main() {
  // Step 1: Download npm
  if (!existsSync(npmBin)) {
    console.log('[1/3] Downloading npm...');
    mkdirSync(npmDir, { recursive: true });

    const metaRes = await fetch('https://registry.npmjs.org/npm/latest');
    const meta = await metaRes.json();
    console.log(`  npm version: ${meta.version}`);

    const tarballUrl = meta.dist.tarball;
    const res = await fetch(tarballUrl, { redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    const tgzPath = join(npmDir, 'npm.tgz');
    writeFileSync(tgzPath, buf);
    console.log(`  Downloaded ${buf.length} bytes`);

    // Extract using Windows built-in tar
    console.log('  Extracting...');
    execSync(`tar -xzf "${tgzPath}" -C "${npmDir}"`, { stdio: 'inherit' });
  }

  if (!existsSync(npmBin)) {
    console.error('ERROR: npm extraction failed.');
    process.exit(1);
  }
  console.log('[1/3] npm ready');

  // Step 2: Install project dependencies
  console.log('[2/3] Installing dependencies (this may take a minute)...');
  execSync(`"${NODE}" "${npmBin}" install --no-audit --no-fund`, {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, PATH: process.env.PATH }
  });
  console.log('[2/3] Dependencies installed');

  console.log('[3/3] Done! Now kill the Python server and run:');
  console.log(`  & "${NODE}" "${join(npmDir, 'package', 'bin', 'npm-cli.js')}" run dev`);
}

main().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
