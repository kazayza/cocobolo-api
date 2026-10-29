const express = require('express');
const router = express.Router();
const notificationsController = require('./notifications.controller');
const { authenticate, serviceTokenOrAuthenticate, requirePolicy } = require('../../core/auth.middleware');
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
// Phase 0: كان بلا مصادقة (عالٍ-18) — الآن بجلسة؛ سياسات البث على مساراتها كما هي.
// Phase 1-C: أو بتوكن خدمة x-service-token لجسر بلازور الخادمي
// (NotificationService.cs) — انظر serviceTokenOrAuthenticate.
router.post('/', serviceTokenOrAuthenticate, notificationsController.create);

// إرسال إشعار ذكي
router.post('/smart', authenticate, requirePolicy(notificationPolicy.canBroadcast), notificationsController.createSmart);

// اختبار Push للمستخدم الحالي؛ يفيد في التحقق والتطبيق بالخلفية أو مغلق.
router.post('/test-self', authenticate, notificationsController.testSelfPush);

// إرسال Push يدوي - Admin فقط؛ باقي الموديولات تستدعي notifications.queries داخلياً
router.post('/send-push', authenticate, requirePolicy(notificationPolicy.canBroadcast), notificationsController.sendPush);

// 📢 بث إشعار لجميع المستخدمين (خاص بالأدمن — من غير حفظ في الجدول)
// POST /api/notifications/broadcast
// Body: { title, message, sender? }
router.post('/broadcast', authenticate, requirePolicy(notificationPolicy.canBroadcast), notificationsController.broadcast);

// تصدير الراوتر
module.exports = router;