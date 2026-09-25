// Page-side functions for browser storage capture/restore. They run on a
// blank stub document served for the target origin, so they see that origin's
// localStorage and IndexedDB without loading the real site. Values travel as
// CDP call arguments and return values, never as source text.

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

export const READ_ORIGIN_STORAGE_FUNCTION = `async function() {
  ${CODEC}
  const unsupported = new Set();
  const encode = async (value) => {
    if (value === undefined) return { $t: 'undefined' };
    if (typeof value === 'bigint') return { $t: 'bigint', v: String(value) };
    if (typeof value === 'number' && !Number.isFinite(value)) return { $t: 'number', v: String(value) };
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return { $t: 'date', v: value.getTime() };
    if (value instanceof ArrayBuffer) return { $t: 'arraybuffer', v: toBase64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value)) {
      return { $t: 'view', ctor: value.constructor.name, v: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    }
    if (value instanceof File) {
      return { $t: 'file', name: value.name, type: value.type, lastModified: value.lastModified, v: toBase64(new Uint8Array(await value.arrayBuffer())) };
    }
    if (value instanceof Blob) return { $t: 'blob', type: value.type, v: toBase64(new Uint8Array(await value.arrayBuffer())) };
    if (value instanceof Map) return { $t: 'map', v: await Promise.all([...value].map(async ([k, v]) => [await encode(k), await encode(v)])) };
    if (value instanceof Set) return { $t: 'set', v: await Promise.all([...value].map(encode)) };
    if (value instanceof RegExp) return { $t: 'regexp', source: value.source, flags: value.flags };
    if (Array.isArray(value)) return Promise.all(value.map(encode));
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = await encode(v);
      return Object.prototype.hasOwnProperty.call(out, '$t') ? { $t: 'object', v: out } : out;
    }
    // e.g. a non-extractable CryptoKey: it cannot leave this browser.
    const type = (value.constructor && value.constructor.name) || 'object';
    unsupported.add(type);
    return { $t: 'unsupported', type };
  };

  const localEntries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    localEntries.push([key, localStorage.getItem(key)]);
  }

  const databases = [];
  for (const info of await indexedDB.databases()) {
    if (!info.name) continue;
    const db = await request(indexedDB.open(info.name));
    try {
      const stores = [];
      for (const name of [...db.objectStoreNames]) {
        const store = db.transaction(name, 'readonly').objectStore(name);
        const keysRequest = store.getAllKeys();
        const valuesRequest = store.getAll();
        const [keys, values] = await Promise.all([request(keysRequest), request(valuesRequest)]);
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
      databases.push({ name: info.name, version: db.version, stores });
    } finally {
      db.close();
    }
  }

  return { localStorage: localEntries, indexedDB: databases, unsupported: [...unsupported] };
}`

export const WRITE_ORIGIN_STORAGE_FUNCTION = `async function(data) {
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
      // A plain object that itself has a "$t" field: its fields are data, not a type tag.
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
  const deleteDatabase = (name) => new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    const timer = setTimeout(() => reject(new Error('IndexedDB database is in use by an open page')), 5000);
    req.onsuccess = () => { clearTimeout(timer); resolve(); };
    req.onerror = () => { clearTimeout(timer); reject(req.error); };
  });

  localStorage.clear();
  for (const [key, value] of data.localStorage) localStorage.setItem(key, value);

  for (const info of await indexedDB.databases()) {
    if (info.name) await deleteDatabase(info.name);
  }

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

  return { localStorage: data.localStorage.length, indexedDB: data.indexedDB.length, skippedRecords };
}`

export const READ_SESSION_STORAGE_FUNCTION = `function() {
  const entries = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    entries.push([key, sessionStorage.getItem(key)]);
  }
  return entries;
}`

export const WRITE_SESSION_STORAGE_FUNCTION = `function(entries) {
  sessionStorage.clear();
  for (const [key, value] of entries) sessionStorage.setItem(key, value);
  return entries.length;
}`
