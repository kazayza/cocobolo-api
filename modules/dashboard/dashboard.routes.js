const express = require('express');
const router = express.Router();
const dashboardController = require('./dashboard.controller');

// ===================================
// 📊 Dashboard Routes
// ===================================

// جلب إحصائيات لوحة التحكم
// GET /api/dashboard?userId=xxx&username=xxx
router.get('/', dashboardController.getStats);

// جلب النشاطات الأخيرة
// GET /api/dashboard/activities
router.get('/activities', dashboardController.getRecentActivities);

// جلب بيانات التشخيص
// GET /api/dashboard/debug
router.get('/debug', dashboardController.getDebug);

// تصدير الراوتر
module.exports = router;