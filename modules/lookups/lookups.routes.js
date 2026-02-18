const express = require('express');
const router = express.Router();
const ctrl = require('./lookups.controller');

// ===================================
// 📢 الحملات الإعلانية
// ===================================
router.get('/ad-types', ctrl.getAdTypes);
router.post('/ad-types', ctrl.createAdType);
router.put('/ad-types/:id', ctrl.updateAdType);
router.delete('/ad-types/:id', ctrl.deleteAdType);

// ===================================
// 📱 مصادر التواصل
// ===================================
router.get('/sources', ctrl.getSources);
router.post('/sources', ctrl.createSource);
router.put('/sources/:id', ctrl.updateSource);
router.delete('/sources/:id', ctrl.deleteSource);

module.exports = router;