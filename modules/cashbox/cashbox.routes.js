const express = require('express');
const router = express.Router();
const cashboxController = require('./cashbox.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const policy = require('../../shared/authorization.policy');
const { cashbox: cashboxPolicy } = policy;

// ===================================
// 🏦 Cashbox Routes
// Phase 0: كانت الوحدة مفتوحة بالكامل — الآن جلسة + سياسات بمرآة حرّاس بلازور F-09.
// ===================================

router.use(authenticate);

const canView = requirePolicy(cashboxPolicy.canView, 'غير مصرح لك بعرض الخزينة');
const canCreateTransaction = requirePolicy(cashboxPolicy.canCreateTransaction, 'غير مصرح لك بتنفيذ هذا الإجراء على الخزينة');
const canAddBox = requirePolicy(cashboxPolicy.canAddBox, 'غير مصرح لك بإنشاء خزينة');
const canEditBox = requirePolicy(cashboxPolicy.canEditBox, 'غير مصرح لك بتعديل الخزينة');
const canDeleteBox = requirePolicy(cashboxPolicy.canDeleteBox, 'غير مصرح لك بحذف الخزينة');

// مراجعة الخزينة — قاعدة بلازور (CashBoxReview.razor): Admin أو AccountManager
// أو دور الحسابات أو حامل Claim frmCashBoxReview:View. تُسجَّل قبل /:id.
const canReview = requirePolicy(
  (a) => policy.roles.admin(a) || policy.roles.accountManager(a)
    || policy.roles.account(a) || policy.hasClaim(a, 'frmCashBoxReview:View'),
  'غير مصرح لك بمراجعة الخزينة',
);
router.get('/review', canReview, cashboxController.getReview);
router.get('/review/recent', canReview, cashboxController.getReviewRecent);
router.post('/review/stamp', canReview, cashboxController.stampReview);

// الداشبورد الكامل (كل البيانات في استجابة واحدة)
// GET /api/cashbox/dashboard/full
router.get('/dashboard/full', canView, cashboxController.getFullDashboard);

// ملخص الخزينة
// GET /api/cashbox/summary?cashboxId=xxx
router.get('/summary', canView, cashboxController.getSummary);

// جلب حركات الخزينة
// GET /api/cashbox/transactions?cashboxId=xxx&startDate=xxx&endDate=xxx&transactionType=xxx
router.get('/transactions', canView, cashboxController.getTransactions);

// حركة مفردة بالمعرف (فتح حركة من إشعار/رابط)
// GET /api/cashbox/transactions/:id
router.get('/transactions/:id', canView, cashboxController.getTransactionById);

// إضافة حركة خزينة
// POST /api/cashbox/transactions
router.post('/transactions', canCreateTransaction, cashboxController.createTransaction);

// تحويل بين خزينتين
// POST /api/cashbox/transfer
router.post('/transfer', canCreateTransaction, cashboxController.transfer);

// عملية يدوية بالأنواع الستة (قبض/صرف/قرض وارد/تسديد قرض/تحويل/رصيد افتتاحي)
// POST /api/cashbox/manual
router.post('/manual', canCreateTransaction, cashboxController.createManual);

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

// حذف خزينة (ممنوع عند وجود حركات — يرفضه الاستعلام برسالة بلازور)
// DELETE /api/cashbox/:id
router.delete('/:id', canDeleteBox, cashboxController.remove);

// تصدير الراوتر
module.exports = router;
