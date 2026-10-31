const express = require('express');
const router = express.Router();
const dashboardController = require('./dashboard.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { reports } = require('../../shared/authorization.policy');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
router.use(authenticate);

// ===================================
// 📊 Dashboard Routes
// ===================================

// جلب إحصائيات لوحة التحكم
// GET /api/dashboard?userId=xxx&username=xxx
router.get('/', dashboardController.getStats);

// جلب النشاطات الأخيرة
// GET /api/dashboard/activities
router.get('/activities', dashboardController.getRecentActivities);

// جلب بيانات التشخيص — يكشف بنية داخلية، فبوابته بوابة قمرة القيادة
// التنفيذية (frm_ExecutiveCockpit:View أو Admin) لا التوثيق وحده (بند 20).
// GET /api/dashboard/debug
router.get('/debug', requirePolicy(
  reports.canViewExecutiveCockpit,
  'بيانات التشخيص متاحة للإدارة أو حامل صلاحية قمرة القيادة التنفيذية',
), dashboardController.getDebug);

// تصدير الراوتر
module.exports = router;