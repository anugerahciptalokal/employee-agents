import esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';

const distDir = path.resolve(process.cwd(), 'dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

const enterpriseEntry = path.resolve(process.cwd(), 'packages/enterprise/src/server.ts');
const ossEntry = path.resolve(process.cwd(), 'packages/backend/src/server/standalone.ts');
const entryPoint = fs.existsSync(enterpriseEntry) ? enterpriseEntry : ossEntry;

console.log(`[build-server] Bundling ${path.relative(process.cwd(), entryPoint)} with esbuild...`);

try {
  await esbuild.build({
    entryPoints: [entryPoint],
    outfile: 'dist/server.mjs',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    sourcemap: true,
    alias: {
      '@shared': path.resolve(process.cwd(), 'packages/contracts/src'),
      '@backend': path.resolve(process.cwd(), 'packages/backend/src'),
      '@enterprise': path.resolve(process.cwd(), 'packages/enterprise/src')
    },
    external: [
      'better-sqlite3',
      'electron',
      'fsevents'
    ],
    banner: {
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`
    }
  });

  console.log('[build-server] Server successfully bundled to dist/server.mjs');
} catch (err) {
  console.error('[build-server] Build failed:', err);
  process.exit(1);
}
