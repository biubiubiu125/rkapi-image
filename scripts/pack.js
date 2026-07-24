const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const BACKEND_DIR = path.join(ROOT, 'backend');
const BACKEND_PACKAGE_LOCK_RELATIVE_PATH = 'backend/package-lock.json';
const TEMP_DIR = path.join(ROOT, 'temp');
const ZIP_PATH = path.join(ROOT, 'out.zip');

// 后端文件列表
const BACKEND_FILES = [
  { src: path.join(BACKEND_DIR, 'server.js'), dest: 'server.js' },
  { src: path.join(BACKEND_DIR, 'xai-imagine.js'), dest: 'xai-imagine.js' },
  { src: path.join(BACKEND_DIR, 'package.json'), dest: 'package.json' },
  { src: path.join(BACKEND_DIR, '.env.example'), dest: '.env.example' },
  { src: path.join(BACKEND_DIR, 'blacklist.json'), dest: 'blacklist.json' },
  { src: path.join(BACKEND_DIR, 'prompts.json'), dest: 'prompts.json' },
];

// 前端构建产物目录
const FRONTEND_OUT_DIR = { src: path.join(FRONTEND_DIR, 'out'), dest: 'out' };

// 1. Build frontend
console.log('[1/4] Building frontend...');
require('child_process').execSync('npm run build', { cwd: FRONTEND_DIR, stdio: 'inherit' });

// 2. Prepare temp directory
console.log('[2/4] Preparing temp/...');
if (fs.existsSync(TEMP_DIR)) {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEMP_DIR, { recursive: true });

// Copy backend files into temp/backend/
const TEMP_BACKEND = path.join(TEMP_DIR, 'backend');
fs.mkdirSync(TEMP_BACKEND, { recursive: true });
for (const file of BACKEND_FILES) {
  if (!fs.existsSync(file.src)) {
    console.warn(`Warning: ${file.dest} not found, skipping.`);
    continue;
  }
  fs.copyFileSync(file.src, path.join(TEMP_BACKEND, file.dest));
}

// Copy frontend out/ folder into temp/frontend/out/
const TEMP_FRONTEND = path.join(TEMP_DIR, 'frontend');
fs.mkdirSync(TEMP_FRONTEND, { recursive: true });
fs.cpSync(FRONTEND_OUT_DIR.src, path.join(TEMP_FRONTEND, 'out'), { recursive: true });

// Generate root package.json for one-command deploy
const backendPkg = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'package.json'), 'utf8'));
const appVersion = process.env.APP_VERSION || backendPkg.version || '1.0.0';
const rootPkg = {
  name: 'rkapi-image',
  version: appVersion,
  private: true,
  description: 'RKAPI Image - 生产部署包',
  scripts: {
    start: 'node start.js',
  },
  dependencies: backendPkg.dependencies,
};
fs.writeFileSync(path.join(TEMP_DIR, 'package.json'), JSON.stringify(rootPkg, null, 2) + '\n');
const backendLock = JSON.parse(fs.readFileSync(path.join(ROOT, BACKEND_PACKAGE_LOCK_RELATIVE_PATH), 'utf8'));
const rootLockPackage = {
  ...(backendLock.packages?.[''] || {}),
  name: rootPkg.name,
  version: appVersion,
  dependencies: backendPkg.dependencies,
};
delete rootLockPackage.devDependencies;
const rootLock = {
  ...backendLock,
  name: rootPkg.name,
  version: appVersion,
  packages: {
    ...(backendLock.packages || {}),
    '': rootLockPackage,
  },
};
fs.writeFileSync(path.join(TEMP_DIR, 'package-lock.json'), JSON.stringify(rootLock, null, 2) + '\n');
fs.writeFileSync(path.join(TEMP_DIR, 'start.js'), [
  "process.env.NODE_ENV = 'production';",
  `process.env.APP_VERSION = process.env.APP_VERSION || ${JSON.stringify(appVersion)};`,
  "require('./backend/server.js');",
  '',
].join('\n'));

// 3. Create out.zip (overwrite if exists)
console.log('[3/4] Creating out.zip...');
if (fs.existsSync(ZIP_PATH)) {
  fs.unlinkSync(ZIP_PATH);
}

async function addDirectory(zip, sourceDir, targetDir = '') {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const zipPath = targetDir ? `${targetDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      zip.folder(zipPath);
      await addDirectory(zip, sourcePath, zipPath);
      continue;
    }
    zip.file(zipPath, fs.readFileSync(sourcePath));
  }
}

async function createZip() {
  const JSZipModule = require(path.join(FRONTEND_DIR, 'node_modules', 'jszip'));
  const JSZip = JSZipModule.default || JSZipModule;
  const zip = new JSZip();
  await addDirectory(zip, TEMP_DIR);
  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(ZIP_PATH, content);
}

async function main() {
  try {
    await createZip();
  } finally {
    // 4. Remove temp/
    console.log('[4/4] Cleaning up temp/...');
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
  console.log('Done! -> out.zip');
}

main().catch((error) => {
  console.error('Failed to create out.zip:', error);
  process.exitCode = 1;
});
