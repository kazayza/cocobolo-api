const express = require('express');
const router = express.Router();
const leadsController = require('./leads.controller');

// Static paths FIRST (before /:id)
router.get('/stats', leadsController.getStats);
router.get('/employees', leadsController.getEmployees);
router.get('/meta', leadsController.getMeta);
router.get('/filter-options', leadsController.getFilterOptions);
router.get('/reject-requests/pending', leadsController.pendingRejectRequests);
router.post('/reject-requests/:requestId/decide', leadsController.decideReject);

router.get('/', leadsController.getAll);
router.post('/', leadsController.create);

router.get('/:id/interactions', leadsController.getInteractions);
router.post('/:id/interactions', leadsController.addInteraction);
router.post('/:id/convert', leadsController.convertToClient);
router.post('/:id/reject-request', leadsController.requestReject);
router.get('/:id/reject-request', leadsController.leadPendingReject);

router.get('/:id', leadsController.getById);
router.put('/:id', leadsController.update);

module.exports = router;
