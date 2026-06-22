'use client';

import JSZip from 'jszip';
import localforage from 'localforage';

export interface BackupProgress {
    percent: number;
    message: string;
}

export type ProgressCallback = (progress: BackupProgress) => void;

type BackupRecord = Record<string, unknown>;
type DatabaseBackup = Record<string, BackupRecord[]>;
type IndexedDBBackup = Record<string, DatabaseBackup>;
type BlobRef = { _blobRef: string; _blobMimeType: string };

function isBackupRecord(value: unknown): value is BackupRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlobRef(value: unknown): value is BlobRef {
    return isBackupRecord(value)
        && typeof value['_blobRef'] === 'string'
        && typeof value['_blobMimeType'] === 'string';
}

// localStorage keys to backup
const LOCAL_STORAGE_KEYS = [
    'nova-model-registry',
    'nova-jobs',
    'nova-t2i-settings',
    'nova-i2i-settings',
    'nova-reverse-prompt-settings',
    'theme',
    'nova-wide-mode',
    // Agent 模式
    'nova-agent-params',
    'nova-agent-web-search',
    'nova-agent-intent-recognition',
    // 动图生成
    'nova-gif-settings',
    'nova-gif-active-job',
    // 我的素材
    'nova-assets-settings',
    // 无限画布生成配置
    'nova-image:canvas_config',
];

// IndexedDB databases to backup
const INDEXEDDB_DATABASES = [
    { name: 'nova-image-db', version: 2, stores: ['images', 'blobs'] },
    { name: 'nova-reverse-db', version: 1, stores: ['reverse-results'] },
    { name: 'nova-upload-cache', version: 1, stores: ['images'] },
    // Agent 模式对话、图片登记、元信息
    { name: 'nova-agent-db', version: 1, stores: ['messages', 'images', 'meta'] },
    // 本地图片素材库
    { name: 'nova-assets-db', version: 1, stores: ['assets', 'asset-blobs'] },
];

// localforage keyless 实例（无限画布：项目状态 + 图片 blob）。
// 通用 IndexedDB 逻辑面向 keyPath store，无法 round-trip localforage 的无 keyPath store，故单独处理。
const LOCALFORAGE_STORES: { name: string; storeName: string }[] = [
    { name: 'nova-image', storeName: 'canvas_app_state' },
    { name: 'nova-image', storeName: 'canvas_image_files' },
];

type LocalForageEntry = { key: string; value: unknown } | { key: string; _blobRef: string; _blobMimeType: string };
type LocalForageBackup = Record<string, Record<string, LocalForageEntry[]>>;

/**
 * 导出 localforage（keyless）store：保留 key；Blob 值以二进制存入 ZIP blobs/，JSON 内留引用。
 */
async function exportLocalForage(zip: JSZip): Promise<LocalForageBackup> {
    const result: LocalForageBackup = {};
    for (const cfg of LOCALFORAGE_STORES) {
        try {
            const instance = localforage.createInstance({ name: cfg.name, storeName: cfg.storeName });
            const entries: LocalForageEntry[] = [];
            await instance.iterate((value: unknown, key: string) => {
                if (value instanceof Blob) {
                    const ref = nextBlobRef();
                    zip.file(`blobs/${ref}`, value);
                    entries.push({ key, _blobRef: ref, _blobMimeType: value.type });
                } else {
                    entries.push({ key, value });
                }
            });
            if (!result[cfg.name]) result[cfg.name] = {};
            result[cfg.name][cfg.storeName] = entries;
        } catch {
            // skip failed localforage export
        }
    }
    return result;
}

/**
 * 导入 localforage（keyless）store：先清空，再按 key 写回；Blob 从 ZIP 还原。
 */
async function importLocalForage(data: LocalForageBackup, zip: JSZip): Promise<void> {
    for (const cfg of LOCALFORAGE_STORES) {
        const entries = data[cfg.name]?.[cfg.storeName];
        if (!Array.isArray(entries)) continue;
        try {
            const instance = localforage.createInstance({ name: cfg.name, storeName: cfg.storeName });
            await instance.clear();
            for (const entry of entries) {
                let value: unknown;
                if ('_blobRef' in entry && typeof entry._blobRef === 'string') {
                    const zipEntry = zip.file(`blobs/${entry._blobRef}`);
                    if (!zipEntry) continue;
                    const arrayBuffer = await zipEntry.async('arraybuffer');
                    value = new Blob([arrayBuffer], { type: entry._blobMimeType });
                } else {
                    value = (entry as { value: unknown }).value;
                }
                await instance.setItem(entry.key, value);
            }
        } catch {
            // skip failed localforage import
        }
    }
}

