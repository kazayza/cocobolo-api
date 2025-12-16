const express = require('express');
const router = express.Router();
const interactionsController = require('./interactions.controller');

// ===================================
// 📞 Interactions Routes
// ===================================

// تسجيل تواصل جديد (الـ Flow الكامل)
// POST /api/interactions/create
router.post('/create', interactionsController.create);

// تصدير الراوتر
module.exports = router;