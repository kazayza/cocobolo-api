const express = require('express');
const router = express.Router();
const controller = require('./reports.controller');

router.get('/dashboard', controller.getDashboard);

module.exports = router;