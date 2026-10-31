function norm(value) {
  return String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
}

function isRole(auth, ...roles) {
  const current = norm(auth?.role);
  return roles.some((role) => current === norm(role));
}

function hasClaim(auth, claim) {
  return auth?.claims instanceof Set && auth.claims.has(claim);
}

function hasAnyClaim(auth, ...claims) {
  return claims.some((claim) => hasClaim(auth, claim));
}

const roles = {
  admin: (a) => isRole(a, 'Admin'),
  generalManager: (a) => isRole(a, 'GeneralManager'),
  accountManager: (a) => isRole(a, 'AccountManager'),
  account: (a) => isRole(a, 'Account', 'Accountant'),
  salesManager: (a) => isRole(a, 'SalesManager'),
  sales: (a) => isRole(a, 'Sales'),
  customerService: (a) => isRole(a, 'CustomerService'),
  factory: (a) => isRole(a, 'factory'),
  productionManager: (a) => isRole(a, 'ProductionManager'),
  factoryManager: (a) => isRole(a, 'FactoryManager'),
  hrManager: (a) => isRole(a, 'HrManager', 'HRManager'),
  user: (a) => isRole(a, 'User'),
  deliveryOfficer: (a) => isRole(a, 'DeliveryOfficer'),
  b2b: (a) => isRole(a, 'B2B'),
};

const invoices = {
  canViewSales: (a) => roles.admin(a) || hasClaim(a, 'frm_PartiesInvoices:View'),
  canViewPurchases: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.account(a)
    || roles.factory(a)
    || roles.productionManager(a)
    || roles.factoryManager(a)
    || hasClaim(a, 'frm_SupplierInvoices:View'),
  canCreateSales: (a) => roles.admin(a) || hasClaim(a, 'frm_SalesInvoiveNew:Add'),
  canCreatePurchase: (a) => roles.admin(a)
    || roles.factory(a)
    || hasClaim(a, 'frm_SupplierInvoices:View'),
  canLimitedEdit: (a) => roles.admin(a)
    || roles.factory(a)
    || hasClaim(a, 'frm_SalesInvoiveNew:Edit')
    || hasClaim(a, 'frm_SupplierInvoices:View'),
  // الإلغاء في بلازور الحالي على صلاحية مخصصة مستقلة عن الحذف:
  // frm_PartiesInvoices:Cancel أو Admin (InvoiceService.cs:2029 +
  // SalesList.razor:992). صف الكتالوج المخصص FormName='frm_PartiesInvoices:Cancel'
  // يُنتج في بانِيَي الادعاءات (بلازور Program.cs:430 والواجهة auth.middleware)
  // الادعاء ':Cancel:View' تحديدًا — فنقبل الصيغتين ونُسقط ':Delete' التي
  // لم تعد بلازور تحترمها للإلغاء.
  canCancel: (a) => roles.admin(a)
    || hasAnyClaim(a, 'frm_PartiesInvoices:Cancel', 'frm_PartiesInvoices:Cancel:View'),
  canFullEdit: (a) => roles.admin(a) || roles.accountManager(a),
  canApproveEdit: (a) => roles.admin(a) || roles.accountManager(a),
  canViewProfit: (a) => roles.admin(a) || roles.accountManager(a),
  canViewHistory: (a) => roles.admin(a) || roles.accountManager(a),
  canRestore: (a) => roles.admin(a) || roles.accountManager(a),
  canSeeProtectedAccountManagerInvoices: (a) => roles.admin(a) || roles.accountManager(a) || roles.account(a),
};

const payments = {
  // مرآة PaymentService.CanMutatePayment في بلازور (PaymentService.cs:44-58):
  // مستخدم داخلي + (Admin أو ادعاء الإجراء frm_Payments:{Action})؛ الإضافة
  // والتعديل يقبلان أيضًا AccountManager/Account، وSales للبيع فقط (لا شراء)؛
  // الحذف بلا أي بديل أدوار — Admin أو frm_Payments:Delete حصرًا.
  canView: (a) => roles.admin(a) || hasClaim(a, 'frm_Payments:View'),
  canCreate: (a, isPurchase) => !roles.b2b(a) && (roles.admin(a)
    || hasClaim(a, 'frm_Payments:Add')
    || roles.accountManager(a)
    || roles.account(a)
    || (!isPurchase && roles.sales(a))),
  canEdit: (a, isPurchase) => !roles.b2b(a) && (roles.admin(a)
    || hasClaim(a, 'frm_Payments:Edit')
    || roles.accountManager(a)
    || roles.account(a)
    || (!isPurchase && roles.sales(a))),
  canDelete: (a) => roles.admin(a) || hasClaim(a, 'frm_Payments:Delete'),
};

