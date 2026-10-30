const express = require('express');
const router = express.Router();
const inventoryController = require('./inventory.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const policy = require('../../shared/authorization.policy');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
router.use(authenticate);

// ══════════════════════════════════════════════════════════════
// سياسات محلية للوحدة (ملف السياسات المشترك لم يُعدَّل) — مرآة بلازور:
// • canMoveStock: StockService.cs:35-36 — مدير (Admin ضمنيًا عبر
//   AppAuthorization.HasClaimOrRole) أو مدير عام/مدير حسابات/محاسب/
//   مدير إنتاج/مصنع.
// • canCountStock (requireCountStock): StockService.cs:35-41 — مدير أو
//   صلاحية frm_StockCount:View أو مدير حسابات/محاسب.
// • canManageWarehouses: Warehouses.razor:382 — مدير أو مدير حسابات.
// • canViewStockValue: StockValue.razor:176 — مدير أو مدير حسابات.
// ══════════════════════════════════════════════════════════════
const { roles, hasClaim } = policy;
const canMoveStock = (a) => roles.admin(a)
  || roles.generalManager(a)
  || roles.accountManager(a)
  || roles.account(a)
  || roles.productionManager(a)
  || roles.factory(a);
const requireCountStock = (a) => roles.admin(a)
  || hasClaim(a, 'frm_StockCount:View')
  || roles.accountManager(a)
  || roles.account(a);
const canManageWarehouses = (a) => roles.admin(a) || roles.accountManager(a);
const canViewStockValue = (a) => roles.admin(a) || roles.accountManager(a);

// ===================================
// 🏪 Inventory Routes
// ===================================

// جلب المخازن النشطة
// GET /api/inventory/warehouses/active?branchId=xxx
router.get('/warehouses/active', inventoryController.getActiveWarehouses);

// جلب الفروع
// GET /api/inventory/branches
router.get('/branches', inventoryController.getBranches);

// جلب كل المخازن
// GET /api/inventory/warehouses
router.get('/warehouses', inventoryController.getWarehouses);

// إضافة مخزن جديد — إدارة المخازن للمدير ومدير الحسابات فقط
// POST /api/inventory/warehouses
router.post('/warehouses', requirePolicy(canManageWarehouses, 'غير مصرح لك بإدارة المخازن'), inventoryController.createWarehouse);

// تعديل مخزن
// PUT /api/inventory/warehouses/:id
router.put('/warehouses/:id', requirePolicy(canManageWarehouses, 'غير مصرح لك بإدارة المخازن'), inventoryController.updateWarehouse);

// جلب مستويات المخزون
// GET /api/inventory/stock?warehouseId=xxx
router.get('/stock', inventoryController.getStockLevels);

// جلب مخزون منتج
// GET /api/inventory/stock/product/:productId
router.get('/stock/product/:productId', inventoryController.getProductStock);

// جلب حركات المخزون
// GET /api/inventory/transactions?productId=xxx&warehouseId=xxx&startDate=xxx&endDate=xxx
router.get('/transactions', inventoryController.getTransactions);

// إضافة حركة مخزون — بوابة CanMoveStock
// POST /api/inventory/transactions
router.post('/transactions', requirePolicy(canMoveStock, 'غير مصرح لك بتنفيذ هذا الإجراء على المخزون.'), inventoryController.createTransaction);

// تحويل مخزني بين مخزنين - مطابق بلازور StockTransfer — بوابة CanMoveStock
// POST /api/inventory/transfer
router.post('/transfer', requirePolicy(canMoveStock, 'غير مصرح لك بتنفيذ هذا الإجراء على المخزون.'), inventoryController.transferStock);

// رصيد حالي لمنتج في مخزن
// GET /api/inventory/current-stock?productId=xxx&warehouseId=xxx
router.get('/current-stock', inventoryController.getCurrentStock);

// ══════════════════════════════════════════════════════════════
// الجرد المخزني — كل المسارات خلف requireCountStock
// ══════════════════════════════════════════════════════════════

// مساحة عمل الجرد (بنود المخزن الحالية أو مستند قائم)
// GET /api/inventory/stock-counts/workspace?warehouseId=xxx&stockCountId=xxx
router.get('/stock-counts/workspace', requirePolicy(requireCountStock, 'غير مصرح لك بتنفيذ هذا الإجراء على المخزون.'), inventoryController.getStockCountWorkspace);

// قائمة مستندات الجرد
// GET /api/inventory/stock-counts?branchId=xxx&warehouseId=xxx
router.get('/stock-counts', requirePolicy(requireCountStock, 'غير مصرح لك بتنفيذ هذا الإجراء على المخزون.'), inventoryController.getStockCounts);

// حفظ مسودة جرد (إنشاء أو استبدال بنود مستند قائم)
// POST /api/inventory/stock-counts
router.post('/stock-counts', requirePolicy(requireCountStock, 'غير مصرح لك بتنفيذ هذا الإجراء على المخزون.'), inventoryController.saveStockCountDraft);

// اعتماد جرد وتنفيذ فروقه ذرّيًا
// POST /api/inventory/stock-counts/:id/finalize
router.post('/stock-counts/:id/finalize', requirePolicy(requireCountStock, 'غير مصرح لك بتنفيذ هذا الإجراء على المخزون.'), inventoryController.finalizeStockCount);

// قيمة المخزون (تكلفة وبيع حسب باقة السعر) — للمدير ومدير الحسابات فقط
// GET /api/inventory/stock-value?branchId=xxx&warehouseId=xxx&priceTier=Premium
router.get('/stock-value', requirePolicy(canViewStockValue, 'غير مصرح لك بعرض قيمة المخزون'), inventoryController.getStockValue);

// تصدير الراوتر
module.exports = router;
