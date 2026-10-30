const express = require('express');
const router = express.Router();
const controller = require('./executive-cockpit.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { reports } = require('../../shared/authorization.policy');

router.use(authenticate);
const cockpitGate = requirePolicy(
  reports.canViewExecutiveCockpit,
  'لوحة القيادة التنفيذية متاحة للإدارة أو لمن لديه الصلاحية المخصصة',
);
router.get('/', cockpitGate, controller.getCockpit);
router.get('/snapshots', cockpitGate, controller.listSnapshots);
router.get('/snapshots/:id', cockpitGate, controller.getSnapshot);
router.post('/snapshots', cockpitGate, controller.saveSnapshot);
router.get(
  '/employees/:id/timeline',
  requirePolicy(reports.canViewExecutiveCockpit),
  controller.getEmployeeTimeline,
);

module.exports = router;