const recovery = {
  canView: (a) => roles.admin(a)
    || roles.generalManager(a)
    || roles.salesManager(a)
    || roles.customerService(a)
    || hasClaim(a, 'frm_LostRecovery:View'),
  // Blazor 913cc57 allows CustomerService by role for both actions.
  canRevive: (a) => roles.admin(a)
    || roles.generalManager(a)
    || roles.salesManager(a)
    || roles.customerService(a)
    || hasClaim(a, 'frm_LostRecovery:Revive'),
  canLogContact: (a) => roles.admin(a)
    || roles.generalManager(a)
    || roles.salesManager(a)
    || roles.customerService(a)
    || hasClaim(a, 'frm_LostRecovery:LogContact'),
};

const complaints = {
  canView: (a) => Boolean(a?.userId),
  canCreate: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.salesManager(a)
    || roles.generalManager(a)
    || roles.sales(a)
    || hasClaim(a, 'frm_Complaints_Main:Add'),
  canEdit: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.salesManager(a)
    || roles.generalManager(a)
    || hasClaim(a, 'frm_Complaints_Main:Edit'),
  canEscalate: (a) => roles.admin(a) || roles.accountManager(a) || roles.generalManager(a),
};

const notifications = {
  canBroadcast: (a) => roles.admin(a),
};

const products = {
  canView: (a) => Boolean(a?.userId)
    && (roles.admin(a) || hasClaim(a, 'frm_ProductList:View') || hasClaim(a, 'frm_Products:View')),
  canCreate: (a) => roles.admin(a) || hasClaim(a, 'frm_Products:Add'),
  canEdit: (a) => roles.admin(a) || roles.factory(a) || hasClaim(a, 'frm_Products:Edit'),
  canDelete: (a) => roles.admin(a) || hasClaim(a, 'frm_Products:Delete'),
};

const priceList = {
  canView: (a) => roles.admin(a) || hasClaim(a, 'frm_PriceList:View'),
  canSeeSalePrices: (a) => !roles.factory(a),
  canSeeCosts: (a) => roles.admin(a) || roles.accountManager(a) || roles.account(a),
  canEditSalePrice: (a) => roles.admin(a) || roles.accountManager(a),
  canEditCost: (a) => roles.admin(a) || roles.accountManager(a) || roles.account(a),
  canRequestPriceChange: (a) => priceList.canView(a)
    && priceList.canSeeSalePrices(a)
    && !priceList.canSeeCosts(a),
  canViewHistory: (a) => roles.admin(a) || roles.accountManager(a),
  canReviewRequests: (a) => roles.admin(a) || roles.accountManager(a) || roles.salesManager(a),
  canExport: (a) => roles.admin(a) || roles.accountManager(a),
};

const generalTasks = {
  // إنشاء التكليفات العامة — بلازور GeneralTaskPermissions.CanCreate
  // (Services/GeneralTaskPermissions.cs:24): الأدوار الثلاثة
  // (GeneralManager/AccountManager/Admin) أو حامل Claim الإنشاء.
  // ملحوظة: Claim بلازور الحرفي هو frm_GeneralTasks:Create، بينما مجموعة
  // Claims الـ API تُبنى من UserPermissions بصيغ View/Add/Edit/Delete —
  // فمنح نفس صف الصلاحية يظهر هنا frm_GeneralTasks:Add؛ تُقبل الصيغتان.
  canCreate: (a) => roles.admin(a) || roles.generalManager(a) || roles.accountManager(a)
    || hasAnyClaim(a, 'frm_GeneralTasks:Create', 'frm_GeneralTasks:Add'),
  // إدارة الكل (رؤية كل التكليفات) — GeneralTaskPermissions.CanManageAll
  // (Services/GeneralTaskPermissions.cs:28): الأدوار الثلاثة فقط.
  canManageAll: (a) => roles.admin(a) || roles.generalManager(a) || roles.accountManager(a),
};

