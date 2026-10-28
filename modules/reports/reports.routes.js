const express = require('express');
const router = express.Router();
const controller = require('./reports.controller');
const { authenticate } = require('../../core/auth.middleware');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
router.use(authenticate);

router.get('/dashboard', controller.getDashboard);

module.exports = router;