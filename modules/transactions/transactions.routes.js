const express = require('express');
const router = express.Router();
const transactionsController = require('./transactions.controller');

// ===================================
// 🧾 Transactions Routes
// ===================================

// ملخص الفواتير
// GET /api/transactions/summary?type=Sale
router.get('/summary', transactionsController.getSummary);

// جلب كل الفواتير
// GET /api/transactions?type=Sale&startDate=xxx&endDate=xxx&partyId=xxx
router.get('/', transactionsController.getAll);

// جلب فاتورة بالـ ID
// GET /api/transactions/:id
router.get('/:id', transactionsController.getById);

// إنشاء فاتورة جديدة
// POST /api/transactions
router.post('/', transactionsController.create);

// جلب مدفوعات فاتورة
// GET /api/transactions/:id/payments
router.get('/:id/payments', transactionsController.getPayments);

// إضافة دفعة لفاتورة
// POST /api/transactions/:id/payments
router.post('/:id/payments', transactionsController.addPayment);

// تصدير الراوتر
module.exports = router;