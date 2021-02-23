#!/usr/bin/env node
const fs = require('fs-extra');
const execa = require('execa');
const { join } = require('path');

async function main() {
  const outDir = join(__dirname, 'dist');

  // Start fresh
  await fs.remove(outDir);

  // Build with `ncc`
  await execa(
    'ncc',
    [
      'build',
      'index.ts',
      '-e',
      '@vercel/build-utils',
      '-e',
      '@now/build-utils',
      '-o',
      outDir,
    ],
    {
      stdio: 'inherit',
    }
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
