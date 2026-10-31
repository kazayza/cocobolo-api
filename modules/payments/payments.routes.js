const express = require('express');
const router = express.Router();
const ctrl = require('./payments.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { payments } = require('../../shared/authorization.policy');

// وحدة المدفوعات — بوابات بلازور (PaymentService.CanMutatePayment):
// العرض والسند: frm_Payments:View أو Admin؛ الحذف: frm_Payments:Delete
// أو Admin حصرًا (بلا بديل أدوار)؛ الإنشاء/التعديل تُحسمان داخل
// المتحكم بنوع الفاتورة (بيع/شراء) عبر payments.canCreate/canEdit.
const canView = requirePolicy(payments.canView, 'غير مصرح لك بعرض المدفوعات');
const canDelete = requirePolicy(payments.canDelete, 'غير مصرح لك بإلغاء المدفوعات');

router.use(authenticate);

router.get('/stats', canView, ctrl.stats);
router.get('/analysis/:transactionId', canView, ctrl.analysis);
router.get('/:id/receipt', canView, ctrl.receipt);
router.get('/', canView, ctrl.list);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);
router.delete('/:id', canDelete, ctrl.remove);

module.exports = router;
