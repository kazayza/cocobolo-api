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

// جلب مرتبات موظف
// GET /api/payroll/employee/:employeeId
router.get('/employee/:employeeId', canView, payrollController.getByEmployee);

// جلب مرتب بالـ ID
// GET /api/payroll/:id
router.get('/:id', canView, payrollController.getById);

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
