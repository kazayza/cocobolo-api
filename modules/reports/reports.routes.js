// reports.routes.js
const express = require('express');
const router = express.Router();
const reportsController = require('./reports.controller');

// GET /api/reports/dashboard?dateFrom=&dateTo=&employeeId=
router.get('/dashboard', reportsController.getDashboard);

// GET /api/reports/employees (للـ Filter Dropdown)
router.get('/employees', reportsController.getEmployees);

module.exports = router;