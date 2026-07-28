const express = require('express');
const router = express.Router();
const leadsController = require('./leads.controller');

router.get('/', leadsController.getAll);
router.get('/:id', leadsController.getById);
router.put('/:id', leadsController.update);
router.post('/:id/convert', leadsController.convertToClient);
router.get('/:id/interactions', leadsController.getInteractions);
router.post('/:id/interactions', leadsController.addInteraction);

module.exports = router;