import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '../../../..');
const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');
const dockerImageWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'docker-image.yml'), 'utf8');
const nextConfig = fs.readFileSync(path.join(repositoryRoot, 'frontend', 'next.config.ts'), 'utf8');
const brandProvider = fs.readFileSync(path.join(repositoryRoot, 'frontend', 'src', 'components', 'BrandProvider.tsx'), 'utf8');
const rootPackage = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as { version: string; scripts: Record<string, string> };
const frontendPackage = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'frontend', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const packScript = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'pack.js'), 'utf8');
const dockerCompose = fs.readFileSync(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8');
const gitignore = fs.readFileSync(path.join(repositoryRoot, '.gitignore'), 'utf8');
const dockerignore = fs.readFileSync(path.join(repositoryRoot, '.dockerignore'), 'utf8');
const readme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
const zhReadme = fs.readFileSync(path.join(repositoryRoot, 'README.zh-CN.md'), 'utf8');
const envExample = fs.readFileSync(path.join(repositoryRoot, 'backend', '.env.example'), 'utf8');
const assetsWorkspace = fs.readFileSync(path.join(repositoryRoot, 'frontend', 'src', 'components', 'assets', 'AssetsWorkspace.tsx'), 'utf8');
const legacyVersionEnv = ['NEXT', 'PUBLIC', 'APP', 'VERSION'].join('_');

function workflowTriggerBlock(workflow: string): string {
  const start = workflow.indexOf('on:');
  const end = workflow.indexOf('\npermissions:');
  return start >= 0 && end > start ? workflow.slice(start, end) : workflow;
}

describe('发布版本到 UI 的传递', () => {
  it('将发布工作流计算出的 tag 版本写入 Docker 构建参数和运行环境变量', () => {
    expect(releaseWorkflow).toContain('APP_VERSION=${{ steps.version.outputs.version }}');
    expect(releaseWorkflow).toContain('APP_VERSION: ${{ steps.version.outputs.version }}');
    expect(releaseWorkflow).toContain('sha=$(git rev-parse HEAD)');
    expect(releaseWorkflow).toContain('org.opencontainers.image.revision=${{ steps.source.outputs.sha }}');
    expect(dockerfile).toContain(`ARG APP_VERSION=${rootPackage.version}`);
    expect(dockerfile).toContain('APP_VERSION=${APP_VERSION}');
    expect(packScript).toContain("process.env.APP_VERSION || backendPkg.version || '1.0.0'");
    expect(packScript).toContain('version: appVersion');
    expect(packScript).toContain('process.env.APP_VERSION = process.env.APP_VERSION ||');
    expect(nextConfig).not.toContain(legacyVersionEnv);
    expect(brandProvider).not.toContain(legacyVersionEnv);
  });

  it('发布版本从 package.json 起算，避免无 tag 仓库回退到 v0.0.1', () => {
    expect(releaseWorkflow).toContain("package_version=\"$(node -p \"require('./package.json').version\")\"");
    expect(releaseWorkflow).toContain('printf "%s\\n%s\\n" "${latest_version}" "${package_version}"');
    expect(releaseWorkflow).toContain('sort -V');
    expect(releaseWorkflow).toContain('base_version="${package_version}"');
  });

  it('打包脚本包含后端启动所需的相对 require 文件', () => {
    expect(packScript).toContain("xai-imagine.js");
  });

  it('打包产物使用 production 模式启动后端', () => {
    expect(packScript).toContain("start: 'node start.js'");
    expect(packScript).toContain("process.env.NODE_ENV = 'production'");
    expect(packScript).not.toContain("start: 'node backend/server.js'");
  });

  it('Compose keeps first startup optional while exposing runtime env through the data volume', () => {
    expect(dockerCompose).not.toContain('./blacklist.json:/app/backend/blacklist.json');
    expect(dockerCompose).not.toContain('./prompts.json:/app/backend/prompts.json');
    expect(dockerCompose).not.toContain('./.env:/app/.env:ro');
    expect(dockerCompose).not.toContain('env_file:');
    expect(dockerCompose).not.toContain('APP_VERSION:');
    expect(dockerCompose).toContain('./data:/app/backend/data');
    expect(readme).toContain('sudo cp backend/.env.example data/.env');
    expect(zhReadme).toContain('sudo cp backend/.env.example data/.env');
  });

  it('publishes and deploys the same GHCR image on repository updates', () => {
    const dockerTriggers = workflowTriggerBlock(dockerImageWorkflow);

    expect(dockerTriggers).toContain('push:');
    expect(dockerTriggers).toContain('branches: [main]');
    expect(dockerImageWorkflow).toContain('push:');
    expect(dockerImageWorkflow).toContain('REGISTRY: ghcr.io');
    expect(dockerImageWorkflow).toContain('IMAGE_NAME: ${{ github.repository }}');
    expect(dockerImageWorkflow).toContain('docker/build-push-action@v6');
    expect(dockerImageWorkflow).toContain('push: true');
    expect(dockerImageWorkflow).toContain('type=raw,value=latest');
    expect(dockerImageWorkflow).toContain('- name: Read package version');
    expect(dockerImageWorkflow).toContain("node -p \"require('./package.json').version\"");
    expect(dockerImageWorkflow).toContain('APP_VERSION=${{ steps.version.outputs.version }}');
    expect(dockerImageWorkflow).not.toContain('APP_VERSION=${{ github.ref_name }}');
    expect(dockerImageWorkflow).not.toContain('enable={{is_default_branch}}');
    expect(dockerCompose).toContain('image: ghcr.io/biubiubiu125/rkapi-image:latest');
    expect(dockerCompose).toContain('pull_policy: always');
    expect(dockerCompose).not.toContain('build:');
    expect(readme).toContain('sudo docker compose pull');
    expect(readme).toContain('sudo docker compose up -d');
    expect(readme).not.toContain('sudo docker compose up -d --build');
    expect(zhReadme).toContain('sudo docker compose pull');
    expect(zhReadme).toContain('sudo docker compose up -d');
    expect(zhReadme).not.toContain('sudo docker compose up -d --build');
  });

  it('keeps tag and GitHub Release creation out of normal repository pushes', () => {
    const releaseTriggers = workflowTriggerBlock(releaseWorkflow);

    expect(releaseTriggers).not.toContain('push:');
    expect(releaseTriggers).toContain('workflow_dispatch:');
    expect(releaseWorkflow).toContain('git push origin "${{ steps.version.outputs.tag }}"');
    expect(releaseWorkflow).toContain('files: out.zip');
  });

  it('keeps manual release artifacts atomic by publishing Docker before tag and release creation', () => {
    const buildZipIndex = releaseWorkflow.indexOf('- name: Build zip package');
    const createTagIndex = releaseWorkflow.indexOf('- name: Create and push tag');
    const createDraftReleaseIndex = releaseWorkflow.indexOf('- name: Create draft GitHub release');
    const dockerPushIndex = releaseWorkflow.indexOf('- name: Build and push Docker image');
    const publishReleaseIndex = releaseWorkflow.indexOf('- name: Publish GitHub release');

    expect(buildZipIndex).toBeGreaterThan(-1);
    expect(dockerPushIndex).toBeGreaterThan(buildZipIndex);
    expect(createTagIndex).toBeGreaterThan(dockerPushIndex);
    expect(createDraftReleaseIndex).toBeGreaterThan(createTagIndex);
    expect(publishReleaseIndex).toBeGreaterThan(createDraftReleaseIndex);
    expect(releaseWorkflow).toContain('draft: true');
    expect(releaseWorkflow).toContain('--draft=false');
  });

  it('production env example keeps persistent paths and no default prompt gallery password', () => {
    expect(envExample).toContain('RKAPI_IMAGE_TASK_DB=/app/backend/data/rkapi-tasks.sqlite');
    expect(envExample).toContain('RKAPI_IMAGE_IMAGE_DIR=/app/backend/data/rkapi-images');
    expect(envExample).toContain('PROMPT_GALLERY_PASSWORD=');
    expect(envExample).not.toContain('PROMPT_GALLERY_PASSWORD=8848');
  });

  it('production scripts start the static export through the backend server', () => {
    expect(rootPackage.scripts.start).toContain('NODE_ENV=production');
    expect(rootPackage.scripts.start).toContain('node server.js');
    expect(frontendPackage.scripts.start).not.toContain('next start');
    expect(frontendPackage.scripts.start).toContain('npm run build');
  });

  it('根目录旧开发脚本仍从当前仓库进入 backend', () => {
    expect(rootPackage.scripts['dev:old']).toContain('cd backend');
    expect(rootPackage.scripts['dev:old']).not.toContain('cd ../backend');
  });

  it('忽略 RKAPI 本地任务数据库和图片目录', () => {
    expect(gitignore).toContain('backend/rkapi-tasks.sqlite*');
    expect(gitignore).toContain('backend/rkapi-images/');
    expect(dockerignore).toContain('backend/rkapi-images/');
    expect(dockerignore).toContain('backend/rkapi-tasks.sqlite');
    expect(dockerignore).toContain('backend/rkapi-tasks.sqlite-wal');
    expect(dockerignore).toContain('backend/rkapi-tasks.sqlite-shm');
  });

  it('README 部署命令包含获取仓库并进入仓库目录的完整步骤', () => {
    expect(readme).toContain('git clone https://github.com/biubiubiu125/rkapi-image.git');
    expect(readme).toContain('cd /opt/rkapi-image');
    expect(readme.indexOf('git clone')).toBeLessThan(readme.indexOf('sudo cp backend/.env.example data/.env'));
    expect(zhReadme).toContain('git clone https://github.com/biubiubiu125/rkapi-image.git');
    expect(zhReadme.indexOf('git clone')).toBeLessThan(zhReadme.indexOf('sudo cp backend/.env.example data/.env'));
  });

  it('打包脚本使用 Node ZIP 实现并避免依赖 PowerShell', () => {
    expect(packScript).toContain('JSZip');
    expect(packScript).toContain('generateAsync');
    expect(packScript).not.toContain('Compress-Archive');
    expect(packScript).not.toContain('powershell');
  });

  it('用户可见导出文件名使用 RKAPI 前缀', () => {
    expect(assetsWorkspace).toContain('rkapi-assets-');
    expect(assetsWorkspace).not.toContain('flyreq-assets-${Date.now()}');
  });
});