/**
 * 导出 localStorage 数据
 */
function exportLocalStorage(): Record<string, string> {
    const data: Record<string, string> = {};

    for (const key of LOCAL_STORAGE_KEYS) {
        try {
            const value = localStorage.getItem(key);
            if (value !== null) {
                data[key] = value;
            }
        } catch {
            // skip failed localStorage export
        }
    }

    return data;
}

/**
 * 打开 IndexedDB 数据库
 */
function openDatabase(name: string, version: number, createStores: boolean = false): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') {
            resolve(null);
            return;
        }

        const request = indexedDB.open(name, version);

        request.onerror = () => resolve(null);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (e) => {
            const db = (e.target as IDBOpenDBRequest).result;
            const oldVersion = e.oldVersion || 0;
            if (!createStores && oldVersion > 0) return;

            // 根据数据库名称创建相应的 stores
            if (name === 'nova-image-db') {
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('blobs')) {
                    db.createObjectStore('blobs', { keyPath: 'key' });
                }
            } else if (name === 'nova-reverse-db') {
                if (!db.objectStoreNames.contains('reverse-results')) {
                    db.createObjectStore('reverse-results', { keyPath: 'slot' });
                }
            } else if (name === 'nova-upload-cache') {
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'key' });
                }
            } else if (name === 'nova-agent-db') {
                if (!db.objectStoreNames.contains('messages')) {
                    db.createObjectStore('messages', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'imgId' });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }
            } else if (name === 'nova-assets-db') {
                if (!db.objectStoreNames.contains('assets')) {
                    const store = db.createObjectStore('assets', { keyPath: 'id' });
                    store.createIndex('hash', 'hash', { unique: false });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }
                if (!db.objectStoreNames.contains('asset-blobs')) {
                    db.createObjectStore('asset-blobs', { keyPath: 'key' });
                }
            }
        };
    });
}

/**
 * 导出单个 IndexedDB store 的所有数据
 * Blob 字段以二进制文件存入 ZIP，JSON 中只保留引用
 */
async function exportStore(db: IDBDatabase, storeName: string, zip: JSZip): Promise<BackupRecord[]> {
    return new Promise((resolve, reject) => {
        try {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();

            request.onsuccess = async () => {
                const records = request.result;

                const processedRecords = await Promise.all(
                    records.map(async (record) => {
                        const processed = { ...record };

                        // 遍历所有字段，将 Blob 类型以二进制存入 ZIP
                        for (const key of Object.keys(processed)) {
                            const val = processed[key];
                            if (val instanceof Blob) {
                                const ref = nextBlobRef();
                                zip.file(`blobs/${ref}`, val);
                                processed[key] = { _blobRef: ref, _blobMimeType: val.type };
                            }
                        }

                        return processed;
                    })
                );

                resolve(processedRecords);
            };

            request.onerror = () => reject(request.error);
        } catch (error) {
            reject(error);
        }
    });
}

// 用于生成导出时 Blob 的唯一引用 ID
let _blobRefSeq = 0;
function nextBlobRef(): string {
    return `b${Date.now()}_${++_blobRefSeq}`;
}

/**
 * 导出所有 IndexedDB 数据
 */
async function exportIndexedDB(zip: JSZip, onProgress?: ProgressCallback): Promise<IndexedDBBackup> {
    const allData: IndexedDBBackup = {};
    let completedStores = 0;
    const totalStores = INDEXEDDB_DATABASES.reduce((sum, db) => sum + db.stores.length, 0);

    for (const dbConfig of INDEXEDDB_DATABASES) {
        const db = await openDatabase(dbConfig.name, dbConfig.version);

        if (!db) {
            continue;
        }

        const dbData: DatabaseBackup = {};

        for (const storeName of dbConfig.stores) {
            try {
                if (!db.objectStoreNames.contains(storeName)) {
                    continue;
                }

                const storeData = await exportStore(db, storeName, zip);
                dbData[storeName] = storeData;

                completedStores++;
                if (onProgress) {
                    const percent = 10 + Math.floor((completedStores / totalStores) * 80);
                    onProgress({
                        percent,
                        message: `正在导出 ${dbConfig.name}/${storeName}...`,
                    });
                }
            } catch {
                // store export failed, continue with next
            }
        }

        db.close();
        allData[dbConfig.name] = dbData;
    }

    return allData;
}

/**
 * 导出所有数据为 ZIP 文件
 */
