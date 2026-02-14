const express = require('express');
const router = express.Router();
const notificationsController = require('./notifications.controller');

// ===================================
// 🔔 Notifications Routes
// ===================================

// جلب الإشعارات غير المقروءة
// GET /api/notifications/unread?username=xxx
router.get('/unread', notificationsController.getUnread);

// جلب كل الإشعارات
// GET /api/notifications?username=xxx
router.get('/', notificationsController.getAll);

// تحديد كل الإشعارات كمقروءة
// PUT /api/notifications/read-all
router.put('/read-all', notificationsController.markAllAsRead);

// تحديد إشعار واحد كمقروء
// PUT /api/notifications/:id/read
router.put('/:id/read', notificationsController.markAsRead);

// إنشاء إشعار جديد
// POST /api/notifications
router.post('/', notificationsController.create);

// إرسال إشعار ذكي
router.post('/smart', notificationsController.createSmart);

// إرسال Push Notification
// POST /api/notifications/send-push
router.post('/send-push', notificationsController.sendPush);

// تصدير الراوتر
module.exports = router;