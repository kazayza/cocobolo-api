const express = require('express');
const router = express.Router({ mergeParams: true });
const followUpsController = require('./complaint-followups.controller');

// ===================================
// 📋 مسارات متابعات الشكاوى
// ===================================

// GET /api/complaints/:complaintId/followups
router.get('/', followUpsController.getByComplaintId);

// POST /api/complaints/:complaintId/followups
router.post('/', followUpsController.create);

// PUT /api/complaint-followups/:id
router.put('/:id', followUpsController.update);

// DELETE /api/complaint-followups/:id
router.delete('/:id', followUpsController.remove);

module.exports = router;