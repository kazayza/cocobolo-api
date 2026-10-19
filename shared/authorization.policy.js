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
};
