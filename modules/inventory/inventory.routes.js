const express = require('express');
const router = express.Router();
const inventoryController = require('./inventory.controller');

// ===================================
// 🏪 Inventory Routes
// ===================================

// جلب المخازن النشطة
// GET /api/inventory/warehouses/active
router.get('/warehouses/active', inventoryController.getActiveWarehouses);

// جلب كل المخازن
// GET /api/inventory/warehouses
router.get('/warehouses', inventoryController.getWarehouses);

// إضافة مخزن جديد
// POST /api/inventory/warehouses
router.post('/warehouses', inventoryController.createWarehouse);

// تعديل مخزن
// PUT /api/inventory/warehouses/:id
router.put('/warehouses/:id', inventoryController.updateWarehouse);

// جلب مستويات المخزون
// GET /api/inventory/stock?warehouseId=xxx
router.get('/stock', inventoryController.getStockLevels);

// جلب مخزون منتج
// GET /api/inventory/stock/product/:productId
router.get('/stock/product/:productId', inventoryController.getProductStock);

// جلب حركات المخزون
// GET /api/inventory/transactions?productId=xxx&warehouseId=xxx&startDate=xxx&endDate=xxx
router.get('/transactions', inventoryController.getTransactions);

// إضافة حركة مخزون
// POST /api/inventory/transactions
router.post('/transactions', inventoryController.createTransaction);

// تصدير الراوتر
module.exports = router;