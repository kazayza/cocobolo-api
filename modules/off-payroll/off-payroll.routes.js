const express = require('express');
const router = express.Router();
const ctrl = require('./off-payroll.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { offPayroll: offPayrollPolicy } = require('../../shared/authorization.policy');

// بوابات بمرآة بلازور (PayrollService.cs:57-71): الدخول/الإنشاء/الإلغاء
// بـ CanEnterPayroll (أدوار العرض + مطالبات عرض الرواتب الثلاث)،
// والاعتماد/الرفض/الصرف ببوابة عمليات الرواتب ثم حارس المراجع الأضيق
// (Admin/AccountManager) داخل المحرك نفسه. كانت الوحدة مفتوحة لأي
// جلسة مصادقة — أُغلقت هنا كما أُغلقت وحدة الرواتب في المرحلة صفر.
const canEnter = requirePolicy(offPayrollPolicy.canEnter, 'غير مصرح لك بتنفيذ هذا الإجراء على الرواتب');
const canReviewOrPay = requirePolicy(offPayrollPolicy.canReviewOrPay, 'غير مصرح لك بتنفيذ هذا الإجراء على الرواتب');

router.get('/', authenticate, canEnter, ctrl.getAll);
router.get('/pending-installments/:employeeId', authenticate, canEnter, ctrl.pendingInstallments);
router.post('/', authenticate, canEnter, ctrl.create);
router.post('/:id/approve', authenticate, canReviewOrPay, ctrl.approve);
router.post('/:id/reject', authenticate, canReviewOrPay, ctrl.reject);
router.post('/:id/cancel', authenticate, canEnter, ctrl.cancel);
router.post('/:id/pay', authenticate, canReviewOrPay, ctrl.pay);
module.exports = router;