const quotations = {
  isCostOnlyViewer: (a) => roles.productionManager(a) || roles.factory(a),
  canView: (a) => roles.admin(a)
    || quotations.isCostOnlyViewer(a)
    || hasClaim(a, 'frmQuotationsList:View'),
  canAdd: (a) => !quotations.isCostOnlyViewer(a)
    && (roles.admin(a) || hasClaim(a, 'frmQuotationsList:Add')),
  canEdit: (a) => !quotations.isCostOnlyViewer(a)
    && (roles.admin(a) || hasClaim(a, 'frmQuotationsList:Edit')),
  canDelete: (a) => !quotations.isCostOnlyViewer(a)
    && (roles.admin(a) || hasClaim(a, 'frmQuotationsList:Delete')),
  canViewCost: (a) => roles.admin(a)
    || roles.accountManager(a)
    || quotations.isCostOnlyViewer(a),
  canEditCost: (a) => roles.factory(a) && !roles.admin(a),
  canViewSalePrices: (a) => !quotations.isCostOnlyViewer(a),
  canConvert: (a) => quotations.canEdit(a),
  canViewProtectedAccountManager: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.account(a),
  canApproveDiscount: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.salesManager(a),
  canExport: (a) => quotations.canView(a) && !quotations.isCostOnlyViewer(a),
};

const jobOrders = {
  canView: (a) => roles.admin(a)
    || roles.salesManager(a)
    || roles.sales(a)
    || roles.accountManager(a)
    || roles.hrManager(a)
    || roles.productionManager(a)
    || roles.factoryManager(a)
    || roles.factory(a)
    || hasClaim(a, 'frm_JobOrders:View'),
  canSeeAmounts: (a) => roles.admin(a) || roles.accountManager(a) || roles.account(a),
  // تعديل تاريخ التسليم/الاستلام — مدير الإنتاج أُزيل في بلازور بقرار المالك
  // (JobOrders.razor:534-536): مدير عام / مدير مصنع / Claim التعديل فقط.
  canEditDueDate: (a) => roles.admin(a)
    || roles.factoryManager(a)
    || hasClaim(a, 'frm_JobOrders:Edit'),
  canOpenInvoices: (a) => roles.admin(a)
    || roles.factory(a)
    || roles.productionManager(a)
    || roles.factoryManager(a)
    || hasClaim(a, 'frm_PartiesInvoices:View')
    || hasClaim(a, 'frm_SupplierInvoices:View'),
  canViewProtectedAccountManager: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.account(a),
};

// DeliveryPermissions.cs is the source of truth for this matrix.
const delivery = {
  canView: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.account(a)
    || roles.sales(a)
    || roles.user(a)
    || roles.deliveryOfficer(a)
    || hasClaim(a, 'frmInvoiceDeliveryStatus:View'),
  canSeeAmounts: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.account(a)
    || roles.sales(a),
  canEditFull: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.sales(a)
    || hasClaim(a, 'frmInvoiceDeliveryStatus:Edit'),
  canConfirm: (a) => roles.admin(a)
    || roles.sales(a)
    || roles.user(a)
    || roles.deliveryOfficer(a)
    || hasClaim(a, 'frmInvoiceDeliveryStatus:Deliver'),
  canOverrideRemaining: (a) => roles.admin(a) || roles.accountManager(a),
  canPrint: (a) => delivery.canView(a),
  // رؤية تاريخ الاستحقاق الحقيقي المتفق عليه (DeliveryPermissions.cs — CanSeeRealDeliveryDate):
  // من عداهم يرونه منقوصًا هامش الأيام عند العرض فقط (shared/delivery-dates.js).
  canSeeRealDate: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.sales(a)
    || roles.generalManager(a)
    || roles.deliveryOfficer(a),
};

// PurchaseReceiptStatus.razor role/claim matrix.
const purchaseReceipts = {
  canView: (a) => roles.admin(a)
    || roles.generalManager(a)
    || roles.accountManager(a)
    || roles.sales(a)
    || roles.user(a)
    || roles.factory(a)
    || roles.productionManager(a)
    || roles.factoryManager(a)
    || hasClaim(a, 'frm_PurchaseReceiptStatus:View')
    || hasClaim(a, 'frm_SupplierInvoices:View'),
  canSeeAmounts: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.factory(a)
    || roles.productionManager(a)
    || roles.factoryManager(a)
    || hasClaim(a, 'frm_SupplierInvoices:View'),
  canOpenInvoice: (a) => roles.admin(a)
    || roles.factory(a)
    || roles.productionManager(a)
    || roles.factoryManager(a)
    || hasClaim(a, 'frm_SupplierInvoices:View'),
  canConfirm: (a) => purchaseReceipts.canView(a)
    && (roles.admin(a)
      || roles.generalManager(a)
      || roles.factory(a)
      || roles.productionManager(a)
      || roles.factoryManager(a)
      || hasClaim(a, 'frm_PurchaseReceiptStatus:Edit')),
};

