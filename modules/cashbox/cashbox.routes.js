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

// إحصائيات الداشبورد
// GET /api/cashbox/dashboard/stats?period=today|week|month|year
router.get('/dashboard/stats', cashboxController.getDashboardStats);

// بيانات الرسم البياني
// GET /api/cashbox/dashboard/chart?days=7
router.get('/dashboard/chart', cashboxController.getChartData);

// توزيع المصروفات
// GET /api/cashbox/dashboard/distribution?period=month
router.get('/dashboard/distribution', cashboxController.getDistribution);

// أرصدة الخزائن
// GET /api/cashbox/dashboard/balances
router.get('/dashboard/balances', cashboxController.getCashboxBalances);

// آخر الحركات
// GET /api/cashbox/dashboard/recent?limit=5
router.get('/dashboard/recent', cashboxController.getRecentTransactions);

// مقارنة شهرية
// GET /api/cashbox/dashboard/comparison
router.get('/dashboard/comparison', cashboxController.getMonthlyComparison);

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