const inventoryQueries = require('./inventory.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// جلب كل المخازن
async function getWarehouses(req, res) {
  try {
    const warehouses = await inventoryQueries.getAllWarehouses();
    return res.json(warehouses);
  } catch (err) {
    console.error('خطأ في جلب المخازن:', err);
    return errorResponse(res, 'فشل تحميل المخازن', 500, err.message);
  }
}

// جلب المخازن النشطة
async function getActiveWarehouses(req, res) {
  try {
    const { branchId } = req.query;
    const warehouses = await inventoryQueries.getActiveWarehouses(branchId ? parseInt(branchId) : null);
    return res.json(warehouses);
  } catch (err) {
    console.error('خطأ في جلب المخازن:', err);
    return errorResponse(res, 'فشل تحميل المخازن', 500, err.message);
  }
}

// جلب الفروع
async function getBranches(req, res) {
  try {
    const branches = await inventoryQueries.getBranches();
    return res.json(branches);
  } catch (err) {
    console.error('خطأ في جلب الفروع:', err);
    return errorResponse(res, 'فشل تحميل الفروع', 500, err.message);
  }
}

// جلب مستويات المخزون
async function getStockLevels(req, res) {
  try {
    const { warehouseId } = req.query;
    const levels = await inventoryQueries.getStockLevels(warehouseId);
    return res.json(levels);
  } catch (err) {
    console.error('خطأ في جلب المخزون:', err);
    return errorResponse(res, 'فشل تحميل المخزون', 500, err.message);
  }
}

// جلب مخزون منتج
async function getProductStock(req, res) {
  try {
    const { productId } = req.params;
    const stock = await inventoryQueries.getProductStock(productId);
    return res.json(stock);
  } catch (err) {
    console.error('خطأ في جلب المخزون:', err);
    return errorResponse(res, 'فشل تحميل المخزون', 500, err.message);
  }
}

// جلب حركات المخزون
async function getTransactions(req, res) {
  try {
    const { productId, warehouseId, startDate, endDate } = req.query;
    const transactions = await inventoryQueries.getStockTransactions(
      productId, warehouseId, startDate, endDate
    );
    return res.json(transactions);
  } catch (err) {
    console.error('خطأ في جلب الحركات:', err);
    return errorResponse(res, 'فشل تحميل الحركات', 500, err.message);
  }
}

// إضافة حركة مخزون
async function createTransaction(req, res) {
  try {
    const { productId, warehouseId, transactionType, quantity, createdBy } = req.body;

    if (!productId || !warehouseId || !transactionType || !quantity) {
      return errorResponse(res, 'البيانات غير مكتملة', 400);
    }

    const transactionId = await inventoryQueries.createStockTransaction(req.body);

    return res.json({
      success: true,
      transactionId: transactionId,
      message: 'تم إضافة الحركة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة الحركة:', err);
    return errorResponse(res, 'فشل إضافة الحركة', 500, err.message);
  }
}

// إضافة مخزن
async function createWarehouse(req, res) {
  try {
    const { warehouseName } = req.body;

    if (!warehouseName) {
      return errorResponse(res, 'اسم المخزن مطلوب', 400);
    }

    const warehouseId = await inventoryQueries.createWarehouse(req.body);

    return res.json({
      success: true,
      warehouseId: warehouseId,
      message: 'تم إضافة المخزن بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة المخزن:', err);
    return errorResponse(res, 'فشل إضافة المخزن', 500, err.message);
  }
}

// تعديل مخزن
async function updateWarehouse(req, res) {
  try {
    const { id } = req.params;

    await inventoryQueries.updateWarehouse(id, req.body);

    return res.json({
      success: true,
      message: 'تم تعديل المخزن بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تعديل المخزن:', err);
    return errorResponse(res, 'فشل تعديل المخزن', 500, err.message);
  }
}

// تحويل مخزني
async function transferStock(req, res) {
  try {
    const { fromWarehouseId, toWarehouseId, productId, quantity } = req.body;
    if (!fromWarehouseId || !toWarehouseId || !productId || !quantity) {
      return errorResponse(res, 'بيانات التحويل غير مكتملة', 400);
    }
    const result = await inventoryQueries.transferStock({
      fromWarehouseId: parseInt(fromWarehouseId),
      toWarehouseId: parseInt(toWarehouseId),
      productId: parseInt(productId),
      quantity: parseInt(quantity),
      notes: req.body.notes,
      createdBy: req.body.createdBy || req.body.userName || 'System',
    });
    return res.json(result);
  } catch (err) {
    console.error('transferStock:', err.message);
    return errorResponse(res, err.message || 'فشل التحويل', 500, err.message);
  }
}

// رصيد حالي
async function getCurrentStock(req, res) {
  try {
    const { productId, warehouseId } = req.query;
    if (!productId || !warehouseId) return errorResponse(res, 'productId و warehouseId مطلوبين', 400);
    const qty = await inventoryQueries.getCurrentStock(parseInt(productId), parseInt(warehouseId));
    return res.json({ quantity: qty });
  } catch (err) {
    return errorResponse(res, 'فشل جلب الرصيد', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getWarehouses,
  getActiveWarehouses,
  getBranches,
  getStockLevels,
  getProductStock,
  getCurrentStock,
  getTransactions,
  createTransaction,
  transferStock,
  createWarehouse,
  updateWarehouse
};