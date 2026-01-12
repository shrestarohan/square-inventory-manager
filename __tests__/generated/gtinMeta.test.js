const request = require('supertest');
const express = require('express');
const buildGtinMetaRouter = require('../../routes/gtinMeta');

// A lightweight in-memory Firestore-like fake for deterministic tests
function createFakeFirestore(initial = {}) {
  // initial = { collectionName: { docId: { ...data } } }
  const db = new Map();
  for (const [col, docs] of Object.entries(initial)) {
    db.set(col, new Map(Object.entries(docs)));
  }

  function ensureCollection(name) {
    if (!db.has(name)) db.set(name, new Map());
    return db.get(name);
  }

  function makeDocSnapshot(id, data) {
    return {
      id,
      exists: data !== undefined,
      data: () => data,
    };
  }

  class Query {
    constructor(colName) {
      this.colName = colName;
      this.orderBys = [];
      this.startAtVal = undefined;
      this.endAtVal = undefined;
      this.startAfterArgs = undefined; // either [docSnapshot] or [v,id]
      this._limit = Infinity;
    }
    orderBy(field) {
      this.orderBys.push(field);
      return this;
    }
    startAt(v) {
      this.startAtVal = v;
      return this;
    }
    endAt(v) {
      this.endAtVal = v;
      return this;
    }
    startAfter(...args) {
      this.startAfterArgs = args;
      return this;
    }
    limit(n) {
      this._limit = n;
      return this;
    }
    async get() {
      const col = ensureCollection(this.colName);
      // Build docs array from col map
      const items = [];
      for (const [id, data] of col.entries()) {
        items.push({ id, data });
      }

      let docs = [];
      const ordering = this.orderBys.slice();
      const isComposite = ordering.includes('itemName_lc');

      if (isComposite) {
        // prefix search on itemName_lc using startAtVal
        const q = this.startAtVal || '';
        docs = items.filter(it => {
          const v = (it.data.itemName_lc || '').toString();
          return v.startsWith(q);
        });
        // sort by itemName_lc then id
        docs.sort((a, b) => {
          const av = (a.data.itemName_lc || '').toString();
          const bv = (b.data.itemName_lc || '').toString();
          if (av < bv) return -1;
          if (av > bv) return 1;
          if (a.id < b.id) return -1;
          if (a.id > b.id) return 1;
          return 0;
        });
        // apply startAfter if composite (two-arg)
        if (this.startAfterArgs && this.startAfterArgs.length === 2) {
          const [v, id] = this.startAfterArgs;
          let found = false;
          const filtered = [];
          for (const d of docs) {
            if (!found) {
              if ((d.data.itemName_lc || '') === v && d.id === id) {
                found = true;
              }
              continue;
            }
            filtered.push(d);
          }
          docs = filtered;
        }
      } else {
        // docId mode: order by __name__ -> order by id lexicographically
        docs = items.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        // startAfter may be a docSnapshot
        if (this.startAfterArgs && this.startAfterArgs.length === 1) {
          const docSnap = this.startAfterArgs[0];
          if (docSnap && docSnap.id) {
            const cursorId = docSnap.id;
            docs = docs.filter(d => d.id > cursorId);
          }
        }
      }

      // apply limit
      const sliced = docs.slice(0, this._limit);
      const snapDocs = sliced.map(d => makeDocSnapshot(d.id, d.data));
      return { docs: snapDocs, size: snapDocs.length };
    }
  }

  function collection(name) {
    ensureCollection(name);
    return {
      doc(id) {
        return {
          async get() {
            const col = ensureCollection(name);
            const data = col.get(id);
            return makeDocSnapshot(id, data);
          },
          async set(data, opts) {
            const col = ensureCollection(name);
            const existing = col.get(id) || {};
            const merged = Object.assign({}, existing, data);
            col.set(id, merged);
            return;
          },
        };
      },
      orderBy(field) {
        return new Query(name).orderBy(field);
      },
    };
  }

  return { collection };
}

// A simple requireLogin middleware that just passes through
function requireLogin(req, res, next) {
  // In real app, might set req.user. For tests, simply continue.
  next();
}

function buildApp(firestore) {
  const app = express();
  app.use(express.json());
  const router = buildGtinMetaRouter({ firestore, requireLogin, createSquareClient: () => {} });
  app.use(router);
  return app;
}

