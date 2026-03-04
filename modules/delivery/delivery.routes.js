const express = require('express');
const router = express.Router();
const deliveryController = require('./delivery.controller');

router.get('/pending', deliveryController.getPendingDeliveries);
router.put('/:id/deliver', deliveryController.markAsDelivered);
router.get('/stats', deliveryController.getDeliveryStats);

module.exports = router;