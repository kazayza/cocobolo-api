const express = require('express');
const router = express.Router();
const controller = require('./executive-cockpit.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { reports } = require('../../shared/authorization.policy');

router.use(authenticate);
router.get(
  '/',
  requirePolicy(
    reports.canViewExecutiveCockpit,
    'لوحة القيادة التنفيذية متاحة للإدارة أو لمن لديه الصلاحية المخصصة',
  ),
  controller.getCockpit,
);
router.get(
  '/employees/:id/timeline',
  requirePolicy(reports.canViewExecutiveCockpit),
  controller.getEmployeeTimeline,
);

module.exports = router;
