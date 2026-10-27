// Page-side functions for saved sessions (browser-session.ts). Origin storage
// is read and written on a blank stub document served for the origin, so no
// site script runs beside them; sessionStorage is only ever cleared, in the
// agent's own tabs. Values travel as CDP call arguments and return values,
// never as source text. The IndexedDB codec follows #1210's.

/** The path of the blank document served for an origin (browser-session.ts intercepts it). */
export const STUB_PATH = '/__superagent_session__'

/** Refuses a document that is not the stub of the expected origin: never read or write another's storage. */
const ON_STUB = (origin: string) => `
  if (location.origin !== ${origin} || location.pathname !== ${JSON.stringify(STUB_PATH)}) {
    throw new Error('The storage page is not the blank page of ' + ${origin});
  }
`

/** A database bigger than this is a cache (messages, documents), not a sign-in: left out. */
export const MAX_INDEXEDDB_DATABASE_CHARS = 512_000
/** Counted before anything is read, so a big cache is never read at all. */
export const MAX_INDEXEDDB_RECORDS = 2_000
/** A blob or file bigger than this is content, not a sign-in. */
const MAX_BLOB_BYTES = 256_000
/** A localStorage value bigger than this is a cache too: a token is a few KB. */
export const MAX_LOCAL_STORAGE_VALUE_CHARS = 64_000

const CODEC = `
  const toBase64 = (bytes) => {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const request = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
`

/** Reads the origin's localStorage and IndexedDB: `{ localStorage, indexedDB, oversized, unsupported }`. */
export const READ_ORIGIN_STORAGE_FUNCTION = `async function(expectedOrigin) {
  ${ON_STUB('expectedOrigin')}
  ${CODEC}
  const unsupported = new Set();
  // ancestors: the objects on the path to this value. IndexedDB takes cycles, which do not serialize.
  const encode = async (value, ancestors = new Set()) => {
    if (value === undefined) return { $t: 'undefined' };
    if (typeof value === 'bigint') return { $t: 'bigint', v: String(value) };
    if (typeof value === 'number' && !Number.isFinite(value)) return { $t: 'number', v: String(value) };
    if (value === null || typeof value !== 'object') return value;
    if (ancestors.has(value)) {
      unsupported.add('cycle');
      return { $t: 'unsupported', type: 'cycle' };
    }
    const inner = new Set(ancestors).add(value);
    const child = (v) => encode(v, inner);
    if (value instanceof Date) return { $t: 'date', v: value.getTime() };
    if (value instanceof ArrayBuffer) return { $t: 'arraybuffer', v: toBase64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value)) {
      return { $t: 'view', ctor: value.constructor.name, v: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    }
    if (value instanceof Blob && value.size > ${MAX_BLOB_BYTES}) {
      unsupported.add('large-blob');
      return { $t: 'unsupported', type: 'large-blob' };
    }
    if (value instanceof File) {
      return { $t: 'file', name: value.name, type: value.type, lastModified: value.lastModified, v: toBase64(new Uint8Array(await value.arrayBuffer())) };
    }
    if (value instanceof Blob) return { $t: 'blob', type: value.type, v: toBase64(new Uint8Array(await value.arrayBuffer())) };
    if (value instanceof Map) return { $t: 'map', v: await Promise.all([...value].map(async ([k, v]) => [await child(k), await child(v)])) };
    if (value instanceof Set) return { $t: 'set', v: await Promise.all([...value].map(child)) };
    if (value instanceof RegExp) return { $t: 'regexp', source: value.source, flags: value.flags };
    if (Array.isArray(value)) return Promise.all(value.map(child));
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = await child(v);
      return Object.prototype.hasOwnProperty.call(out, '$t') ? { $t: 'object', v: out } : out;
    }
    // A non-extractable CryptoKey, say: it cannot leave this browser.
    const type = (value.constructor && value.constructor.name) || 'object';
    unsupported.add(type);
    return { $t: 'unsupported', type };
  };

  const localEntries = [];
  let oversized = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    const value = localStorage.getItem(key);
    if (key === null || value === null) continue;
    if (value.length > ${MAX_LOCAL_STORAGE_VALUE_CHARS}) oversized++;
    else localEntries.push([key, value]);
  }

  const databases = [];
  for (const info of await indexedDB.databases()) {
    if (!info.name) continue;
    const db = await request(indexedDB.open(info.name));
    try {
      let records = 0;
      for (const name of [...db.objectStoreNames]) records += await request(db.transaction(name, 'readonly').objectStore(name).count());
      if (records > ${MAX_INDEXEDDB_RECORDS}) {
        oversized++;
        continue;
      }
      const stores = [];
      for (const name of [...db.objectStoreNames]) {
        const store = db.transaction(name, 'readonly').objectStore(name);
        const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
        stores.push({
          name,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes: [...store.indexNames].map((indexName) => {
            const index = store.index(indexName);
            return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
          }),
          records: await Promise.all(values.map(async (value, i) => ({ key: await encode(keys[i]), value: await encode(value) }))),
        });
      }
      if (JSON.stringify(stores).length > ${MAX_INDEXEDDB_DATABASE_CHARS}) oversized++;
      else databases.push({ name: info.name, version: db.version, stores });
    } finally {
      db.close();
    }
  }

  return { localStorage: localEntries, indexedDB: databases, oversized, unsupported: [...unsupported] };
}`

