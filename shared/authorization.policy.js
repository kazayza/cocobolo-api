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
  canFullEdit: (a) => roles.admin(a) || roles.accountManager(a),
  canApproveEdit: (a) => roles.admin(a) || roles.accountManager(a),
  canViewProfit: (a) => roles.admin(a) || roles.accountManager(a),
  canViewHistory: (a) => roles.admin(a) || roles.accountManager(a),
  canRestore: (a) => roles.admin(a) || roles.accountManager(a),
  canSeeProtectedAccountManagerInvoices: (a) => roles.admin(a) || roles.accountManager(a) || roles.account(a),
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
  canEditDueDate: (a) => roles.admin(a)
    || roles.productionManager(a)
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
    || hasClaim(a, 'frmInvoiceDeliveryStatus:Deliver'),
  canOverrideRemaining: (a) => roles.admin(a) || roles.accountManager(a),
  canPrint: (a) => delivery.canView(a),
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
  canViewFinancialStatements: (a) => roles.admin(a)
    || roles.accountManager(a)
    || roles.account(a)
    || hasAnyClaim(
      a,
      'frm_BalanceSheet:View',
      'frm_IncomeStatement:View',
      'frm_CashFlowStatement:View',
    ),
  canViewSalesAnalytics: (a) => roles.admin(a)
    || roles.generalManager(a)
    || roles.accountManager(a)
    || roles.salesManager(a)
    || hasClaim(a, 'frm_SalesAnalytics:View'),
  canExportExecutiveCockpit: (a) => reports.canViewExecutiveCockpit(a),
};

module.exports = {
  norm,
  isRole,
  hasClaim,
  hasAnyClaim,
  roles,
  invoices,
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
};
