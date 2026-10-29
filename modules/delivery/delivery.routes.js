const express = require('express');
const router = express.Router();
const controller = require('./delivery.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { delivery } = require('../../shared/authorization.policy');

router.use(authenticate);

router.get('/list', requirePolicy(delivery.canView), controller.getDeliveries);
router.get('/stats', requirePolicy(delivery.canView), controller.getDeliveryStats);
router.get('/employees', requirePolicy(delivery.canEditFull), controller.getEmployees);
router.get('/daily-sheet', requirePolicy(delivery.canPrint), controller.getDailySheet);
router.get('/upcoming', requirePolicy(delivery.canView), controller.getUpcomingDeliveries);

router.post(
  '/:id/request-permission',
  requirePolicy(delivery.canConfirm, 'غير مصرح لك بطلب إذن التسليم'),
  controller.requestPermission,
);
router.post(
  '/:id/grant-permission',
  requirePolicy(delivery.canOverrideRemaining, 'منح إذن التسليم متاح للإدارة ومدير الحسابات فقط'),
  controller.grantPermission,
);
router.put(
  '/:id/deliver',
  requirePolicy(delivery.canConfirm, 'غير مصرح لك بتأكيد التسليم'),
  controller.markAsDelivered,
);

// أحداث التسليم (التسليم على دفعات) — الأحداث مصدر الحقيقة كما في بلازور
router.get(
  '/:id/events',
  requirePolicy(delivery.canView, 'غير مصرح بعرض تسليمات الفاتورة'),
  controller.getEvents,
);
router.post(
  '/:id/events/coverage',
  requirePolicy(delivery.canConfirm, 'غير مصرح بتسجيل التسليم'),
  controller.getCoverage,
);
router.post(
  '/:id/events',
  requirePolicy(delivery.canConfirm, 'غير مصرح بتسجيل التسليم'),
  controller.recordEvent,
);
router.post(
  '/:id/events/:deliveryId/void',
  requirePolicy(delivery.canOverrideRemaining, 'إلغاء التسليمات متاح للمدير ومدير الحسابات فقط'),
  controller.voidEvent,
);
router.put(
  '/:id',
  requirePolicy(delivery.canEditFull, 'غير مصرح لك بتعديل بيانات التسليم'),
  controller.updateDeliveryDetails,
);
router.get('/:id', requirePolicy(delivery.canView), controller.getDeliveryDetails);

module.exports = router;
