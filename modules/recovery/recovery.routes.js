const express = require('express');
const router = express.Router();
const recoveryController = require('./recovery.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { recovery: recoveryPolicy } = require('../../shared/authorization.policy');

// Phase 0 (عالٍ-20): كانت الوحدة مفتوحة رغم جاهزية سياساتها —
// الآن جلسة للكل وسياسات الاسترداد على القراءة والإحياء وتسجيل التواصل.
router.use(authenticate);

const canView = requirePolicy(recoveryPolicy.canView, 'غير مصرح لك بعرض الاسترداد');
const canRevive = requirePolicy(recoveryPolicy.canRevive, 'غير مصرح لك بإحياء الفرص');
const canLogContact = requirePolicy(recoveryPolicy.canLogContact, 'غير مصرح لك بتسجيل تواصل');

router.use(canView);

// 📊 Stats
router.get('/stats', recoveryController.getStats);

// 📋 Queue with filters
router.get('/queue', recoveryController.getQueue);

// 📊 Report - مطابق LostRecoveryReport.razor
router.get('/report', recoveryController.getReport);
router.get('/trend', recoveryController.getTrend);
router.get('/staff-performance', recoveryController.getStaffPerformance);
router.get('/reasons-analysis', recoveryController.getReasons);
router.get('/reasons', recoveryController.getReasons);

// 🔢 Late count
router.get('/late-count', recoveryController.getLateCount);

// 🆕 Unprocessed count
router.get('/unprocessed-count', recoveryController.getUnprocessedCount);

// 🔄 Maintenance (sync + reminders) - POST for manual trigger
router.post('/maintenance', canRevive, recoveryController.runMaintenance);
router.get('/maintenance', recoveryController.runMaintenance);

// 📋 Stages for revive
router.get('/stages', recoveryController.getStages);

// 👥 CS employees
router.get('/cs-employees', recoveryController.getCsEmployees);

// 👤 Current employee id by username
router.get('/employee/:username', recoveryController.getCurrentEmployee);

// 📝 Log contact
router.post('/contact', canLogContact, recoveryController.logContact);

// 🕘 History
router.get('/history/:opportunityId', recoveryController.getHistory);

// 🔁 Revive
router.post('/revive', canRevive, recoveryController.revive);

module.exports = router;
