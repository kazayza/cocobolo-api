const express = require('express');
const router = express.Router();
const cashboxController = require('./cashbox.controller');

// ===================================
// 🏦 Cashbox Routes
// ===================================

// ملخص الخزينة
// GET /api/cashbox/summary?cashboxId=xxx
router.get('/summary', cashboxController.getSummary);

// جلب حركات الخزينة
// GET /api/cashbox/transactions?cashboxId=xxx&startDate=xxx&endDate=xxx&transactionType=xxx
router.get('/transactions', cashboxController.getTransactions);

// إضافة حركة خزينة
// POST /api/cashbox/transactions
router.post('/transactions', cashboxController.createTransaction);

// تحويل بين خزينتين
// POST /api/cashbox/transfer
router.post('/transfer', cashboxController.transfer);

// جلب كل الخزائن
// GET /api/cashbox
router.get('/', cashboxController.getAll);

// جلب خزينة بالـ ID
// GET /api/cashbox/:id
router.get('/:id', cashboxController.getById);



// إنشاء خزينة جديدة
// POST /api/cashbox
router.post('/', cashboxController.create);

// تعديل خزينة
// PUT /api/cashbox/:id
router.put('/:id', cashboxController.update);

// تصدير الراوتر
module.exports = router;