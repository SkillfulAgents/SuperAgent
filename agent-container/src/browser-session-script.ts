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

/** A database bigger than this is a cache (messages, documents), not a sign-in: left out, its reading stopped once it passes this. */
export const MAX_INDEXEDDB_DATABASE_CHARS = 512_000
/** Counted before anything is read, so a big cache is never read at all. */
export const MAX_INDEXEDDB_RECORDS = 2_000
/**
 * A database not opened and read in this long is left out: one the site is
 * deleting or upgrading waits on the site's own open connections, maybe for good.
 */
export const MAX_INDEXEDDB_DATABASE_MS = 3_000
/** All of an origin's databases, well inside the call's own limit (20 s): the rest are left out. */
const MAX_INDEXEDDB_MS = 10_000
/**
 * A value nested deeper than this is left out with its database: encoded, it
 * nests up to three levels for each of its own (a Map's entries), and the
 * call's result carries about 290 in all (measured).
 */
export const MAX_INDEXEDDB_VALUE_DEPTH = 64
/** A blob or file bigger than this is content, not a sign-in. */
const MAX_BLOB_BYTES = 256_000
/** A localStorage value bigger than this is a cache too: a token is a few KB. */
export const MAX_LOCAL_STORAGE_VALUE_CHARS = 64_000
/** As many as a saved session holds of an origin (browser-session-schema.ts): the rest are left out. */
const MAX_LOCAL_STORAGE_ENTRIES = 10_000
const MAX_DATABASES = 100

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

/**
 * Reads the origin's localStorage and IndexedDB: `{ localStorage, indexedDB,
 * leftOut, unsupported }`. What is left out (`leftOut`): a cache, and a
 * database that does not open or read in time, cannot be read, or holds a
 * value nested too deep to come back.
 */
