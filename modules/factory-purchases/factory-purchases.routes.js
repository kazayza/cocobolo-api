const express = require('express');
const router = express.Router();
const controller = require('./factory-purchases.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { factoryPurchases } = require('../../shared/authorization.policy');

router.use(authenticate);
router.get(
  '/',
  requirePolicy(factoryPurchases.canView, 'غير مصرح لك بعرض فواتير شراء المصنع'),
  controller.getAll,
);
router.get(
  '/lookups',
  requirePolicy(factoryPurchases.canCreate, 'غير مصرح لك بإنشاء فاتورة شراء مصنع'),
  controller.getLookups,
);
router.get(
  '/customers',
  requirePolicy(factoryPurchases.canCreate),
  controller.searchCustomers,
);
router.get(
  '/products',
  requirePolicy(factoryPurchases.canCreate),
  controller.searchProducts,
);
router.get(
  '/products/:productId/alternatives',
  requirePolicy(factoryPurchases.canCreate),
  controller.getAlternatives,
);
router.post(
  '/',
  requirePolicy(factoryPurchases.canCreate, 'غير مصرح لك بإنشاء فاتورة شراء مصنع'),
  controller.create,
);
router.post(
  '/:id/receive',
  requirePolicy(factoryPurchases.canReceive, 'غير مصرح لك باستلام توريد المصنع'),
  controller.receive,
);
router.post(
  '/:id/cancel',
  requirePolicy(factoryPurchases.canCancel, 'إلغاء فاتورة شراء المصنع متاح للإدارة والحسابات فقط'),
  controller.cancel,
);

module.exports = router;
