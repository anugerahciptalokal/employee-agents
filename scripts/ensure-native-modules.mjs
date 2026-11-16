#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] || 'node';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = ['rebuild', 'better-sqlite3'];

if (target === 'electron') {
  const electronPackage = JSON.parse(
    readFileSync(resolve(root, 'node_modules/electron/package.json'), 'utf-8')
  );
  args.push(
    '--runtime=electron',
    `--target=${electronPackage.version}`,
    '--dist-url=https://electronjs.org/headers'
  );
}

console.log(
  `[native] Preparing better-sqlite3 for ${target}${
    target === 'electron' ? ` ${args.find((arg) => arg.startsWith('--target='))}` : ''
  }`
);

execFileSync(npm, args, {
  cwd: root,
  stdio: 'inherit'
});