export const READ_ORIGIN_STORAGE_FUNCTION = `async function(expectedOrigin) {
  ${ON_STUB('expectedOrigin')}
  ${CODEC}
  const unsupported = new Set();
  // Thrown once a database's values pass the size of a cache: the rest of it is not read.
  const TOO_BIG = new Error('too big');
  // Thrown for a value nested deeper than the call's result carries.
  const TOO_DEEP = new Error('too deep');
  const within = (promise, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
  // Encodes a value for JSON, record by record inside a cursor, so it cannot
  // wait: a blob's bytes are read after the store, into the object left for
  // them in \`blobs\`. \`budget.chars\` counts what was encoded. ancestors: the
  // objects on the path to this value (IndexedDB takes cycles, which do not
  // serialize).
  const encode = (value, budget, blobs, ancestors = new Set()) => {
    const spend = (chars) => {
      budget.chars += chars;
      if (budget.chars > ${MAX_INDEXEDDB_DATABASE_CHARS}) throw TOO_BIG;
    };
    if (value === undefined) return { $t: 'undefined' };
    if (typeof value === 'bigint') return { $t: 'bigint', v: String(value) };
    if (typeof value === 'number' && !Number.isFinite(value)) return { $t: 'number', v: String(value) };
    if (typeof value === 'string') spend(value.length);
    if (value === null || typeof value !== 'object') return value;
    if (ancestors.has(value)) {
      unsupported.add('cycle');
      return { $t: 'unsupported', type: 'cycle' };
    }
    if (ancestors.size >= ${MAX_INDEXEDDB_VALUE_DEPTH}) throw TOO_DEEP;
    const inner = new Set(ancestors).add(value);
    const child = (v) => encode(v, budget, blobs, inner);
    if (value instanceof Date) return { $t: 'date', v: value.getTime() };
    if (value instanceof ArrayBuffer) {
      spend(Math.ceil(value.byteLength / 3) * 4);
      return { $t: 'arraybuffer', v: toBase64(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
      spend(Math.ceil(value.byteLength / 3) * 4);
      return { $t: 'view', ctor: value.constructor.name, v: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    }
    if (value instanceof Blob && value.size > ${MAX_BLOB_BYTES}) {
      unsupported.add('large-blob');
      return { $t: 'unsupported', type: 'large-blob' };
    }
    if (value instanceof Blob) {
      spend(Math.ceil(value.size / 3) * 4);
      const encoded = value instanceof File
        ? { $t: 'file', name: value.name, type: value.type, lastModified: value.lastModified, v: '' }
        : { $t: 'blob', type: value.type, v: '' };
      blobs.push([encoded, value]);
      return encoded;
    }
    if (value instanceof Map) return { $t: 'map', v: [...value].map(([k, v]) => [child(k), child(v)]) };
    if (value instanceof Set) return { $t: 'set', v: [...value].map(child) };
    if (value instanceof RegExp) return { $t: 'regexp', source: value.source, flags: value.flags };
    if (Array.isArray(value)) return value.map(child);
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        spend(k.length);
        out[k] = child(v);
      }
      return Object.prototype.hasOwnProperty.call(out, '$t') ? { $t: 'object', v: out } : out;
    }
    // A non-extractable CryptoKey, say: it cannot leave this browser.
    const type = (value.constructor && value.constructor.name) || 'object';
    unsupported.add(type);
    return { $t: 'unsupported', type };
  };
  // One store's records, read with a cursor: never more of it in memory than one record and what fits the budget.
  const readStore = (db, name, budget, blobs) => new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readonly');
    const store = tx.objectStore(name);
    const read = {
      name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: [...store.indexNames].map((indexName) => {
        const index = store.index(indexName);
        return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
      }),
      records: [],
    };
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at) return;
      try {
        read.records.push({ key: encode(at.primaryKey, budget, blobs), value: encode(at.value, budget, blobs) });
      } catch (error) {
        reject(error);
        tx.abort();
        return;
      }
      at.continue();
    };
    cursor.onerror = () => reject(cursor.error);
    tx.oncomplete = () => resolve(read);
    tx.onabort = () => reject(tx.error || TOO_BIG);
  });
  // A database's stores, all of them or none: a blob's file can be gone, a value too big or too deep.
  const readStores = async (db) => {
    let records = 0;
    for (const name of [...db.objectStoreNames]) records += await request(db.transaction(name, 'readonly').objectStore(name).count());
    if (records > ${MAX_INDEXEDDB_RECORDS}) throw TOO_BIG;
    const budget = { chars: 0 };
    const blobs = [];
    const stores = [];
    for (const name of [...db.objectStoreNames]) stores.push(await readStore(db, name, budget, blobs));
    for (const [encoded, blob] of blobs) encoded.v = toBase64(new Uint8Array(await blob.arrayBuffer()));
    if (JSON.stringify(stores).length > ${MAX_INDEXEDDB_DATABASE_CHARS}) throw TOO_BIG;
    return stores;
  };
  // A database as it is, read within \`ms\`; null when it is gone. Never one
  // created: a database deleted since it was listed stays gone. One the site
  // is deleting or upgrading opens only once the site closes its own
  // connections, if ever: the connection is closed as soon as it comes.
  const readDatabase = (name, ms) => new Promise((resolve, reject) => {
    let db = null;
    let gone = false;
    let done = false;
    const finish = (settle, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (db) db.close();
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('timed out')), ms);
    const opening = indexedDB.open(name);
    opening.onupgradeneeded = () => {
      gone = true;
      opening.transaction.abort();
    };
    opening.onerror = () => (gone ? finish(resolve, null) : finish(reject, opening.error));
    opening.onsuccess = () => {
      db = opening.result;
      if (done) db.close();
      else readStores(db).then((stores) => finish(resolve, { version: db.version, stores }), (error) => finish(reject, error));
    };
  });

  const localEntries = [];
  let leftOut = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    const value = localStorage.getItem(key);
    if (key === null || value === null) continue;
    if (value.length > ${MAX_LOCAL_STORAGE_VALUE_CHARS} || localEntries.length >= ${MAX_LOCAL_STORAGE_ENTRIES}) leftOut++;
    else localEntries.push([key, value]);
  }

  const databases = [];
  const until = Date.now() + ${MAX_INDEXEDDB_MS};
  const listed = await within(indexedDB.databases(), ${MAX_INDEXEDDB_DATABASE_MS}).catch(() => null);
  if (!listed) leftOut++;
  for (const info of listed ?? []) {
    if (!info.name) continue;
    const ms = Math.min(${MAX_INDEXEDDB_DATABASE_MS}, until - Date.now());
    if (databases.length >= ${MAX_DATABASES} || ms <= 0) {
      leftOut++;
      continue;
    }
    try {
      const read = await readDatabase(info.name, ms);
      if (read) databases.push({ name: info.name, version: read.version, stores: read.stores });
    } catch {
      // The rest is still read.
      leftOut++;
    }
  }

  return { localStorage: localEntries, indexedDB: databases, leftOut, unsupported: [...unsupported] };
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
