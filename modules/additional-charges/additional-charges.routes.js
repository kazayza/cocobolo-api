const express = require('express');
const router = express.Router();
const controller = require('./additional-charges.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { additionalCharges } = require('../../shared/authorization.policy');

router.use(authenticate);
router.get('/', requirePolicy(additionalCharges.canView), controller.getAll);
router.get('/lookups/form', requirePolicy(additionalCharges.canView), controller.getLookups);
router.post(
  '/',
  requirePolicy(additionalCharges.canCreate, 'غير مصرح لك بتسجيل رسوم أو دفعة مقدمة'),
  controller.create,
);
router.post(
  '/:id/apply',
  requirePolicy(additionalCharges.canApply, 'غير مصرح لك بتطبيق الرسوم على فاتورة'),
  controller.apply,
);
router.post(
  '/:id/non-refundable',
  requirePolicy(additionalCharges.canMarkNonRefundable, 'غير مصرح لك بتغيير حالة الرسوم'),
  controller.markNonRefundable,
);
router.get('/:id/receipt', requirePolicy(additionalCharges.canView), controller.getReceipt);
// دورة رسوم تعديل التسليم — الأدوار الدقيقة داخل الاستعلامات بمرآة بلازور
router.post(
  '/:id/approve-modification',
  requirePolicy(additionalCharges.canEdit, 'غير مصرح لك باعتماد رسوم التعديل'),
  controller.approveModification,
);
router.post(
  '/:id/reject-modification',
  requirePolicy(additionalCharges.canEdit, 'غير مصرح لك برفض رسوم التعديل'),
  controller.rejectModification,
);
router.post(
  '/:id/collect-modification',
  requirePolicy(additionalCharges.canEdit, 'غير مصرح لك بتحصيل رسوم التعديل'),
  controller.collectModification,
);
router.put(
  '/:id',
  requirePolicy(additionalCharges.canEdit, 'غير مصرح لك بتعديل الرسوم'),
  controller.update,
);
router.delete(
  '/:id',
  requirePolicy(additionalCharges.canDelete, 'غير مصرح لك بحذف الرسوم'),
  controller.remove,
);
router.get('/:id', requirePolicy(additionalCharges.canView), controller.getById);

module.exports = router;
