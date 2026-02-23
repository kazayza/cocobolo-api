const express = require('express');
const router = express.Router();
const clientsController = require('./clients.controller');

// ===================================
// 👥 Clients Routes
// ===================================

// الـ Routes الثابتة أولاً
router.get('/summary', clientsController.getSummary);
router.get('/search', clientsController.search);
router.get('/list', clientsController.getList);
router.get('/referral-sources', clientsController.getReferralSources);
router.get('/check-phone', clientsController.checkPhone);

// الـ Route الرئيسي
router.get('/', clientsController.getAll);
router.post('/', clientsController.create);

// الـ Routes اللي فيها :id
router.get('/:id', clientsController.getById);
router.put('/:id', clientsController.update);
router.delete('/:id', clientsController.remove);

module.exports = router;