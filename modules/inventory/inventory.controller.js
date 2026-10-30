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
    const { warehouseId, branchId, search } = req.query;
    const levels = await inventoryQueries.getStockLevels(
      warehouseId ? parseInt(warehouseId, 10) : null,
      branchId ? parseInt(branchId, 10) : null,
      search || null,
    );
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
    const {
      productId,
      warehouseId,
      branchId,
      referenceType,
      search,
      startDate,
      endDate,
    } = req.query;
    const transactions = await inventoryQueries.getStockTransactions({
      productId: productId ? parseInt(productId, 10) : null,
      warehouseId: warehouseId ? parseInt(warehouseId, 10) : null,
      branchId: branchId ? parseInt(branchId, 10) : null,
      referenceType: referenceType || null,
      search: search || null,
      startDate: startDate || null,
      endDate: endDate || null,
    });
    return res.json(transactions);
  } catch (err) {
    console.error('خطأ في جلب الحركات:', err);
    return errorResponse(res, 'فشل تحميل الحركات', 500, err.message);
  }
}

// إضافة حركة مخزون — المنفّذ من التوكن حصرًا؛ أي createdBy في الجسم يُتجاهل
async function createTransaction(req, res) {
  try {
    const { productId, warehouseId, transactionType, quantity } = req.body;

    if (!productId || !warehouseId || !transactionType || !quantity) {
      return errorResponse(res, 'البيانات غير مكتملة', 400);
    }

    const transactionId = await inventoryQueries.createStockTransaction({
      ...req.body,
      createdBy: req.auth.username,
    });

    return res.json({
      success: true,
      transactionId: transactionId,
      message: 'تم إضافة الحركة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة الحركة:', err);
    return errorResponse(res, err.message || 'فشل إضافة الحركة', err.statusCode || 500, err.message);
  }
}

// إضافة مخزن — المنفّذ من التوكن حصرًا
async function createWarehouse(req, res) {
  try {
    const { warehouseName } = req.body;

    if (!warehouseName) {
      return errorResponse(res, 'اسم المخزن مطلوب', 400);
    }

    const warehouseId = await inventoryQueries.createWarehouse({
      ...req.body,
      createdBy: req.auth.username,
    });

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
      fromBranchId: req.body.fromBranchId ? parseInt(req.body.fromBranchId) : null,
      toBranchId: req.body.toBranchId ? parseInt(req.body.toBranchId) : null,
      notes: req.body.notes,
      // المنفّذ من التوكن حصرًا — يُتجاهل أي createdBy/userName في الجسم
      createdBy: req.auth.username,
    });
    return res.json(result);
  } catch (err) {
    console.error('transferStock:', err.message);
    return errorResponse(res, err.message || 'فشل التحويل', err.statusCode || 500, err.message);
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

// ══════════════════════════════════════════════════════════════
// الجرد المخزني — خلف سياسة requireCountStock في المسارات
// ══════════════════════════════════════════════════════════════

// مساحة عمل جرد لمخزن (أو مستند قائم عند تمرير stockCountId)
async function getStockCountWorkspace(req, res) {
  try {
    const warehouseId = req.query.warehouseId ? parseInt(req.query.warehouseId, 10) : null;
    const stockCountId = req.query.stockCountId ? parseInt(req.query.stockCountId, 10) : null;
    if (!stockCountId && !warehouseId) {
      return errorResponse(res, 'warehouseId مطلوب', 400);
    }
    const workspace = await inventoryQueries.getStockCountWorkspace(warehouseId, stockCountId);
    if (!workspace) return errorResponse(res, 'المخزن غير موجود أو غير نشط أو غير مرتبط بفرع', 404);
    return res.json({ success: true, data: workspace });
  } catch (err) {
    console.error('getStockCountWorkspace:', err);
    return errorResponse(res, 'فشل تحميل مساحة عمل الجرد', 500, err.message);
  }
}

// قائمة مستندات الجرد
async function getStockCounts(req, res) {
  try {
    const counts = await inventoryQueries.getStockCounts({
      branchId: req.query.branchId ? parseInt(req.query.branchId, 10) : null,
      warehouseId: req.query.warehouseId ? parseInt(req.query.warehouseId, 10) : null,
    });
    return res.json({ success: true, data: counts });
  } catch (err) {
    console.error('getStockCounts:', err);
    return errorResponse(res, 'فشل تحميل الجردات', 500, err.message);
  }
}

// حفظ مسودة جرد — المنفّذ من التوكن حصرًا
async function saveStockCountDraft(req, res) {
  try {
    const body = req.body || {};
    const stockCountId = await inventoryQueries.saveStockCountDraft({
      stockCountId: body.stockCountId || body.StockCountId || null,
      branchId: body.branchId ?? body.BranchId,
      warehouseId: body.warehouseId ?? body.WarehouseId,
      countDate: body.countDate ?? body.CountDate ?? null,
      notes: body.notes ?? body.Notes ?? null,
      lines: (body.lines || body.Lines || []).map((l) => ({
        productId: l.productId ?? l.ProductId,
        systemQty: l.systemQty ?? l.SystemQty ?? 0,
        actualQty: l.actualQty ?? l.ActualQty ?? 0,
        notes: l.notes ?? l.Notes ?? null,
      })),
    }, req.auth.username);
    return res.json({ success: true, stockCountId, message: 'تم حفظ مسودة الجرد بنجاح.' });
  } catch (err) {
    console.error('saveStockCountDraft:', err);
    return errorResponse(res, err.message || 'فشل حفظ مسودة الجرد', err.statusCode || 500, err.message);
  }
}

// اعتماد جرد وتنفيذ تسوياته ذرّيًا
async function finalizeStockCount(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    await inventoryQueries.finalizeStockCount(id, req.auth.username);
    return res.json({ success: true, message: 'تم اعتماد الجرد وتنفيذ التسويات المخزنية بنجاح.' });
  } catch (err) {
    console.error('finalizeStockCount:', err);
    return errorResponse(res, err.message || 'فشل اعتماد الجرد', err.statusCode || 500, err.message);
  }
}

// قيمة المخزون — خلف سياسة canViewStockValue في المسارات
async function getStockValue(req, res) {
  try {
    const result = await inventoryQueries.getStockValue({
      branchId: req.query.branchId ? parseInt(req.query.branchId, 10) : null,
      warehouseId: req.query.warehouseId ? parseInt(req.query.warehouseId, 10) : null,
      priceTier: req.query.priceTier || null,
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('getStockValue:', err);
    return errorResponse(res, 'فشل تحميل قيمة المخزون', 500, err.message);
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
  updateWarehouse,
  getStockCountWorkspace,
  getStockCounts,
  saveStockCountDraft,
  finalizeStockCount,
  getStockValue
};