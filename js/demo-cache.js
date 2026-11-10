/*
 * Remembers the last analysed demo for this tab, so navigating to the fun page
 * and back does not ask for the file again.
 *
 * Only the analysis result and (when it is not huge) the demo file itself are
 * stored in IndexedDB. IndexedDB is used instead of sessionStorage because the
 * result contains typed arrays (the map grid and heat cells) and can be several
 * megabytes; JSON would lose the typed arrays and blow the ~5 MB quota.
 *
 * A random id in sessionStorage ties the stored record to this tab: a reload or
 * the trip to fun.html keeps it, a new tab or a closed tab does not restore it.
 */
(function (g) {
  const DDA = (g.DDA = g.DDA || {});

  const DB_NAME = 'dda-cache';
  const DB_VERSION = 1;
  const STORE = 'last-demo';
  const SESSION_KEY = 'dda:session';
  // Big demos stay out of the database; their stats are restored, but replaying
  // them asks for the file again instead of quietly eating a second copy on disk.
  const MAX_FILE_BYTES = 100 * 1024 * 1024;
  // Records of tabs that were closed long ago are pruned on the next save.
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;

  let dbPromise = null;

  function sessionId() {
    try {
      let id = sessionStorage.getItem(SESSION_KEY);
      if (!id) {
        id = g.crypto && g.crypto.randomUUID
          ? g.crypto.randomUUID()
          : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
        sessionStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch (e) {
      return null; // storage disabled: caching is optional, the page still works
    }
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB is blocked'));
    });
    return dbPromise;
  }

  function run(mode, action) {
    return open().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      let value;
      if (request) request.onsuccess = () => { value = request.result; };
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    }));
  }

  DDA.DemoCache = {
    /** Stores the result of an analysis, plus the file when it is small enough. */
    save(result, file) {
      const session = sessionId();
      if (!session) return Promise.resolve(false);
      let storedFile = null;
      if (file && file.size <= MAX_FILE_BYTES) {
        try { storedFile = file; } catch (e) { storedFile = null; }
      }
      const record = {
        session,
        savedAt: Date.now(),
        result,
        name: file ? file.name : result.header.mapName,
        size: file ? file.size : 0,
        lastModified: file ? file.lastModified : Date.now(),
        file: storedFile,
      };
      return run('readwrite', (store) => {
        store.put(record, session); // one record per tab, so tabs never clobber each other
        // Drop records of tabs that are long gone (the same tab key is overwritten above).
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const value = cursor.value;
          if (cursor.key !== session &&
              (!value || !value.savedAt || Date.now() - value.savedAt > MAX_AGE_MS)) {
            cursor.delete();
          }
          cursor.continue();
        };
        return null;
      })
        .then(() => true)
        .catch(() => false);
    },

    /** Returns this tab's stored record, or null. */
    load() {
      const session = sessionId();
      if (!session) return Promise.resolve(null);
      return run('readonly', (store) => store.get(session))
        .then((record) => (record && record.session === session ? record : null))
        .catch(() => null);
    },

    clear() {
      const session = sessionId();
      if (!session) return Promise.resolve(undefined);
      return run('readwrite', (store) => store.delete(session)).catch(() => undefined);
    },

    /** True when the stored record kept the demo file (so replay still works). */
    hasFile(record) {
      return !!(record && record.file);
    },
  };
})(globalThis);