describe('/api/gtin-meta routes', () => {
  test('GET no q (docId mode) returns all docs and docId nextCursor; supports cursor startAfter', async () => {
    const initial = {
      gtinMeta: {
        '100': { itemName: 'Item 100' },
        '200': { itemName: 'Item 200' },
        '300': { itemName: 'Item 300' },
      },
    };
    const firestore = createFakeFirestore(initial);
    const app = buildApp(firestore);

    // first: no cursor -> should get all 3, nextCursor = last id '300'
    const res1 = await request(app).get('/api/gtin-meta');
    expect(res1.status).toBe(200);
    expect(res1.body.rows.map(r => r.id)).toEqual(['100', '200', '300']);
    expect(res1.body.nextCursor).toBe('300');

    // second: with cursor '100' -> should start after 100 => ['200','300']
    const res2 = await request(app).get('/api/gtin-meta').query({ cursor: '100' });
    expect(res2.status).toBe(200);
    expect(res2.body.rows.map(r => r.id)).toEqual(['200', '300']);
    expect(res2.body.nextCursor).toBe('300');
  });

  test('GET with numeric q >=8 chars returns direct doc or empty when not exists', async () => {
    const initial = {
      gtinMeta: {
        '12345678': { itemName: 'Special Item', vendorName: 'Acme' },
      },
    };
    const firestore = createFakeFirestore(initial);
    const app = buildApp(firestore);

    // existing doc
    const res1 = await request(app).get('/api/gtin-meta').query({ q: '12345678' });
    expect(res1.status).toBe(200);
    expect(res1.body.rows).toHaveLength(1);
    expect(res1.body.rows[0].id).toBe('12345678');
    expect(res1.body.nextCursor).toBeNull();

    // non-existing doc
    const res2 = await request(app).get('/api/gtin-meta').query({ q: '99999999' });
    expect(res2.status).toBe(200);
    expect(res2.body.rows).toEqual([]);
    expect(res2.body.nextCursor).toBeNull();
  });

  test('GET with non-digit q performs prefix search on itemName_lc and returns composite cursor; supports decoded cursor startAfter', async () => {
    const initial = {
      gtinMeta: {
        a: { itemName: 'Apple', itemName_lc: 'apple' },
        b: { itemName: 'Applesauce', itemName_lc: 'applesauce' },
        c: { itemName: 'Banana', itemName_lc: 'banana' },
      },
    };
    const firestore = createFakeFirestore(initial);
    const app = buildApp(firestore);

    // query 'app' should match 'apple' and 'applesauce'
    const res1 = await request(app).get('/api/gtin-meta').query({ q: 'app' });
    expect(res1.status).toBe(200);
    expect(res1.body.rows.map(r => r.id)).toEqual(['a', 'b']);
    // nextCursor should be base64 JSON of last item's v and id
    const nextCursor1 = res1.body.nextCursor;
    expect(typeof nextCursor1).toBe('string');
    const decoded = JSON.parse(Buffer.from(nextCursor1, 'base64').toString('utf8'));
    expect(decoded).toEqual({ v: 'applesauce', id: 'b' });

    // Now supply cursor that points to the first item (apple, id a) so results start after it -> only 'applesauce'
    const cursorForApple = Buffer.from(JSON.stringify({ v: 'apple', id: 'a' }), 'utf8').toString('base64');
    const res2 = await request(app).get('/api/gtin-meta').query({ q: 'app', cursor: cursorForApple });
    expect(res2.status).toBe(200);
    expect(res2.body.rows.map(r => r.id)).toEqual(['b']);
    const decoded2 = JSON.parse(Buffer.from(res2.body.nextCursor, 'base64').toString('utf8'));
    expect(decoded2).toEqual({ v: 'applesauce', id: 'b' });
  });

  test('PUT saves gtinMeta and item_master and returns updated meta; handles unitCost parsing and merging', async () => {
    const initial = {
      gtinMeta: {},
      item_master: {},
    };
    const firestore = createFakeFirestore(initial);
    const app = buildApp(firestore);

    const payload = {
      sku: ' SKU-1 ',
      itemName: ' My Item ',
      vendorName: 'Vendor X',
      unitCost: '12.50',
    };

    const res = await request(app).put('/api/gtin-meta/0001').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.gtin).toBe('0001');
    expect(res.body.gtinMeta).toBeDefined();
    expect(res.body.gtinMeta.id).toBe('0001');
    // Confirm fields stored (sku trimmed, itemName trimmed, itemName_lc stored)
    expect(res.body.gtinMeta.sku).toBe('SKU-1');
    expect(res.body.gtinMeta.itemName).toBe('My Item');
    expect(res.body.gtinMeta.itemName_lc).toBe('my item');
    expect(res.body.gtinMeta.vendorName).toBe('Vendor X');
    expect(res.body.gtinMeta.unitCost).toBe(12.5);

    // Confirm item_master was updated
    const itemMasterCol = firestore.collection('item_master');
    const itemSnap = await itemMasterCol.doc('0001').get();
    expect(itemSnap.exists).toBe(true);
    expect(itemSnap.data().canonical_name).toBe('My Item');
    expect(itemSnap.data().updated_at).toBeDefined();
  });

  test('PUT rejects invalid unitCost (non-numeric) with 400', async () => {
    const firestore = createFakeFirestore({ gtinMeta: {}, item_master: {} });
    const app = buildApp(firestore);

    const res = await request(app).put('/api/gtin-meta/0002').send({ unitCost: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unitCost must be a number/);
  });

  test('PUT with empty gtin param returns 400', async () => {
    const firestore = createFakeFirestore({ gtinMeta: {}, item_master: {} });
    const app = buildApp(firestore);

    // URL-encoded space becomes a param that trims to empty
    const res = await request(app).put('/api/gtin-meta/%20').send({ itemName: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing gtin');
  });
});
