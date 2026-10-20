const express = require('express');
const router = express.Router();
const controller = require('./job-orders.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { jobOrders } = require('../../shared/authorization.policy');

router.get(
  '/',
  authenticate,
  requirePolicy(jobOrders.canView, 'غير مصرح لك بعرض أوامر التشغيل'),
  controller.getAll,
);
router.get(
  '/:id',
  authenticate,
  requirePolicy(jobOrders.canView, 'غير مصرح لك بعرض أمر التشغيل'),
  controller.getById,
);
router.put(
  '/:id/due-date',
  authenticate,
  requirePolicy(jobOrders.canEditDueDate, 'غير مصرح لك بتعديل تاريخ التسليم'),
  controller.updateDueDate,
);

module.exports = router;