// FactoryPurchases.razor + InvoiceForm purchase-create policy.
const factoryPurchases = {
  canView: (a) => invoices.canViewPurchases(a),
  canCreate: (a) => roles.admin(a)
    || roles.factory(a)
    || hasClaim(a, 'frm_SupplierInvoices:View'),
  canSeeAmounts: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.account(a)
    || roles.factory(a)
    || roles.productionManager(a)
    || roles.factoryManager(a)
    || hasClaim(a, 'frm_SupplierInvoices:View'),
  canReceive: (a) => roles.admin(a)
    || roles.generalManager(a)
    || roles.factory(a)
    || roles.productionManager(a)
    || roles.factoryManager(a)
    || hasClaim(a, 'frm_PurchaseReceiptStatus:Edit')
    || hasClaim(a, 'frm_SupplierInvoices:View'),
  canCancel: (a) => roles.admin(a) || roles.accountManager(a),
  canOpenInvoice: (a) => invoices.canViewPurchases(a),
  canOpenJobOrder: (a) => jobOrders.canView(a),
};

const additionalCharges = {
  canView: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.account(a)
    || hasClaim(a, 'frmInspectionCharge:View'),
  canCreate: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.account(a)
    || hasClaim(a, 'frmInspectionCharge:Add')
    || hasClaim(a, 'frmInvoices:Add'),
  canEdit: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.account(a)
    || hasClaim(a, 'frmInspectionCharge:Edit'),
  canDelete: (a) => roles.admin(a)
    || roles.accountManager(a)
    || hasClaim(a, 'frmInspectionCharge:Delete')
    || hasClaim(a, 'frmInvoices:Delete'),
  canApply: (a) => additionalCharges.canEdit(a),
  canMarkNonRefundable: (a) => additionalCharges.canEdit(a),
  canSeeAmounts: (a) => additionalCharges.canView(a),
};

// CustomerCarePermissions.cs role/claim matrix.
const customerCare = {
  canView: (a) => roles.customerService(a)
    || roles.admin(a)
    || roles.accountManager(a)
    || roles.salesManager(a)
    || roles.generalManager(a)
    || roles.account(a)
    || hasClaim(a, 'frm_CustomerCare:View'),
  canLog: (a) => customerCare.canView(a),
  canViewAll: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.salesManager(a)
    || roles.generalManager(a)
    || roles.account(a),
  canExport: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.salesManager(a)
    || roles.generalManager(a)
    || hasClaim(a, 'frm_CustomerCare:Export'),
  canHide: (a) => customerCare.canViewAll(a),
};

// Shared reports policy foundation. Individual reports still use their exact
// Blazor form claim and never rely on Flutter visibility alone.
const reports = {
  canViewExecutiveCockpit: (a) => roles.admin(a)
    || hasClaim(a, 'frm_ExecutiveCockpit:View'),
  // بوابات القوائم المالية بحرفيات بلازور الحقيقية لكل قائمة على حدة
  // (IncomeStatement.razor:1118-1120 / CashFlowStatement.razor:901-903 /
  // BalanceSheet.razor:697-700) — الأسماء المخترعة السابقة
  // (frm_BalanceSheet/frm_IncomeStatement/frm_CashFlowStatement) لا توجد في
  // كتالوج بلازور ولا يمكن منحها أصلًا، فأُزيلت بوابتها الموحدة.
  canViewIncomeStatement: (a) => roles.admin(a)
    || hasAnyClaim(a, 'frmIncomeStatement:View', 'frmCashBoxDashboard:View'),
  canViewCashFlow: (a) => roles.admin(a)
    || hasAnyClaim(a, 'frm_CashFlowNew:View', 'frmCashBoxDashboard:View'),
  canViewBalanceSheet: (a) => roles.admin(a)
    || hasAnyClaim(a, 'frmIncomeStatement:View', 'rpt_IncomeStatement:View', 'frmCashBoxDashboard:View'),
  canViewSalesAnalytics: (a) => roles.admin(a)
    || roles.generalManager(a)
    || roles.accountManager(a)
    || roles.salesManager(a)
    || hasClaim(a, 'rpt_SalesAnalytics:View')
    || hasClaim(a, 'frm_SalesAnalytics:View'),
  canExportExecutiveCockpit: (a) => reports.canViewExecutiveCockpit(a),
};

