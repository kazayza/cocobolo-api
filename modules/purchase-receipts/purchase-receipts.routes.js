const express = require('express');
const router = express.Router();
const controller = require('./purchase-receipts.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { purchaseReceipts } = require('../../shared/authorization.policy');

router.use(authenticate);
router.get('/', requirePolicy(purchaseReceipts.canView), controller.getAll);
router.post(
  '/:id/receive',
  requirePolicy(purchaseReceipts.canConfirm, 'غير مصرح لك بتأكيد استلام فاتورة الشراء'),
  controller.confirmReceipt,
);
router.get('/:id', requirePolicy(purchaseReceipts.canView), controller.getById);

module.exports = router;
