#!/usr/bin/env node

const path = require('path');
const fs = require('fs-extra');

async function copyDirectory(source, destination, label) {
  await fs.remove(destination);
  await fs.ensureDir(path.dirname(destination));
  await fs.copy(source, destination, { overwrite: true });
  console.log(`[copy-proprietary-ui] Copied ${label} -> ${path.relative(process.cwd(), destination)}`);
}

async function resolveExistingPath(label, candidates) {
  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      console.log(`[copy-proprietary-ui] Located ${label} at ${candidate}`);
      return candidate;
    }
  }

  console.error(
    `[copy-proprietary-ui] Unable to locate ${label}. Checked locations:\n${candidates
      .map((candidate) => ` - ${candidate}`)
      .join('\n')}`,
  );
  return null;
}

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const libSrcDir = path.join(rootDir, 'lib', 'src');

  if (!(await fs.pathExists(libSrcDir))) {
    console.error('[copy-proprietary-ui] Missing build output at lib/src. Run "npx tsc -b" before copying proprietary UI.');
    process.exit(1);
  }

  const packageRoot = path.join(rootDir, 'node_modules', 'appium-device-farm');

  const sourcePublicDir = await resolveExistingPath('UI assets', [
    path.join(packageRoot, 'lib', 'src', 'public'),
    path.join(packageRoot, 'lib', 'public'),
  ]);

  const sourceModulesDir = await resolveExistingPath('server modules', [
    path.join(packageRoot, 'lib', 'src', 'modules'),
    path.join(packageRoot, 'lib', 'modules'),
  ]);

  if (!sourcePublicDir || !sourceModulesDir) {
    console.error(
      '[copy-proprietary-ui] Proprietary assets are missing. Ensure you have installed the licensed package: npm install appium-device-farm',
    );
    process.exit(1);
  }

  const destPublicDir = path.join(libSrcDir, 'public');
  const destModulesDir = path.join(libSrcDir, 'modules');

  await copyDirectory(sourcePublicDir, destPublicDir, 'public assets');
  await copyDirectory(sourceModulesDir, destModulesDir, 'module assets');

  console.log('[copy-proprietary-ui] Proprietary UI assets copied successfully.');
}

main().catch((error) => {
  console.error('[copy-proprietary-ui] Unexpected error while copying proprietary UI files.');
  console.error(error);
  process.exit(1);
});
