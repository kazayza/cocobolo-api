const express = require('express');
const router = express.Router();
const ctrl = require('./loans.controller');
const { authenticate } = require('../../core/auth.middleware');

router.get('/stats', authenticate, ctrl.getStats);
router.get('/installments', authenticate, ctrl.getInstallments);
router.get('/statement/:employeeId', authenticate, ctrl.getStatement);
router.get('/employees-lookup', authenticate, ctrl.employeesLookup);
router.get('/', authenticate, ctrl.getAll);
router.post('/', authenticate, ctrl.create);
router.post('/:id/cancel', authenticate, ctrl.cancel);
module.exports = router;
