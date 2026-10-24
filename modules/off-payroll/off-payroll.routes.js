const express = require('express');
const router = express.Router();
const ctrl = require('./off-payroll.controller');
const { authenticate } = require('../../core/auth.middleware');

router.get('/', authenticate, ctrl.getAll);
router.post('/', authenticate, ctrl.create);
router.post('/:id/approve', authenticate, ctrl.approve);
router.post('/:id/pay', authenticate, ctrl.pay);
module.exports = router;
