const express = require('express');
const router = express.Router();
const interactionsController = require('./interactions.controller');

// ===================================
// 📞 Interactions Routes
// ===================================

// تسجيل تواصل جديد (الـ Flow الكامل)
// POST /api/interactions/create
router.post('/create', interactionsController.create);

// جلب سجل تفاعلات فرصة معينة
// GET /api/interactions/opportunity/:id
router.get('/opportunity/:id', interactionsController.getByOpportunityId);

// تصدير الراوتر
module.exports = router;