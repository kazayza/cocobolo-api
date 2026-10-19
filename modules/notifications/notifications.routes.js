const express = require('express');
const router = express.Router();
const notificationsController = require('./notifications.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { notifications: notificationPolicy } = require('../../shared/authorization.policy');

// ===================================
// 🔔 Notifications Routes
// ===================================

// جلب الإشعارات غير المقروءة
// GET /api/notifications/unread?username=xxx
router.get('/unread', authenticate, notificationsController.getUnread);

// جلب إشعارات المستخدم الحالي فقط
router.get('/', authenticate, notificationsController.getAll);

// تحديد كل إشعارات المستخدم الحالي كمقروءة
router.put('/read-all', authenticate, notificationsController.markAllAsRead);

// تحديد إشعار يخص المستخدم الحالي فقط كمقروء
router.put('/:id/read', authenticate, notificationsController.markAsRead);

// إنشاء إشعار جديد
// POST /api/notifications
router.post('/', notificationsController.create);

// إرسال إشعار ذكي
router.post('/smart', authenticate, requirePolicy(notificationPolicy.canBroadcast), notificationsController.createSmart);

// إرسال Push يدوي - Admin فقط؛ باقي الموديولات تستدعي notifications.queries داخلياً
router.post('/send-push', authenticate, requirePolicy(notificationPolicy.canBroadcast), notificationsController.sendPush);

// 📢 بث إشعار لجميع المستخدمين (خاص بالأدمن — من غير حفظ في الجدول)
// POST /api/notifications/broadcast
// Body: { title, message, sender? }
router.post('/broadcast', authenticate, requirePolicy(notificationPolicy.canBroadcast), notificationsController.broadcast);

// تصدير الراوتر
module.exports = router;