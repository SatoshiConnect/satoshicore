// A deliberately small IndexedDB stand-in for the request-store tests.
//
// It implements only the surface the payment inbox uses: versioned open with
// onupgradeneeded, object stores/indexes, get/getAll/put, transactions and
// transaction completion. It also lets one readwrite transaction wait on a gate,
// which is how the expiry/status race is made deterministic without timing hacks.
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }

  succeed(result) {
    this.result = result;
    this.onsuccess?.({ target: this });
  }

  fail(error) {
    this.error = error;
    this.onerror?.({ target: this });
  }
}

class FakeTransaction {
  constructor(db, names, mode, gate = null) {
    this.db = db;
    this.names = Array.isArray(names) ? names : [names];
    this.mode = mode;
    this.gate = gate;
    this.pending = 0;
    this.completionQueued = false;
    this.done = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    queueMicrotask(() => this.completeIfIdle());
  }

  objectStore(name) {
    if (!this.names.includes(name)) throw new Error(`Store ${name} is not in this transaction.`);
    const base = this.db.stores.get(name);
    if (!base) throw new Error(`Unknown store ${name}.`);
    return new FakeStoreView(this, base);
  }

  schedule(work) {
    this.pending += 1;
    const run = () => {
      try {
        work();
      } catch (error) {
        this.error = error;
        this.onerror?.({ target: this });
        return;
      } finally {
        this.pending -= 1;
        this.completeIfIdle();
      }
    };
    if (this.gate) this.gate.promise.then(run, run);
    else queueMicrotask(run);
  }

  completeIfIdle() {
    if (this.done || this.pending !== 0 || this.completionQueued) return;
    this.completionQueued = true;
    queueMicrotask(() => {
      if (this.done || this.pending !== 0) return;
      this.done = true;
      this.oncomplete?.({ target: this });
    });
  }
}

class FakeIndex {
  constructor(store, keyPath) {
    this.store = store;
    this.keyPath = keyPath;
  }

  getAll(query) {
    return this.store.getAllByIndex(this.keyPath, query);
  }
}

class FakeStoreView {
  constructor(tx, base) {
    this.tx = tx;
    this.base = base;
  }

  put(value) {
    const request = new FakeRequest();
    this.tx.schedule(() => {
      this.base.data.set(value[this.base.keyPath], clone(value));
    });
    return request;
  }

  get(key) {
    const request = new FakeRequest();
    this.tx.schedule(() => {
      request.succeed(this.base.data.get(key));
    });
    return request;
  }

  getAll() {
    const request = new FakeRequest();
    this.tx.schedule(() => {
      request.succeed([...this.base.data.values()].map(clone));
    });
    return request;
  }

  getAllByIndex(keyPath, query) {
    const request = new FakeRequest();
    this.tx.schedule(() => {
      const values = [...this.base.data.values()]
        .filter((value) => value[keyPath] === query)
        .map(clone);
      request.succeed(values);
    });
    return request;
  }

  index(name) {
    const index = this.base.indexes.get(name);
    if (!index) throw new Error(`Unknown index ${name}.`);
    return new FakeIndex(this, index.keyPath);
  }

  clear() {
    this.tx.schedule(() => { this.base.data.clear(); });
  }
}

class FakeBaseStore {
  constructor(keyPath) {
    this.keyPath = keyPath;
    this.data = new Map();
    this.indexes = new Map();
  }

  createIndex(name, keyPath) {
    this.indexes.set(name, { name, keyPath });
  }
}

class FakeDB {
  constructor(factory, name, version) {
    this.factory = factory;
    this.name = name;
    this.version = version;
    this.stores = new Map();
    this.objectStoreNames = {
      contains: (name) => this.stores.has(name),
      [Symbol.iterator]: () => this.stores.keys(),
    };
  }

  createObjectStore(name, options = {}) {
    if (this.stores.has(name)) throw new Error(`Store ${name} already exists.`);
    const base = new FakeBaseStore(options.keyPath);
    this.stores.set(name, base);
    return base;
  }

  transaction(names, mode = 'readonly') {
    const list = Array.isArray(names) ? names : [names];
    let gate = null;
    if (mode === 'readwrite' && list.includes('requests') && this.factory.nextWriteGate) {
      gate = this.factory.nextWriteGate;
      this.factory.nextWriteGate = null;
      gate.startedResolve?.();
    }
    return new FakeTransaction(this, names, mode, gate);
  }

  close() {}
}

export class FakeIndexedDB {
  constructor() {
    this.databases = new Map();
    this.nextWriteGate = null;
  }

  open(name, version = 1) {
    const request = new FakeRequest();
    queueMicrotask(() => {
      let db = this.databases.get(name);
      const oldVersion = db?.version || 0;
      if (!db) {
        db = new FakeDB(this, name, version);
        this.databases.set(name, db);
      }
      const upgrading = version > oldVersion;
      if (upgrading) db.version = version;
      request.result = db;
      try {
        if (upgrading && request.onupgradeneeded) {
          request.onupgradeneeded({ target: request, oldVersion, newVersion: version });
        }
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.fail(error);
      }
    });
    return request;
  }

  /**
   * Hold the next readwrite transaction on `requests` until `release()`.
   * `started` resolves when that transaction is actually created.
   */
  holdNextRequestWrite() {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const gate = { promise, started, release, startedResolve };
    this.nextWriteGate = gate;
    return gate;
  }
}
