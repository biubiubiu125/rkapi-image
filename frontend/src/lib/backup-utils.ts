'use client';

import { zipSync, unzipSync, strToU8 } from 'fflate';
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
    'flyreq-model-registry',
    'flyreq-jobs',
    'flyreq-prompt-optimize-enabled',
    'flyreq-image-generation-settings',
    'flyreq-t2i-settings',
    'flyreq-i2i-settings',
    'flyreq-reverse-prompt-settings',
    'theme',
    'flyreq-wide-mode',
    // Agent 模式
    'flyreq-agent-params',
    'flyreq-agent-web-search',
    'flyreq-agent-intent-recognition',
    // 动图生成
    'flyreq-gif-settings',
    'flyreq-gif-active-job',
    // 我的素材
    'flyreq-assets-settings',
    // 无限画布生成配置
    'flyreq-image:canvas_config',
];

// IndexedDB databases to backup
const INDEXEDDB_DATABASES = [
    { name: 'flyreq-image-db', version: 2, stores: ['images', 'blobs'] },
    { name: 'flyreq-reverse-db', version: 1, stores: ['reverse-results'] },
    { name: 'flyreq-upload-cache', version: 1, stores: ['images'] },
    // Agent 模式对话、图片登记、元信息
    { name: 'flyreq-agent-db', version: 1, stores: ['messages', 'images', 'meta'] },
    // 本地图片素材库
    { name: 'flyreq-assets-db', version: 1, stores: ['assets', 'asset-blobs'] },
];

// localforage keyless 实例（无限画布：项目状态 + 图片 blob）。
// 通用 IndexedDB 逻辑面向 keyPath store，无法 round-trip localforage 的无 keyPath store，故单独处理。
const LOCALFORAGE_STORES: { name: string; storeName: string }[] = [
    { name: 'flyreq-image', storeName: 'canvas_app_state' },
    { name: 'flyreq-image', storeName: 'canvas_image_files' },
];

type LocalForageEntry = { key: string; value: unknown } | { key: string; _blobRef: string; _blobMimeType: string };
type LocalForageBackup = Record<string, Record<string, LocalForageEntry[]>>;
type LocalForageInstance = ReturnType<typeof localforage.createInstance>;
type LocalForageSnapshotEntry = { key: string; value: unknown };
type LocalForageSnapshot = { name: string; storeName: string; entries: LocalForageSnapshotEntry[] };
type LocalStorageSnapshot = Record<string, string | null>;
type IndexedDBStoreSnapshot = { storeName: string; records: BackupRecord[] };
type IndexedDBSnapshot = { name: string; version: number; stores: IndexedDBStoreSnapshot[] };

/** Blob → Uint8Array（fflate 需要 Uint8Array） */
async function blobToUint8(blob: Blob): Promise<Uint8Array> {
    const ab = await blob.arrayBuffer();
    return new Uint8Array(ab);
}

// 用于生成导出时 Blob 的唯一引用 ID
let _blobRefSeq = 0;
function nextBlobRef(): string {
    return `b${Date.now()}_${++_blobRefSeq}`;
}

/**
 * 将 JSON 数据转为 fflate 可用的 Uint8Array
 */
function jsonToU8(data: unknown): Uint8Array {
    return strToU8(JSON.stringify(data));
}

function parseJsonText<T>(text: string, sourcePath: string): T {
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`备份文件 ${sourcePath} 解析失败`);
    }
}

function collectBlobRefs(value: unknown, refs = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
        for (const item of value) {
            collectBlobRefs(item, refs);
        }
        return refs;
    }
    if (!isBackupRecord(value)) return refs;
    if (isBlobRef(value)) {
        refs.add(value._blobRef);
    }
    for (const nestedValue of Object.values(value)) {
        collectBlobRefs(nestedValue, refs);
    }
    return refs;
}

function assertBlobRefsExist(value: unknown, unzipped: Record<string, Uint8Array>, sourcePath: string): void {
    for (const blobRef of collectBlobRefs(value)) {
        if (!unzipped[`blobs/${blobRef}`]) {
            throw new Error(`缺少 blob 引用: ${blobRef} (${sourcePath})`);
        }
    }
}

/**
 * 导出 localforage（keyless）store：保留 key；Blob 值以二进制存入 ZIP blobs/，JSON 内留引用。
 * 数据逐 store 写入 files 对象，释放引用后可被 GC 回收。
 */