export async function exportAllData(onProgress?: ProgressCallback): Promise<Blob> {
    if (onProgress) {
        onProgress({ percent: 0, message: '开始导出数据...' });
    }

    // 导出 localStorage
    if (onProgress) {
        onProgress({ percent: 5, message: '正在导出 localStorage...' });
    }
    const localStorageData = exportLocalStorage();

    // 导出 IndexedDB（传入 zip，blob 字段直接以二进制存入 blobs/ 目录）
    const zip = new JSZip();
    const indexedDBData = await exportIndexedDB(zip, onProgress);
    const localForageData = await exportLocalForage(zip);

    // 打包元数据和 localStorage JSON
    if (onProgress) {
        onProgress({ percent: 90, message: '正在打包数据...' });
    }

    // 添加元数据
    zip.file('metadata.json', JSON.stringify({
        version: process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0',
        exportDate: new Date().toISOString(),
        appName: 'Nova Image',
    }, null, 2));

    // 添加 localStorage 数据
    zip.file('localStorage.json', JSON.stringify(localStorageData, null, 2));

    // 添加 IndexedDB 数据
    const indexedDBFolder = zip.folder('indexedDB');
    if (indexedDBFolder) {
        for (const [dbName, dbData] of Object.entries(indexedDBData)) {
            indexedDBFolder.file(`${dbName}.json`, JSON.stringify(dbData, null, 2));
        }
    }

    // 添加 localforage（无限画布）数据
    const localforageFolder = zip.folder('localforage');
    if (localforageFolder) {
        for (const [dbName, dbData] of Object.entries(localForageData)) {
            localforageFolder.file(`${dbName}.json`, JSON.stringify(dbData, null, 2));
        }
    }

    if (onProgress) {
        onProgress({ percent: 95, message: '正在生成 ZIP 文件...' });
    }

    const blob = await zip.generateAsync({ type: 'blob' });

    if (onProgress) {
        onProgress({ percent: 100, message: '导出完成！' });
    }

    return blob;
}

/**
 * 从 base64 字符串创建 Blob
 */
function base64ToBlob(base64: string, mimeType: string): Blob {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);

    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }

    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
}

/**
 * 导入 localStorage 数据（带校验）
 */
function importLocalStorage(data: unknown): void {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;

    const allowedKeySet = new Set(LOCAL_STORAGE_KEYS);
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        if (!allowedKeySet.has(key)) continue;
        if (typeof value !== 'string') continue;

        if (key === 'nova-model-registry') {
            try {
                const parsed = JSON.parse(value);
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    continue;
                }
                const record = parsed as Record<string, unknown>;
                const hasImageModels = Array.isArray(record.imageModels);
                const hasTextModels = Array.isArray(record.textModels);
                const hasDefaults = typeof record.defaults === 'object' && record.defaults !== null;
                if (!hasImageModels || !hasTextModels || !hasDefaults) {
                    continue;
                }
            } catch {
                continue;
            }
        }

        try {
            localStorage.setItem(key, value);
        } catch {
            // skip failed localStorage import
        }
    }
}

/**
 * 删除 IndexedDB 数据库
 */
async function deleteDatabase(name: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return;

    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
            // 即使被阻塞也继续，因为可能是其他标签页打开了数据库
            resolve();
        };
    });
}

/**
 * 导入单个 store 的数据
 */
