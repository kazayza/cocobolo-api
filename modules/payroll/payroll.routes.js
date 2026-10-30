const express = require('express');
const router = express.Router();
const payrollController = require('./payroll.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { payroll: payrollPolicy } = require('../../shared/authorization.policy');

// ===================================
// 💵 Payroll Routes
// Phase 0: كانت الوحدة مفتوحة بالكامل — الآن جلسة + سياسات بمرآة PayrollList في بلازور.
// ===================================

router.use(authenticate);

const canView = requirePolicy(payrollPolicy.canView, 'غير مصرح لك بعرض المرتبات');
const canViewOrSelfEmployee = requirePolicy(payrollPolicy.canViewOrSelfEmployee, 'غير مصرح لك بعرض المرتبات');
const canViewOrLinked = requirePolicy(payrollPolicy.canViewOrLinked, 'غير مصرح لك بعرض المرتبات');
const canMutate = requirePolicy(payrollPolicy.canMutate, 'غير مصرح لك بتنفيذ هذا الإجراء على المرتبات');

// جلب مرتبات شهر معين
// GET /api/payroll?month=2025-01
router.get('/', canView, payrollController.getByMonth);

// قائمة الشهور المتاحة — يجب أن يكون قبل /:id
// GET /api/payroll/months
router.get('/months', canView, payrollController.getMonths);

// إحصائيات الرواتب
// GET /api/payroll/stats
router.get('/stats', canView, payrollController.getStats);

// جلب مرتبات موظف — المدير أو الموظف نفسه (استثناء الذات)
// GET /api/payroll/employee/:employeeId
router.get('/employee/:employeeId', canViewOrSelfEmployee, payrollController.getByEmployee);

// ══════════════════════════════════════════════════════════════
// دورة الرواتب الشهرية (البند 34) — قبل /:id حتى لا تُلتقط كمعرّف
// ══════════════════════════════════════════════════════════════

// حساب جماعي بلا حفظ
// POST /api/payroll/calculate
router.post('/calculate', canView, payrollController.calculate);

// حفظ تشغيل رواتب للمراجعة (PendingReview)
// POST /api/payroll/runs
router.post('/runs', canMutate, payrollController.createRun);

// قائمة تشغيلات الرواتب
// GET /api/payroll/runs?month=YYYY-MM
router.get('/runs', canView, payrollController.getRuns);

// جلب مرتب بالـ ID (القسيمة) — المدير أو أي مستخدم مربوط بموظف،
// والمتحكم يتحقق أن المرتب يخص موظف التوكن لغير المديرين
// GET /api/payroll/:id
router.get('/:id', canViewOrLinked, payrollController.getById);

// اعتماد مرتب (حارس المراجع الأضيق داخل المحرك)
// POST /api/payroll/:id/approve
router.post('/:id/approve', canMutate, payrollController.approve);

// رفض مرتب
// POST /api/payroll/:id/reject
router.post('/:id/reject', canMutate, payrollController.reject);

// صرف مرتب من خزينة
// POST /api/payroll/:id/pay
router.post('/:id/pay', canMutate, payrollController.pay);

// إنشاء مرتب جديد
// POST /api/payroll
router.post('/', canMutate, payrollController.create);

// تعديل مرتب
// PUT /api/payroll/:id
router.put('/:id', canMutate, payrollController.update);

// تحديث حالة الدفع
// PUT /api/payroll/:id/status
router.put('/:id/status', canMutate, payrollController.updateStatus);

// إضافة تفصيل للمرتب
// POST /api/payroll/:id/details
router.post('/:id/details', canMutate, payrollController.addDetail);

// حذف تفصيل
// DELETE /api/payroll/details/:detailId
router.delete('/details/:detailId', canMutate, payrollController.deleteDetail);

// تصدير الراوتر
module.exports = router;
