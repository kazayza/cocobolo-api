const express = require('express');
const router = express.Router();
const cashboxController = require('./cashbox.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { cashbox: cashboxPolicy } = require('../../shared/authorization.policy');

// ===================================
// 🏦 Cashbox Routes
// Phase 0: كانت الوحدة مفتوحة بالكامل — الآن جلسة + سياسات بمرآة حرّاس بلازور F-09.
// ===================================

router.use(authenticate);

const canView = requirePolicy(cashboxPolicy.canView, 'غير مصرح لك بعرض الخزينة');
const canCreateTransaction = requirePolicy(cashboxPolicy.canCreateTransaction, 'غير مصرح لك بتنفيذ هذا الإجراء على الخزينة');
const canAddBox = requirePolicy(cashboxPolicy.canAddBox, 'غير مصرح لك بإنشاء خزينة');
const canEditBox = requirePolicy(cashboxPolicy.canEditBox, 'غير مصرح لك بتعديل الخزينة');

// الداشبورد الكامل (كل البيانات في استجابة واحدة)
// GET /api/cashbox/dashboard/full
router.get('/dashboard/full', canView, cashboxController.getFullDashboard);

// ملخص الخزينة
// GET /api/cashbox/summary?cashboxId=xxx
router.get('/summary', canView, cashboxController.getSummary);

// جلب حركات الخزينة
// GET /api/cashbox/transactions?cashboxId=xxx&startDate=xxx&endDate=xxx&transactionType=xxx
router.get('/transactions', canView, cashboxController.getTransactions);

// إضافة حركة خزينة
// POST /api/cashbox/transactions
router.post('/transactions', canCreateTransaction, cashboxController.createTransaction);

// تحويل بين خزينتين
// POST /api/cashbox/transfer
router.post('/transfer', canCreateTransaction, cashboxController.transfer);

// إحصائيات الداشبورد
// GET /api/cashbox/dashboard/stats?period=today|week|month|year
router.get('/dashboard/stats', canView, cashboxController.getDashboardStats);

// بيانات الرسم البياني
// GET /api/cashbox/dashboard/chart?days=7
router.get('/dashboard/chart', canView, cashboxController.getChartData);

// توزيع المصروفات
// GET /api/cashbox/dashboard/distribution?period=month
router.get('/dashboard/distribution', canView, cashboxController.getDistribution);

// أرصدة الخزائن
// GET /api/cashbox/dashboard/balances
router.get('/dashboard/balances', canView, cashboxController.getCashboxBalances);

// آخر الحركات
// GET /api/cashbox/dashboard/recent?limit=5
router.get('/dashboard/recent', canView, cashboxController.getRecentTransactions);

// مقارنة شهرية
// GET /api/cashbox/dashboard/comparison
router.get('/dashboard/comparison', canView, cashboxController.getMonthlyComparison);

// جلب كل الخزائن
// GET /api/cashbox
router.get('/', canView, cashboxController.getAll);

// جلب الخزائن النشطة فقط — مطابق لبلازور GetCashBoxesAsync(activeOnly: true)
// GET /api/cashbox/active — يجب أن يكون قبل /:id حتى لا يُعامل كـ id
router.get('/active', canView, cashboxController.getActive);

// جلب خزينة بالـ ID
// GET /api/cashbox/:id
router.get('/:id', canView, cashboxController.getById);



// إنشاء خزينة جديدة
// POST /api/cashbox
router.post('/', canAddBox, cashboxController.create);

// تعديل خزينة
// PUT /api/cashbox/:id
router.put('/:id', canEditBox, cashboxController.update);

// تصدير الراوتر
module.exports = router;
