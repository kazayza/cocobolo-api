const express = require('express');
const router = express.Router();
const followupsController = require('./followups.controller');

// GET /api/followups?scope=today|overdue|upcoming|all&source=all|lead|opportunity|task&employeeId=&search=
router.get('/', followupsController.getAll);
router.get('/summary', followupsController.getSummary);

// POST /api/followups/leads/:id/complete  (LeadInteractionId)
router.post('/leads/:id/complete', followupsController.completeLead);

module.exports = router;
