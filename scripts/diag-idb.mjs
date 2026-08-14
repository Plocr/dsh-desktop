// 枚举 IndexedDB 数据库与对象仓库，找 settings 缓存
const targets = await (await fetch('http://127.0.0.1:9223/json')).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id
    pending.set(i, { resolve, reject })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data))
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  }
}
await new Promise((r) => (ws.onopen = r))
const r = await call('Runtime.evaluate', {
  expression: `(async () => {
    const out = [];
    const dbs = await indexedDB.databases();
    for (const dbInfo of dbs) {
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open(dbInfo.name);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const stores = [...db.objectStoreNames];
      const dump = {};
      for (const s of stores) {
        const tx = db.transaction(s, 'readonly');
        const store = tx.objectStore(s);
        const keys = await new Promise((res, rej) => {
          const req = store.getAllKeys();
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        const vals = await new Promise((res, rej) => {
          const req = store.getAll();
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        dump[s] = keys.map((k, i) => ({ k: String(k).slice(0, 80), v: JSON.stringify(vals[i]).slice(0, 160) }));
      }
      out.push({ name: dbInfo.name, version: dbInfo.version, stores: dump });
      db.close();
    }
    return out;
  })()`,
  returnByValue: true,
  awaitPromise: true,
})
console.log(JSON.stringify(r.result.value, null, 1).slice(0, 4000))
ws.close()
process.exit(0)
