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
    const warehouses = await inventoryQueries.getActiveWarehouses();
    return res.json(warehouses);
  } catch (err) {
    console.error('خطأ في جلب المخازن:', err);
    return errorResponse(res, 'فشل تحميل المخازن', 500, err.message);
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

// تصدير الدوال
module.exports = {
  getWarehouses,
  getActiveWarehouses,
  getStockLevels,
  getProductStock,
  getTransactions,
  createTransaction,
  createWarehouse,
  updateWarehouse
};