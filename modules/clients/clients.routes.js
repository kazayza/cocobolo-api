const express = require('express');
const router = express.Router();
const clientsController = require('./clients.controller');

// ===================================
// 👥 Clients Routes
// ===================================

// ✅ كل الـ Routes الثابتة أولاً (قبل أي :id)

router.get('/summary', clientsController.getSummary);
router.get('/search', clientsController.search);
router.get('/list', clientsController.getList);
router.get('/referral-sources', clientsController.getReferralSources);
router.get('/check-phone', clientsController.checkPhone);

// ✅ الـ Route الرئيسي
router.get('/', clientsController.getAll);
router.post('/', clientsController.create);

// ✅ الـ Routes اللي فيها :id في الآخر خالص
router.get('/:id([0-9]+)', clientsController.getById);  // فقط أرقام
router.put('/:id([0-9]+)', clientsController.update);   // فقط أرقام
router.delete('/:id([0-9]+)', clientsController.remove); // فقط أرقام

module.exports = router;