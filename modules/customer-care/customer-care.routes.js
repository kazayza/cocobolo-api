const express = require('express');
const router = express.Router();
const controller = require('./customer-care.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { customerCare } = require('../../shared/authorization.policy');

router.use(authenticate);
router.get(
  '/dashboard',
  requirePolicy(customerCare.canView, 'غير مصرح لك بعرض خدمة العملاء'),
  controller.getDashboard,
);
router.get(
  '/history',
  requirePolicy(customerCare.canView, 'غير مصرح لك بعرض سجل خدمة العملاء'),
  controller.getHistory,
);
router.get(
  '/export',
  requirePolicy(customerCare.canExport, 'غير مصرح لك بتصدير سجل خدمة العملاء'),
  controller.exportRows,
);
router.post(
  '/log',
  requirePolicy(customerCare.canLog, 'غير مصرح لك بتسجيل الفيدباك'),
  controller.logOutcome,
);
router.delete(
  '/:id',
  requirePolicy(customerCare.canHide, 'إخفاء السجل متاح للإدارة فقط'),
  controller.hideFeedback,
);

module.exports = router;