/**
 * Writes localStorage and IndexedDB into an origin the caller has just
 * emptied. Records holding a value that could not leave its browser are
 * skipped (`skippedRecords`).
 */
export const WRITE_ORIGIN_STORAGE_FUNCTION = `async function(data) {
  ${ON_STUB('data.origin')}
  ${CODEC}
  const UNRESTORABLE = Symbol('unrestorable');
  const decode = (value) => {
    if (Array.isArray(value)) return value.map(decode);
    if (value === null || typeof value !== 'object') return value;
    const decodeFields = (fields) => {
      const out = {};
      for (const [k, v] of Object.entries(fields)) out[k] = decode(v);
      return out;
    };
    switch (value.$t) {
      case undefined: return decodeFields(value);
      // A plain object that has a "$t" field of its own: its fields are data, not a tag.
      case 'object': return decodeFields(value.v);
      case 'undefined': return undefined;
      case 'bigint': return BigInt(value.v);
      case 'number': return Number(value.v);
      case 'date': return new Date(value.v);
      case 'arraybuffer': return fromBase64(value.v).buffer;
      case 'view': {
        const bytes = fromBase64(value.v);
        const Ctor = globalThis[value.ctor];
        if (Ctor === DataView) return new DataView(bytes.buffer);
        return typeof Ctor === 'function' ? new Ctor(bytes.buffer, 0, bytes.byteLength / (Ctor.BYTES_PER_ELEMENT || 1)) : bytes;
      }
      case 'file': return new File([fromBase64(value.v)], value.name, { type: value.type, lastModified: value.lastModified });
      case 'blob': return new Blob([fromBase64(value.v)], { type: value.type });
      case 'map': return new Map(value.v.map(([k, v]) => [decode(k), decode(v)]));
      case 'set': return new Set(value.v.map(decode));
      case 'regexp': return new RegExp(value.source, value.flags);
      default: return UNRESTORABLE;
    }
  };
  const contains = (value, needle) => {
    if (value === needle) return true;
    if (value instanceof Map) return [...value].some(([k, v]) => contains(k, needle) || contains(v, needle));
    if (value instanceof Set) return [...value].some((v) => contains(v, needle));
    if (Array.isArray(value)) return value.some((v) => contains(v, needle));
    if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value).some((v) => contains(v, needle));
    return false;
  };

  for (const [key, value] of data.localStorage) localStorage.setItem(key, value);

  let skippedRecords = 0;
  for (const database of data.indexedDB) {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(database.name, database.version);
      req.onupgradeneeded = () => {
        for (const store of database.stores) {
          const created = req.result.createObjectStore(store.name, {
            keyPath: store.keyPath === null ? undefined : store.keyPath,
            autoIncrement: store.autoIncrement,
          });
          for (const index of store.indexes) {
            created.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      if (database.stores.length === 0) continue;
      const tx = db.transaction(database.stores.map((store) => store.name), 'readwrite');
      for (const store of database.stores) {
        const objectStore = tx.objectStore(store.name);
        for (const record of store.records) {
          const key = decode(record.key);
          const value = decode(record.value);
          if (contains(key, UNRESTORABLE) || contains(value, UNRESTORABLE)) {
            skippedRecords++;
            continue;
          }
          if (store.keyPath === null) objectStore.put(value, key);
          else objectStore.put(value);
        }
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
  return { skippedRecords };
}`

/**
 * Empties the tab's sessionStorage, only while the tab is still on the origin
 * it was picked for: the check and the clear run in one task, so a
 * navigation cannot come between them. Null when the tab has left.
 */
export const CLEAR_SESSION_STORAGE_FUNCTION = `function(expectedOrigin) {
  if (location.origin !== expectedOrigin) return null;
  sessionStorage.clear();
  return true;
}`