// ============================================================
// Phase 0 — بوابات الوحدات المالية/الإدارية التي كانت مفتوحة،
// بمرآة حرّاس بلازور F-09 (AppAuthorization.HasClaim: دور Admin أو الـ Claim نفسه).
// أسماء الـ Claims مطابقة حرفيًا لما في بلازور؛ القراءات واسعة كشاشات بلازور والكتابات مقيدة.
// ============================================================
const cashbox = {
  canView: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.account(a)
    || hasAnyClaim(a, 'frmCashBox:View', 'frmCashBoxDashboard:View', 'frmCashBoxTransactions:View', 'frm_CashBoxTransaction:View', 'frm_TotalInOutNetCashBox:View', 'frmCashBoxSummary:View'),
  // إنشاء حركة خزينة أو تحويل بين الصناديق = عملية يدوية على الخزينة (CashBoxService F-09).
  canCreateTransaction: (a) => roles.admin(a) || hasClaim(a, 'frm_CashBoxManual:Add'),
  canAddBox: (a) => roles.admin(a) || hasClaim(a, 'frmCashBox:Add'),
  canEditBox: (a) => roles.admin(a) || hasClaim(a, 'frmCashBox:Edit'),
  canDeleteBox: (a) => roles.admin(a) || hasClaim(a, 'frmCashBox:Delete'),
};

const payroll = {
  // نفس مجموعة عرض PayrollList.razor في بلازور.
  canView: (a) => roles.admin(a)
    || roles.hrManager(a)
    || roles.accountManager(a)
    || roles.account(a)
    || isRole(a, 'AccountsManager')
    || hasAnyClaim(a, 'frmPayrollProcessor:View', 'frm_Payroll:View'),
  // استثناء الذات — قائمة مرتبات موظف (GET /employee/:employeeId):
  // المدير كما هو، وغير المدير لا يمر إلا إذا كان الموظف المطلوب هو
  // موظفه المرتبط بالتوكن (Users.employeeID) نفسه.
  canViewOrSelfEmployee: (a, req) => payroll.canView(a)
    || (Number(a?.employeeId) > 0
      && Number(req?.params?.employeeId) === Number(a.employeeId)),
  // استثناء الذات — قسيمة مفردة (GET /:id): البوابة تمرّر المدير أو أي
  // مستخدم مربوط بموظف، وفحص الملكية الفعلي (المرتب يخص موظف التوكن)
  // يتم داخل المتحكم بعد جلب المرتب — غير المربوط يبقى 403 هنا.
  canViewOrLinked: (a) => payroll.canView(a) || Number(a?.employeeId) > 0,
  // الاعتماد/الدفع في بلازور: Admin/AccountManager/AccountsManager — وأضيف HrManager كمشغّل للمرتبات.
  canMutate: (a) => roles.admin(a)
    || roles.hrManager(a)
    || roles.accountManager(a)
    || isRole(a, 'AccountsManager'),
};

const offPayroll = {
  // دخول/إنشاء/إلغاء دفعة خارج الراتب في بلازور = CanEnterPayroll
  // (PayrollService.cs:69): أدوار عرض الرواتب أو أيٌّ من مطالبات عرض
  // الوحدة الثلاث المستخدمة عبر صفحاتها.
  canEnter: (a) => roles.admin(a)
    || roles.hrManager(a)
    || roles.accountManager(a)
    || roles.account(a)
    || isRole(a, 'AccountsManager')
    || hasAnyClaim(a, 'frm_Payroll:View', 'frmPayrollProcessor:View', 'frm_PayrollPayment:View'),
  // الاعتماد/الرفض/الصرف: بوابة عمليات الرواتب نفسها، ويبقى حارس
  // المراجع الأضيق (Admin/AccountManager) مطبقًا داخل المحرك.
  canReviewOrPay: (a) => payroll.canMutate(a),
};

