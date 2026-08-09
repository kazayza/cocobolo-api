const express = require('express');
const router = express.Router();
const deliveryController = require('./delivery.controller');

// ═══════════════════════════════════════════════════════════
// Delivery Routes
// ═══════════════════════════════════════════════════════════

// القائمة مع الفلاتر
router.get('/list', deliveryController.getDeliveries);

// الإحصائيات
router.get('/stats', deliveryController.getDeliveryStats);

// الفواتير القريبة (للإشعارات)
router.get('/upcoming', deliveryController.getUpcomingDeliveries);

// تفاصيل فاتورة
router.get('/:id', deliveryController.getDeliveryDetails);

// تأكيد التسليم
router.put('/:id/deliver', deliveryController.markAsDelivered);

module.exports = router;