async function importStore(db: IDBDatabase, storeName: string, records: BackupRecord[], zip: JSZip): Promise<void> {
    // 先异步预处理记录：从 ZIP 提取二进制 / base64 解码
    const processedRecords = await Promise.all(
        records.map(async (record) => {
            const processed: BackupRecord = { ...record };

            for (const key of Object.keys(processed)) {
                const val = processed[key];

                // 新格式：_blobRef 对象 → 从 ZIP 二进制恢复 Blob
                if (isBlobRef(val)) {
                    const zipEntry = zip.file(`blobs/${val._blobRef}`);
                    if (zipEntry) {
                        const arrayBuffer = await zipEntry.async('arraybuffer');
                        processed[key] = new Blob([arrayBuffer], { type: val._blobMimeType });
                    }
                    continue;
                }

                // 旧格式兼容：base64 字符串 + _blobMimeType
                if (key === 'blob' && typeof val === 'string' && typeof record._blobMimeType === 'string') {
                    processed.blob = base64ToBlob(val, record._blobMimeType);
                }
            }

            // 清理旧格式遗留的 _blobMimeType（新格式按字段内嵌携带）
            if ('_blobMimeType' in processed && typeof processed._blobMimeType === 'string') {
                delete processed._blobMimeType;
            }

            return processed;
        })
    );

    // 再写回 IndexedDB
    return new Promise((resolve, reject) => {
        try {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);

            for (const processedRecord of processedRecords) {
                store.put(processedRecord);
            }

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * 导入 IndexedDB 数据
 */
async function importIndexedDB(data: IndexedDBBackup, zip: JSZip, onProgress?: ProgressCallback): Promise<void> {
    let completedStores = 0;
    const totalStores = Object.values(data).reduce((sum, dbData) => sum + Object.keys(dbData).length, 0);

    for (const dbConfig of INDEXEDDB_DATABASES) {
        const dbData = data[dbConfig.name];
        if (!dbData) continue;

        // 先删除整个数据库，确保重新创建
        await deleteDatabase(dbConfig.name);

        // 重新打开数据库并导入数据（createStores=true 以便创建 stores）
        const db = await openDatabase(dbConfig.name, dbConfig.version, true);
        if (!db) {
            continue;
        }

        for (const storeName of dbConfig.stores) {
            try {
                const storeData = dbData[storeName];
                if (!storeData || !Array.isArray(storeData)) continue;

                if (!db.objectStoreNames.contains(storeName)) {
                    continue;
                }

                await importStore(db, storeName, storeData, zip);

                completedStores++;
                if (onProgress) {
                    const percent = 20 + Math.floor((completedStores / totalStores) * 70);
                    onProgress({
                        percent,
                        message: `正在导入 ${dbConfig.name}/${storeName}...`,
                    });
                }
            } catch {
                // store import failed, continue with next
            }
        }

        db.close();
    }
}

/**
 * 从 ZIP 文件导入所有数据（覆盖现有数据）
 */
export async function importAllData(file: File, onProgress?: ProgressCallback): Promise<void> {
    if (onProgress) {
        onProgress({ percent: 0, message: '开始导入数据...' });
    }

    // 解压 ZIP 文件
    if (onProgress) {
        onProgress({ percent: 5, message: '正在解压文件...' });
    }

    const zip = await JSZip.loadAsync(file);
    const metadataFile = zip.file('metadata.json');
    if (metadataFile) {
        const metadataText = await metadataFile.async('text');
        const metadata = JSON.parse(metadataText) as Record<string, unknown>;
        if (metadata.incremental === true) {
            throw new Error('不支持导入非完整备份文件，请选择完整备份文件');
        }
    }

    // 读取 localStorage 数据
    if (onProgress) {
        onProgress({ percent: 10, message: '正在清空 localStorage...' });
    }

    // 清空现有 localStorage
    for (const key of LOCAL_STORAGE_KEYS) {
        try {
            localStorage.removeItem(key);
        } catch {
            // skip failed localStorage removal
        }
    }

    if (onProgress) {
        onProgress({ percent: 15, message: '正在导入 localStorage...' });
    }

    const localStorageFile = zip.file('localStorage.json');
    if (localStorageFile) {
        const localStorageText = await localStorageFile.async('text');
        const localStorageData = JSON.parse(localStorageText);
        importLocalStorage(localStorageData);
    }

    // 读取 IndexedDB 数据
    const indexedDBData: IndexedDBBackup = {};
    const indexedDBFolder = zip.folder('indexedDB');

    if (indexedDBFolder) {
        const files = Object.keys(indexedDBFolder.files);

        for (const fileName of files) {
            if (fileName.startsWith('indexedDB/') && fileName.endsWith('.json')) {
                const file = zip.file(fileName);
                if (file) {
                    const text = await file.async('text');
                    const dbName = fileName.replace('indexedDB/', '').replace('.json', '');
                    indexedDBData[dbName] = JSON.parse(text);
                }
            }
        }
    }

    // 导入 IndexedDB
    await importIndexedDB(indexedDBData, zip, onProgress);

    // 读取并导入 localforage（无限画布）数据
    if (onProgress) {
        onProgress({ percent: 92, message: '正在导入无限画布数据...' });
    }
    const localForageData: LocalForageBackup = {};
    for (const fileName of Object.keys(zip.files)) {
        if (fileName.startsWith('localforage/') && fileName.endsWith('.json')) {
            const file = zip.file(fileName);
            if (file) {
                const text = await file.async('text');
                const dbName = fileName.replace('localforage/', '').replace('.json', '');
                localForageData[dbName] = JSON.parse(text);
            }
        }
    }
    await importLocalForage(localForageData, zip);

    if (onProgress) {
        onProgress({ percent: 100, message: '导入完成！' });
    }
}

/**
 * 下载 Blob 为文件
 */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * 生成备份文件名
 */
export function generateBackupFilename(): string {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    return `nova-backup-${dateStr}-${timeStr}.zip`;
}