const expenses = {
  // ExpenseService/ExpensesList في بلازور: العرض بـ frm_ExpensesList:View،
  // والنموذج frm_Expenses:Add/Edit، وحذف القائمة frm_ExpensesList:Delete.
  canView: (a) => roles.admin(a) || hasClaim(a, 'frm_ExpensesList:View'),
  canAdd: (a) => roles.admin(a) || hasClaim(a, 'frm_Expenses:Add'),
  canEdit: (a) => roles.admin(a) || hasClaim(a, 'frm_Expenses:Edit'),
  canDelete: (a) => roles.admin(a) || hasClaim(a, 'frm_ExpensesList:Delete'),
  // إنشاء مجموعة في خدمة بلازور مشروط بـ frm_ExpensesGroup:Add فقط
  // (ExpenseService.cs:970) — لا بديل frm_Expenses:Add.
  canAddGroup: (a) => roles.admin(a)
    || hasClaim(a, 'frm_ExpensesGroup:Add'),
};

const personalAccounts = {
  // PersonalAccountsList/PersonalAccountForm في بلازور (لاحظ: بلا شرطة سفلية بعد frm).
  canView: (a) => roles.admin(a) || hasClaim(a, 'frmPersonalAccounts:View'),
  canAdd: (a) => roles.admin(a) || hasClaim(a, 'frmPersonalAccounts:Add'),
  canEdit: (a) => roles.admin(a) || hasClaim(a, 'frmPersonalAccounts:Edit'),
  canDelete: (a) => roles.admin(a) || hasClaim(a, 'frmPersonalAccounts:Delete'),
};

const settings = {
  // لا يوجد Claim مطابق في بلازور لبيانات الشركة/الإصدار — البوابة بالأدوار، والتعديل للأدمن فقط.
  canView: (a) => roles.admin(a) || roles.accountManager(a) || roles.account(a),
  canManage: (a) => roles.admin(a),
};

// ============================================================
// مرحلة صفر الموارد البشرية — بوابات كتابات كانت مفتوحة لأي جلسة.
// أسماء الـ Claims مطابقة لبلازور: frm_Employees (نموذج الموظف)،
// frm_EmpolyeeShifts (بخطئها الإملائي كما في بلازور)، frmEmployeeLoans.
// القراءات تبقى لأي جلسة مصادَقة (شاشات أخرى تعتمد عليها كقوائم اختيار).
// ============================================================
const employees = {
  canCreate: (a) => roles.admin(a) || roles.hrManager(a) || hasClaim(a, 'frm_Employees:Add'),
  canEdit: (a) => roles.admin(a) || roles.hrManager(a) || hasClaim(a, 'frm_Employees:Edit'),
};

const shifts = {
  canCreate: (a) => roles.admin(a) || roles.hrManager(a) || hasClaim(a, 'frm_EmpolyeeShifts:Add'),
  canEdit: (a) => roles.admin(a) || roles.hrManager(a) || hasClaim(a, 'frm_EmpolyeeShifts:Edit'),
  canDelete: (a) => roles.admin(a) || roles.hrManager(a) || hasClaim(a, 'frm_EmpolyeeShifts:Delete'),
  // عرض جدول ورديات مستخدم آخر: مديرو الحضور/الموارد فقط.
  canViewOthersSchedule: (a) => roles.admin(a)
    || roles.hrManager(a)
    || roles.accountManager(a)
    || roles.generalManager(a),
};

