const express = require('express');
const router = express.Router();
const controller = require('./delivery.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { delivery } = require('../../shared/authorization.policy');

router.use(authenticate);

// Local predicates mirroring Blazor DeliveryPermissions.cs for the
// maintenance + schedule-change surfaces (shared policy file unchanged):
function _norm(v) { return String(v || '').toLowerCase().replace(/[\s_-]+/g, ''); }
function _role(auth, ...roles) { const c = _norm(auth?.role); return roles.some((x) => c === _norm(x)); }
function _claim(auth, claim) { return auth?.claims instanceof Set && auth.claims.has(claim); }
const canViewMaintenance = (a) => _role(a, 'Admin', 'AccountManager', 'ProductionManager', 'FactoryManager', 'DeliveryOfficer') || _claim(a, 'frmDeliveryMaintenance:View');
const canEditMaintenance = (a) => _role(a, 'Admin', 'ProductionManager', 'FactoryManager') || _claim(a, 'frmDeliveryMaintenance:Edit') || _role(a, 'AccountManager');
const canRequestSchedule = (a) => _role(a, 'DeliveryOfficer', 'ProductionManager');
const canDecideSchedule = (a) => _role(a, 'Admin', 'AccountManager');


router.get('/list', requirePolicy(delivery.canView), controller.getDeliveries);
router.get('/stats', requirePolicy(delivery.canView), controller.getDeliveryStats);
router.get('/employees', requirePolicy(delivery.canEditFull), controller.getEmployees);
router.get('/daily-sheet', requirePolicy(delivery.canPrint), controller.getDailySheet);
router.get('/upcoming', requirePolicy(delivery.canView), controller.getUpcomingDeliveries);
router.get('/home-upcoming', requirePolicy(delivery.canView), controller.getHomeUpcoming);

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
// ── Item 5 (Pkg2): delivery maintenance queue ─────────────────────
router.get('/maintenance/queue', requirePolicy(canViewMaintenance, 'غير مصرح بعرض صيانة التسليمات'), controller.getMaintenanceQueue);
router.post('/maintenance/:maintenanceId/start', requirePolicy(canEditMaintenance, 'غير مصرح ببدء الصيانة'), controller.maintenanceTransition('start'));
router.post('/maintenance/:maintenanceId/ready', requirePolicy(canEditMaintenance, 'غير مصرح بتعليم الجاهزية'), controller.maintenanceTransition('ready'));
router.post('/maintenance/:maintenanceId/unrepairable', requirePolicy(canEditMaintenance, 'غير مصرح بتعليم التعذّر'), controller.maintenanceTransition('unrepairable'));
router.post('/maintenance/:maintenanceId/close-replacement', requirePolicy(canEditMaintenance, 'غير مصرح بالإغلاق باستبدال'), controller.maintenanceTransition('close-replacement'));
router.post('/maintenance/:maintenanceId/close-credit', requirePolicy(delivery.canOverrideRemaining, 'الإغلاق بردّ نهائي متاح للمدير ومدير الحسابات فقط'), controller.maintenanceTransition('close-credit'));
router.post('/maintenance/:maintenanceId/cancel', requirePolicy(delivery.canOverrideRemaining, 'إلغاء الصيانة متاح للمدير ومدير الحسابات فقط'), controller.maintenanceTransition('cancel'));
router.post('/maintenance/:maintenanceId/reclassify', requirePolicy(canEditMaintenance, 'غير مصرح بإعادة التصنيف'), controller.maintenanceTransition('reclassify'));

// ── Item 6 (Pkg2): schedule-change requests ───────────────────────
router.get('/schedule-change-requests/:requestId/approval', requirePolicy(canDecideSchedule, 'شاشة الاعتماد متاحة للمدير ومدير الحسابات فقط'), controller.getScheduleApproval);
router.post('/schedule-change-requests/:requestId/withdraw', requirePolicy(delivery.canView), controller.withdrawScheduleRequest);
router.post('/schedule-change-requests/:requestId/decide', requirePolicy(canDecideSchedule, 'البتّ في طلبات تعديل المواعيد متاح للمدير ومدير الحسابات فقط'), controller.decideScheduleRequest);
router.get('/:id/schedule-change-requests', requirePolicy(delivery.canView), controller.getScheduleRequests);
router.post('/:id/schedule-change-requests', requirePolicy(canRequestSchedule, 'طلب تعديل المواعيد متاح لمسئول التسليمات ومدير الإنتاج فقط'), controller.createScheduleRequest);

router.put(
  '/:id',
  requirePolicy(delivery.canEditFull, 'غير مصرح لك بتعديل بيانات التسليم'),
  controller.updateDeliveryDetails,
);
router.get('/:id', requirePolicy(delivery.canView), controller.getDeliveryDetails);

module.exports = router;
