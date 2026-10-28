const express = require('express');
const router = express.Router({ mergeParams: true });
const followUpsController = require('./complaint-followups.controller');
const { authenticate } = require('../../core/auth.middleware');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
router.use(authenticate);

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