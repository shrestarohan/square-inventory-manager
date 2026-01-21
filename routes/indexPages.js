const express = require('express');
const comingSoon = require('./comingSoon');

module.exports = function buildIndexPagesRouter({ firestore, requireLogin }) {
  const router = express.Router();

  router.get('/', (req, res) => res.redirect('/login'));

  router.get('/reorder', requireLogin, comingSoon('Reorder Recommendations'));

  router.get('/dashboard', requireLogin, async (req, res) => {
    try {
      const merchantsSnap = await firestore.collection('merchants').get();
      const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      res.render('dashboard', {
        rows: [],
        merchants,
        merchantId: null,
        merchant: null,
        currentView: 'item',
        pageTitle: 'Inventory Dashboard',
        activePage: 'dashboard',
      });
    } catch (err) {
      console.error('Error loading dashboard', err);
      res.status(500).send('Failed to load dashboard: ' + err.message);
    }
  });

  router.get('/dashboard/:merchantId', requireLogin, async (req, res) => {
    const { merchantId } = req.params;

    try {
      const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
      if (!merchantDoc.exists) return res.status(404).send(`Merchant ${merchantId} not found`);

      const merchantsSnap = await firestore.collection('merchants').get();
      const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      res.render('dashboard', {
        rows: [],
        merchants,
        merchantId,
        merchant: merchantDoc.data(),
        activePage: 'dashboard',
      });
    } catch (err) {
      console.error('Error loading merchant dashboard', err);
      res.status(500).send('Failed to load merchant dashboard: ' + err.message);
    }
  });

  // All merchants (no merchantId)
  router.get('/dashboard-gtin', requireLogin, async (req, res) => {
    try {
      const merchantsSnap = await firestore.collection('merchants').get();
      const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      res.render('dashboard_gtin', {
        merchants,
        pageTitle: 'Price Mismatch Dashboard',
        activePage: 'dashboard-gtin',
        query: req.query,
      });
    } catch (err) {
      console.error('Error loading /dashboard-gtin:', err);
      res.status(500).send('Failed to load page: ' + err.message);
    }
  });

  router.get('/duplicates-gtin', requireLogin, async (req, res) => {
    try {
      const merchantsSnap = await firestore.collection('merchants').get();
      const merchants = merchantsSnap.docs.map(d => {
        const data = d.data() || {};
        const displayName =
          data.merchant_name ||
          data.business_name ||
          data.name ||
          data.store_name ||
          d.id;

        return { id: d.id, business_name: displayName };
      });

      res.render('duplicates_gtin', {
        merchants,
        pageTitle: 'Duplicate GTINs',
        activePage: 'duplicates-gtin',
      });
    } catch (err) {
      console.error('Error loading duplicates page:', err);
      res.status(500).send('Failed to load duplicates page: ' + err.message);
    }
  });

  // Vendor & Unit Cost page
  router.get('/dashboard-vendor-costs', requireLogin, async (req, res) => {
    try {
      const merchantsSnap = await firestore.collection('merchants').get();
      const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      res.render('dashboard-vendor-costs', {
        merchants,
        pageTitle: 'Vendor & Unit Cost',
        currentView: 'vendorCosts',
        activePage: 'dashboard-vendor-costs',
        user: req.user || null,
      });
    } catch (err) {
      console.error('Error loading /dashboard-vendor-costs:', err);
      res.status(500).send('Failed to load page: ' + err.message);
    }
  });

  // Inventory Integrity page
  router.get('/inventory-integrity', requireLogin, async (req, res) => {
    try {
      const merchantsSnap = await firestore.collection('merchants').get();
      const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      res.render('inventory-integrity', {
        merchants,
        merchantId: null,
        merchant: null,
        activePage: 'inventory-integrity',
        pageTitle: 'Inventory Integrity',
        user: req.user || null,
      });
    } catch (err) {
      console.error('Error loading /inventory-integrity:', err);
      res.status(500).send('Failed to load page: ' + err.message);
    }
  });

  // Reports ✅ (this is what you're missing)
  router.get('/reports', requireLogin, async (req, res) => {
    try {
      const full = req.query.full === '1';
      const lite = !full;

      // fast counts
      const merchantsAgg = await firestore.collection('merchants').count().get();
      const totalMerchants = merchantsAgg.data().count || 0;

      const masterInvAgg = await firestore.collection('inventory').count().get();
      const masterInventoryCount = masterInvAgg.data().count || 0;

      const merchantInvAgg = await firestore.collectionGroup('inventory').count().get();
      const merchantInventoryCount = merchantInvAgg.data().count || 0;

      let gtinMetaCount = 0;
      try {
        const gtinMetaAgg = await firestore.collection('gtinMeta').count().get();
        gtinMetaCount = gtinMetaAgg.data().count || 0;
      } catch {}

      const merchantsSnap = await firestore.collection('merchants').get();
      const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      // lite per-merchant counts (optional)
      const perMerchantLite = [];
      if (lite) {
        for (const m of merchants) {
          try {
            const agg = await firestore
              .collection('merchants')
              .doc(m.id)
              .collection('inventory')
              .count()
              .get();

            perMerchantLite.push({
              merchantId: m.id,
              merchantName: m.business_name || m.id,
              inventoryDocCount: agg.data().count || 0,
            });
          } catch (e) {
            perMerchantLite.push({
              merchantId: m.id,
              merchantName: m.business_name || m.id,
              inventoryDocCount: null,
              error: e.message,
            });
          }
        }
      }

      // recent sync runs (optional)
      let syncRuns = [];
      try {
        const syncSnap = await firestore
          .collection('syncRuns')
          .orderBy('runAt', 'desc')
          .limit(20)
          .get();
        syncRuns = syncSnap.docs.map(d => d.data());
      } catch {}

      res.render('reports', {
        merchants,
        lite,
        metrics: {
          totalMerchants,
          masterInventoryCount,
          merchantInventoryCount,
          gtinMetaCount,
          perMerchantLite,
          // you can add the heavy/full metrics later
          dataQuality: null,
          perMerchant: [],
          pricing: null,
        },
        syncRuns,
        activePage: 'reports',
        user: req.user || null,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Error building reports page:', err);
      res.status(500).send('Error loading reports: ' + err.message);
    }
  });
  
  router.get("/categories", requireLogin, async (req, res) => {
    const merchantsSnap = await firestore.collection("merchants").get();
    const merchants = merchantsSnap.docs.map(d => ({
      id: d.id,
      ...d.data(),
    }));

    res.render("categories", {
      pageTitle: "Category Manager",
      currentView: "categories",
      activePage: "categories",
      merchants,
    });
  });

  router.get("/category-matrix", requireLogin, async (req, res) => {
    const mSnap = await firestore.collection("merchants").get();
    const merchants = mSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.render("category-matrix", {
      pageTitle: "Category Matrix",
      currentView: "categories",
      activePage: "category-matrix",
      merchants,
      showFilters: false,
    });
  });

  return router;
};
