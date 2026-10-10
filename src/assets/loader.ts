// Lets the player supply the original data files. Files are kept in IndexedDB so they only
// need to be provided once. In dev builds the 0.88b map is also picked up from /reference/.
import { assets } from './store';

export type ArchiveRole = 'map' | 'base' | 'expansion' | 'patch';

interface StoredArchive {
  name: string;
  role: ArchiveRole;
  data: Blob;
}

const PRIORITY: Record<ArchiveRole, number> = { base: 0, expansion: 1, patch: 2, map: 3 };
const DB_NAME = 'warlocks-assets';
const STORE = 'archives';
const DEV_MAP_URL = '/reference/Warlock088bhotfix.w3m';

export function roleForFile(name: string): ArchiveRole | null {
  const n = name.toLowerCase();
  if (/\.w3[mx]$/.test(n)) return 'map';
  if (/war3patch\.mpq$/.test(n)) return 'patch';
  if (/war3x\.mpq$/.test(n)) return 'expansion';
  if (/war3\.mpq$/.test(n)) return 'base';
  return null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'role' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAll(): Promise<StoredArchive[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as StoredArchive[]);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function dbPut(a: StoredArchive | null, role?: ArchiveRole): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      if (a) tx.objectStore(STORE).put(a);
      else if (role) tx.objectStore(STORE).delete(role);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[assets] could not persist archive', e);
  }
}

export interface AssetStatus {
  archives: { role: ArchiveRole; name: string }[];
  hasMap: boolean;
  hasWarlockModel: boolean;
  hasBaseGame: boolean;
  error?: string;
}

const loaded = new Map<ArchiveRole, StoredArchive>();
let statusListeners: ((s: AssetStatus) => void)[] = [];
let lastError: string | undefined;

export function onAssetStatus(fn: (s: AssetStatus) => void): () => void {
  statusListeners.push(fn);
  fn(assetStatus());
  return () => {
    statusListeners = statusListeners.filter((f) => f !== fn);
  };
}

export function assetStatus(): AssetStatus {
  const archives = [...loaded.values()].map((a) => ({ role: a.role, name: a.name }));
  return {
    archives,
    hasMap: loaded.has('map'),
    hasWarlockModel: assets.has('BloodelfWizard.mdx'),
    hasBaseGame: loaded.has('base'),
    error: lastError,
  };
}

async function rebuild(): Promise<void> {
  assets.clear();
  const list = [...loaded.values()].sort((a, b) => PRIORITY[a.role] - PRIORITY[b.role]);
  for (const a of list) {
    try {
      // Maps are small enough to hold in memory; game archives are read lazily from the Blob.
      const data = a.role === 'map' ? new Uint8Array(await a.data.arrayBuffer()) : a.data;
      await assets.addArchive(a.name, data);
    } catch (e) {
      lastError = `${a.name}: ${(e as Error).message}`;
      loaded.delete(a.role);
    }
  }
  const s = assetStatus();
  for (const fn of statusListeners) fn(s);
}

/** Adds user-supplied files (map and/or game archives). Unknown files are ignored. */
export async function addFiles(files: Iterable<File>): Promise<void> {
  lastError = undefined;
  let any = false;
  for (const f of files) {
    const role = roleForFile(f.name);
    if (!role) {
      lastError = `Unrecognised file: ${f.name}`;
      continue;
    }
    const a = { name: f.name, role, data: f as Blob };
    loaded.set(role, a);
    any = true;
    await dbPut(a);
  }
  if (any) await rebuild();
  else for (const fn of statusListeners) fn(assetStatus());
}

export async function removeArchive(role: ArchiveRole): Promise<void> {
  loaded.delete(role);
  await dbPut(null, role);
  await rebuild();
}

/** Restores previously supplied archives (and, in dev, the reference map). */
export async function initAssets(): Promise<AssetStatus> {
  for (const a of await dbAll()) loaded.set(a.role, a);
  if (!loaded.has('map') && import.meta.env.DEV) {
    try {
      const res = await fetch(DEV_MAP_URL);
      const type = res.headers.get('content-type') ?? '';
      if (res.ok && !type.includes('text/html')) {
        loaded.set('map', { name: DEV_MAP_URL.split('/').pop()!, role: 'map', data: await res.blob() });
      }
    } catch {
      // No reference map available; that's fine.
    }
  }
  await rebuild();
  return assetStatus();
}