async function exportLocalForage(files: Record<string, Uint8Array>): Promise<LocalForageBackup> {
    const result: LocalForageBackup = {};
    const blobWrites: Promise<void>[] = [];
    for (const cfg of LOCALFORAGE_STORES) {
        try {
            const instance = localforage.createInstance({ name: cfg.name, storeName: cfg.storeName });
            const entries: LocalForageEntry[] = [];
            await instance.iterate((value: unknown, key: string) => {
                if (value instanceof Blob) {
                    const ref = nextBlobRef();
                    blobWrites.push(blobToUint8(value).then(u8 => { files[`blobs/${ref}`] = u8; }));
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
    await Promise.all(blobWrites);
    return result;
}

/**
 * 导入 localforage（keyless）store：先清空，再按 key 写回；Blob 从 ZIP 还原。
 */
async function snapshotLocalForageStore(instance: LocalForageInstance): Promise<LocalForageSnapshotEntry[]> {
    const entries: LocalForageSnapshotEntry[] = [];
    await instance.iterate((value: unknown, key: string) => {
        entries.push({ key, value });
    });
    return entries;
}

async function restoreLocalForageStore(instance: LocalForageInstance, entries: LocalForageSnapshotEntry[]): Promise<void> {
    await instance.clear();
    for (const entry of entries) {
        await instance.setItem(entry.key, entry.value);
    }
}

async function snapshotLocalForageStores(data: LocalForageBackup): Promise<LocalForageSnapshot[]> {
    const snapshots: LocalForageSnapshot[] = [];
    for (const cfg of LOCALFORAGE_STORES) {
        const entries = data[cfg.name]?.[cfg.storeName];
        if (!Array.isArray(entries)) continue;
        const instance = localforage.createInstance({ name: cfg.name, storeName: cfg.storeName });
        snapshots.push({
            ...cfg,
            entries: await snapshotLocalForageStore(instance),
        });
    }
    return snapshots;
}

async function restoreLocalForageSnapshots(snapshots: LocalForageSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
        const instance = localforage.createInstance({ name: snapshot.name, storeName: snapshot.storeName });
        await restoreLocalForageStore(instance, snapshot.entries);
    }
}

async function importLocalForage(
    data: LocalForageBackup,
    unzipped: Record<string, Uint8Array>,
    snapshots: LocalForageSnapshot[] = [],
): Promise<void> {
    for (const cfg of LOCALFORAGE_STORES) {
        const entries = data[cfg.name]?.[cfg.storeName];
        if (!Array.isArray(entries)) continue;

        const instance = localforage.createInstance({ name: cfg.name, storeName: cfg.storeName });
        const snapshot = snapshots.find(item => item.name === cfg.name && item.storeName === cfg.storeName);

        try {
            await instance.clear();

            for (const entry of entries) {
                let value: unknown;
                if ('_blobRef' in entry && typeof entry._blobRef === 'string') {
                    const blobData = unzipped[`blobs/${entry._blobRef}`];
                    if (!blobData) {
                        throw new Error(`缺少 blob 引用: ${entry._blobRef} (${cfg.name}/${cfg.storeName})`);
                    }
                    value = new Blob([blobData as unknown as BlobPart], { type: entry._blobMimeType });
                } else {
                    value = (entry as { value: unknown }).value;
                }
                await instance.setItem(entry.key, value);
            }
        } catch (error) {
            if (snapshot) await restoreLocalForageStore(instance, snapshot.entries).catch(() => undefined);
            throw error;
        }
    }
}
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

function snapshotLocalStorage(): LocalStorageSnapshot {
    const snapshot: LocalStorageSnapshot = {};
    for (const key of LOCAL_STORAGE_KEYS) {
        try {
            snapshot[key] = localStorage.getItem(key);
        } catch {
            snapshot[key] = null;
        }
    }
    return snapshot;
}

function restoreLocalStorageSnapshot(snapshot: LocalStorageSnapshot): void {
    for (const [key, value] of Object.entries(snapshot)) {
        try {
            if (value === null) {
                localStorage.removeItem(key);
            } else {
                localStorage.setItem(key, value);
            }
        } catch {
            // best-effort rollback
        }
    }
}

function clearImportLocalStorage(): void {
    for (const key of LOCAL_STORAGE_KEYS) {
        try {
            localStorage.removeItem(key);
        } catch {
            throw new Error(`localStorage 清空失败: ${key}`);
        }
    }
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
            if (name === 'flyreq-image-db') {
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('blobs')) {
                    db.createObjectStore('blobs', { keyPath: 'key' });
                }
            } else if (name === 'flyreq-reverse-db') {
                if (!db.objectStoreNames.contains('reverse-results')) {
                    db.createObjectStore('reverse-results', { keyPath: 'slot' });
                }
            } else if (name === 'flyreq-upload-cache') {
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'key' });
                }
            } else if (name === 'flyreq-agent-db') {
                if (!db.objectStoreNames.contains('messages')) {
                    db.createObjectStore('messages', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'imgId' });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }
            } else if (name === 'flyreq-assets-db') {
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
 * Blob 字段转为 Uint8Array 存入 files，JSON 中只保留引用
 */
async function exportStore(db: IDBDatabase, storeName: string, files: Record<string, Uint8Array>): Promise<BackupRecord[]> {
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

                        // 遍历所有字段，将 Blob 类型以二进制存入 files
                        for (const key of Object.keys(processed)) {
                            const val = processed[key];
                            if (val instanceof Blob) {
                                const ref = nextBlobRef();
                                files[`blobs/${ref}`] = await blobToUint8(val);
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

/**
 * 导出所有 IndexedDB 数据
 * 逐数据库、逐 store 顺序处理，处理完立即写入 files，降低内存峰值
 */
async function exportIndexedDB(files: Record<string, Uint8Array>, onProgress?: ProgressCallback): Promise<IndexedDBBackup> {
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

                const storeData = await exportStore(db, storeName, files);
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
 * 使用 fflate 替代 JSZip，显著降低内存占用和处理时间
 * @param onProgress 导出进度回调函数。
 * @param appVersion 当前运行时平台版本号，写入备份元数据。
 * @returns 包含全部浏览器数据的 ZIP 文件 Blob。
 */
export async function exportAllData(onProgress?: ProgressCallback, appVersion: string = '0.0.0'): Promise<Blob> {
    if (onProgress) {
        onProgress({ percent: 0, message: '开始导出数据...' });
    }

    // 导出 localStorage
    if (onProgress) {
        onProgress({ percent: 5, message: '正在导出 localStorage...' });
    }
    const localStorageData = exportLocalStorage();

    // 逐 store 导出 IndexedDB，Blob 数据直接转为 Uint8Array 存入 files
    const files: Record<string, Uint8Array> = {};
    const indexedDBData = await exportIndexedDB(files, onProgress);

    // 导出 localforage 数据
    const localForageData = await exportLocalForage(files);

    // 打包元数据和 localStorage JSON
    if (onProgress) {
        onProgress({ percent: 90, message: '正在打包数据...' });
    }

    // 添加元数据
    files['metadata.json'] = jsonToU8({
        version: appVersion,
        exportDate: new Date().toISOString(),
        appName: 'RKAPI Image',
    });

    // 添加 localStorage 数据
    files['localStorage.json'] = jsonToU8(localStorageData);

    // 添加 IndexedDB 数据
    for (const [dbName, dbData] of Object.entries(indexedDBData)) {
        files[`indexedDB/${dbName}.json`] = jsonToU8(dbData);
    }

    // 添加 localforage（无限画布）数据
    for (const [dbName, dbData] of Object.entries(localForageData)) {
        files[`localforage/${dbName}.json`] = jsonToU8(dbData);
    }

    if (onProgress) {
        onProgress({ percent: 95, message: '正在生成 ZIP 文件...' });
    }

    // 使用 fflate 同步压缩（比 JSZip 快 10-20 倍，内存占用更低）
    const zipped = zipSync(files, { level: 6 });
    const blob = new Blob([zipped], { type: 'application/zip' });

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

        if (key === 'flyreq-model-registry') {
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
            throw new Error(`localStorage 导入失败: ${key}`);
        }
    }
}

async function preprocessStoreRecords(storeName: string, records: BackupRecord[], unzipped: Record<string, Uint8Array>): Promise<BackupRecord[]> {
    // 先异步预处理记录：从解压数据提取二进制 / base64 解码
    return Promise.all(
        records.map(async (record) => {
            const processed: BackupRecord = { ...record };

            for (const key of Object.keys(processed)) {
                const val = processed[key];

                // 新格式：_blobRef 对象 → 从解压数据恢复 Blob
                if (isBlobRef(val)) {
                    const blobData = unzipped[`blobs/${val._blobRef}`];
                    if (!blobData) {
                        throw new Error(`缺少 blob 引用: ${val._blobRef} (${storeName})`);
                    }
                    processed[key] = new Blob([blobData as unknown as BlobPart], { type: val._blobMimeType });
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
}

async function importDatabaseStores(
    db: IDBDatabase,
    storeDataList: Array<{ storeName: string; records: BackupRecord[] }>,
    unzipped: Record<string, Uint8Array>,
): Promise<void> {
    const processedStores = await Promise.all(storeDataList.map(async item => ({
        storeName: item.storeName,
        records: await preprocessStoreRecords(item.storeName, item.records, unzipped),
    })));
    if (processedStores.length === 0) return;

    await replaceDatabaseStores(db, processedStores);
}

function replaceDatabaseStores(
    db: IDBDatabase,
    storeDataList: Array<{ storeName: string; records: BackupRecord[] }>,
): Promise<void> {
    if (storeDataList.length === 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
        try {
            const transaction = db.transaction(storeDataList.map(item => item.storeName), 'readwrite');
            for (const item of storeDataList) {
                const store = transaction.objectStore(item.storeName);
                store.clear();
                for (const record of item.records) {
                    store.put(record);
                }
            }
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        } catch (error) {
            reject(error);
        }
    });
}

function readStoreRecords(db: IDBDatabase, storeName: string): Promise<BackupRecord[]> {
    return new Promise((resolve, reject) => {
        try {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve((request.result as BackupRecord[]) || []);
            request.onerror = () => reject(request.error);
        } catch (error) {
            reject(error);
        }
    });
}

async function snapshotIndexedDBStores(data: IndexedDBBackup): Promise<IndexedDBSnapshot[]> {
    const snapshots: IndexedDBSnapshot[] = [];

    for (const dbConfig of INDEXEDDB_DATABASES) {
        const dbData = data[dbConfig.name];
        if (!dbData) continue;

        const db = await openDatabase(dbConfig.name, dbConfig.version, true);
        if (!db) {
            throw new Error(`无法打开 IndexedDB 数据库 ${dbConfig.name}`);
        }

        try {
            const stores: IndexedDBStoreSnapshot[] = [];
            for (const storeName of dbConfig.stores) {
                const incomingRecords = dbData[storeName];
                if (!Array.isArray(incomingRecords)) continue;

                if (!db.objectStoreNames.contains(storeName)) {
                    throw new Error(`IndexedDB 数据库 ${dbConfig.name} 缺少 store: ${storeName}`);
                }

                stores.push({
                    storeName,
                    records: await readStoreRecords(db, storeName),
                });
            }

            if (stores.length > 0) {
                snapshots.push({ name: dbConfig.name, version: dbConfig.version, stores });
            }
        } finally {
            db.close();
        }
    }

    return snapshots;
}

async function restoreIndexedDBSnapshots(snapshots: IndexedDBSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
        const db = await openDatabase(snapshot.name, snapshot.version, true);
        if (!db) continue;

        try {
            await replaceDatabaseStores(db, snapshot.stores);
        } finally {
            db.close();
        }
    }
}

/**
 * 导入 IndexedDB 数据
 */
async function importIndexedDB(data: IndexedDBBackup, unzipped: Record<string, Uint8Array>, onProgress?: ProgressCallback): Promise<void> {
    let completedStores = 0;
    const totalStores = Object.values(data).reduce((sum, dbData) => sum + Object.keys(dbData).length, 0);

    for (const dbConfig of INDEXEDDB_DATABASES) {
        const dbData = data[dbConfig.name];
        if (!dbData) continue;

        const db = await openDatabase(dbConfig.name, dbConfig.version, true);
        if (!db) {
            throw new Error(`无法打开 IndexedDB 数据库 ${dbConfig.name}`);
        }

        try {
            const storeDataList: Array<{ storeName: string; records: BackupRecord[] }> = [];
            for (const storeName of dbConfig.stores) {
                const storeData = dbData[storeName];
                if (!storeData || !Array.isArray(storeData)) continue;

                if (!db.objectStoreNames.contains(storeName)) {
                    throw new Error(`IndexedDB 数据库 ${dbConfig.name} 缺少 store: ${storeName}`);
                }

                storeDataList.push({ storeName, records: storeData });
            }

            await importDatabaseStores(db, storeDataList, unzipped);

            for (const item of storeDataList) {
                completedStores++;
                if (onProgress) {
                    const percent = totalStores > 0 ? 20 + Math.floor((completedStores / totalStores) * 70) : 90;
                    onProgress({
                        percent,
                        message: `正在导入 ${dbConfig.name}/${item.storeName}...`,
                    });
                }
            }
        } finally {
            db.close();
        }
    }
}
export async function importAllData(file: File, onProgress?: ProgressCallback): Promise<void> {
    if (onProgress) {
        onProgress({ percent: 0, message: '开始导入数据...' });
    }

    if (onProgress) {
        onProgress({ percent: 5, message: '正在解压文件...' });
    }

    const buffer = await file.arrayBuffer();
    const unzipped = unzipSync(new Uint8Array(buffer));

    const readText = (path: string): string | null => {
        const data = unzipped[path];
        return data ? new TextDecoder().decode(data) : null;
    };

    const metadataText = readText('metadata.json');
    if (metadataText) {
        const metadata = parseJsonText<Record<string, unknown>>(metadataText, 'metadata.json');
        if (metadata.incremental === true) {
            throw new Error('不支持导入非完整备份文件，请选择完整备份文件');
        }
    }

    const localStorageData = readText('localStorage.json');
    const parsedLocalStorageData = localStorageData ? parseJsonText<Record<string, unknown>>(localStorageData, 'localStorage.json') : null;
    const indexedDBData: IndexedDBBackup = {};
    for (const [path, data] of Object.entries(unzipped)) {
        if (path.startsWith('indexedDB/') && path.endsWith('.json')) {
            const dbName = path.replace('indexedDB/', '').replace('.json', '');
            indexedDBData[dbName] = parseJsonText<DatabaseBackup>(new TextDecoder().decode(data), path);
        }
    }

    const localForageData: LocalForageBackup = {};
    for (const [path, data] of Object.entries(unzipped)) {
        if (path.startsWith('localforage/') && path.endsWith('.json')) {
            const dbName = path.replace('localforage/', '').replace('.json', '');
            localForageData[dbName] = parseJsonText<Record<string, LocalForageEntry[]>>(new TextDecoder().decode(data), path);
        }
    }

    assertBlobRefsExist(indexedDBData, unzipped, 'indexedDB');
    assertBlobRefsExist(localForageData, unzipped, 'localforage');
    const localStorageSnapshot = snapshotLocalStorage();
    const localForageSnapshots = await snapshotLocalForageStores(localForageData);
    const indexedDBSnapshots = await snapshotIndexedDBStores(indexedDBData);

    try {
        if (onProgress) {
            onProgress({ percent: 12, message: '正在导入 localforage 数据...' });
        }
        await importLocalForage(localForageData, unzipped, localForageSnapshots);

        if (onProgress) {
            onProgress({ percent: 20, message: '正在导入 IndexedDB...' });
        }
        await importIndexedDB(indexedDBData, unzipped, onProgress);

        if (onProgress) {
            onProgress({ percent: 96, message: '正在清空 localStorage...' });
        }

        clearImportLocalStorage();

        if (onProgress) {
            onProgress({ percent: 98, message: '正在导入 localStorage...' });
        }

        if (parsedLocalStorageData) {
            importLocalStorage(parsedLocalStorageData);
        }
    } catch (error) {
        await restoreLocalForageSnapshots(localForageSnapshots).catch(() => undefined);
        await restoreIndexedDBSnapshots(indexedDBSnapshots).catch(() => undefined);
        restoreLocalStorageSnapshot(localStorageSnapshot);
        throw error;
    }

    if (onProgress) {
        onProgress({ percent: 100, message: '导入完成。' });
    }
}
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Safari 需要延迟撤销，否则下载可能失败
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 生成备份文件名
 */
export function generateBackupFilename(): string {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    return `rkapi-backup-${dateStr}-${timeStr}.zip`;
}