const employeePenalties = {
  // إنشاء الجزاءات بالأدوار الأربعة المعتمدة من المالك (قرارات التصميم):
  // Admin / GeneralManager / AccountManager / ProductionManager —
  // SalesManager خارج القائمة عمدًا. الإملاء الرسمي AccountManager فقط.
  canCreateByRole: (a) => roles.admin(a)
    || roles.generalManager(a)
    || roles.accountManager(a)
    || roles.productionManager(a),
  // رؤية الكل في القوائم: الأدوار الأربعة + مدير الموارد البشرية.
  canViewAll: (a) => roles.admin(a)
    || roles.generalManager(a)
    || roles.accountManager(a)
    || roles.productionManager(a)
    || roles.hrManager(a),
  // ── «التوقيع المباشر» (frm_EmployeePenalties:DirectSign) ──────────
  // حقيقة نظام المطالبات (موثقة في الدراسة §١.٣/§١.٤): المطالبات تُبنى
  // لكل طلب في core/auth.middleware.js من UserPermissions ⨝ Permissions
  // بأربعة أفعال ثابتة فقط (CanView/CanAdd/CanEdit/CanDelete) فتتولد
  // المطالبات بصيغة `${FormName}:View|Add|Edit|Delete` — لا يوجد عمود
  // ولا مسار يمكنه حمل لاحقة حرة مثل `:DirectSign`. أقرب آلية قائمة
  // بلا أي تغيير مخطط: صف Permissions مستقل يحمل الاسم في FormName
  // نفسه. لذلك يُقبل التوقيع المباشر بأي من الصور التالية:
  //   1) المطالبة الحرفية `frm_EmployeePenalties:DirectSign` إن وُجدت
  //      في مجموعة المطالبات (توافق مستقبلي/خارجي).
  //   2) مطالبة `frm_EmployeePenaltiesDirectSign:View` — وهي الصورة
  //      القابلة للتخزين فعليًا اليوم: ينشئ الأدمن صف صلاحية
  //      FormName='frm_EmployeePenaltiesDirectSign' ويمنح CanView=1
  //      لمن يشاء من شاشة الصلاحيات الحالية، فيبني auth.middleware
  //      المطالبة تلقائيًا.
  //   3) كائن الصلاحيات نفسه (auth.permissions) لنفس الصف بـ canView.
  DIRECT_SIGN_CLAIM: 'frm_EmployeePenalties:DirectSign',
  DIRECT_SIGN_FORM: 'frm_EmployeePenaltiesDirectSign',
  hasDirectSignClaim: (a) => hasClaim(a, 'frm_EmployeePenalties:DirectSign')
    || hasClaim(a, 'frm_EmployeePenaltiesDirectSign:View')
    || a?.permissions?.frm_EmployeePenaltiesDirectSign?.canView === true,
};

const attendance = {
  // سجلات البصمة الخام — عائلة مديري الحضور في الـ API (Admin/SalesManager/
  // AccountManager/Account/HrManager) ∪ Claim عرض بلازور frm_Attendance:View.
  canViewRawLogs: (a) => roles.admin(a)
    || roles.salesManager(a)
    || roles.accountManager(a)
    || roles.account(a)
    || roles.hrManager(a)
    || hasClaim(a, 'frm_Attendance:View'),
  // الكتابة اليدوية اليومية — مجموعة صفحة بلازور ManualDailyAttendancePage
  // حرفيًا: Admin ∨ HrManager ∨ HRManager ∨ AccountManager ∨ Account
  // ∨ claim frm_Attendance:Edit. SalesManager خارجها عمدًا كما في بلازور.
  canManualWrite: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.account(a)
    || roles.hrManager(a)
    || hasClaim(a, 'frm_Attendance:Edit'),
};

const loans = {
  // إنشاء السلفة في بلازور (LoansPage) بـ frmEmployeeLoans:Add، والإلغاء بـ :Delete.
  canCreate: (a) => roles.admin(a)
    || roles.hrManager(a)
    || roles.accountManager(a)
    || isRole(a, 'AccountsManager')
    || hasClaim(a, 'frmEmployeeLoans:Add'),
  // تعديل أقساط السلفة (تأجيل/تجزئة/تعديل قسط) بـ frmEmployeeLoans:Edit — نفس أدوار الإنشاء/الإلغاء.
  canEdit: (a) => roles.admin(a)
    || roles.hrManager(a)
    || roles.accountManager(a)
    || isRole(a, 'AccountsManager')
    || hasClaim(a, 'frmEmployeeLoans:Edit'),
  canCancel: (a) => roles.admin(a)
    || roles.hrManager(a)
    || roles.accountManager(a)
    || isRole(a, 'AccountsManager')
    || hasClaim(a, 'frmEmployeeLoans:Delete'),
};

module.exports = {
  norm,
  isRole,
  hasClaim,
  hasAnyClaim,
  roles,
  generalTasks,
  invoices,
  payments,
  recovery,
  complaints,
  notifications,
  products,
  priceList,
  quotations,
  jobOrders,
  delivery,
  purchaseReceipts,
  factoryPurchases,
  additionalCharges,
  customerCare,
  reports,
  cashbox,
  payroll,
  offPayroll,
  expenses,
  personalAccounts,
  settings,
  employees,
  shifts,
  loans,
  employeePenalties,
  attendance,
};
