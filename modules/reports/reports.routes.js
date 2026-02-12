const express = require('express');
const router = express.Router();
const reportsController = require('./reports.controller');

// GET /api/reports/dashboard
// Parameters: ?dateFrom=2023-01-01&dateTo=2023-12-31&employeeId=5
router.get('/dashboard', reportsController.getDashboard);

module.exports = router;