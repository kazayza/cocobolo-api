const express = require('express');
const router = express.Router();
const deliveryController = require('./delivery.controller');

router.get('/stats', deliveryController.getDeliveryStats);
router.get('/pending', deliveryController.getPendingDeliveries);
router.get('/upcoming', deliveryController.getUpcomingDeliveries);

router.put('/:id/deliver', deliveryController.markAsDelivered);

module.exports = router;