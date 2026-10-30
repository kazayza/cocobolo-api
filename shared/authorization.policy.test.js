// اختبارات سياسات التفويض — الجزء أ (رؤية المحاسب): كل سلسلة دور
// يعرفها بلازور لعائلة المحاسبة يجب أن تمر عبر بوابات الرواتب وخارج
// الراتب، ومطالبات السلف/الجزاءات تبقى مطالبات (لا توسيع بالأدوار).
// التشغيل: node --test shared/authorization.policy.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const policies = require('./authorization.policy');

const auth = (role, claims = []) => ({
  userId: 5,
  username: 'tester',
  role,
  employeeId: null,
  claims: new Set(claims),
  permissions: {},
});

// أدوار بلازور التي ترى الرواتب (PayrollList.razor) وخارج الراتب
// (OffPayrollPaymentsPage.razor) — بصيغتي مدير الحسابات والمحاسب.
const ACCOUNTANT_FAMILY = ['Accountant', 'Account', 'AccountManager', 'AccountsManager'];

test('payroll.canView: كل أدوار عائلة المحاسبة + HR والأدمن', () => {
  for (const role of [...ACCOUNTANT_FAMILY, 'HrManager', 'HRManager', 'Admin']) {
    assert.equal(policies.payroll.canView(auth(role)), true, `role=${role}`);
  }
});

test('payroll.canView: مسارا المطالبات frm_Payroll:View و frmPayrollProcessor:View', () => {
  assert.equal(policies.payroll.canView(auth('Sales', ['frm_Payroll:View'])), true);
  assert.equal(policies.payroll.canView(auth('Sales', ['frmPayrollProcessor:View'])), true);
  assert.equal(policies.payroll.canView(auth('Sales')), false);
});

test('payroll.canMutate: الاعتماد/الدفع لمدير الحسابات بصيغتيه — والمحاسب خارجها كما في بلازور', () => {
  assert.equal(policies.payroll.canMutate(auth('AccountManager')), true);
  assert.equal(policies.payroll.canMutate(auth('AccountsManager')), true);
  assert.equal(policies.payroll.canMutate(auth('Admin')), true);
  assert.equal(policies.payroll.canMutate(auth('Accountant')), false);
  assert.equal(policies.payroll.canMutate(auth('Account')), false);
});

test('offPayroll.canEnter: عائلة المحاسبة كلها + مطالبة frm_PayrollPayment:View', () => {
  for (const role of [...ACCOUNTANT_FAMILY, 'HrManager', 'Admin']) {
    assert.equal(policies.offPayroll.canEnter(auth(role)), true, `role=${role}`);
  }
  assert.equal(policies.offPayroll.canEnter(auth('Sales', ['frm_PayrollPayment:View'])), true);
  assert.equal(policies.offPayroll.canEnter(auth('Sales')), false);
});

test('loans: المطالبات تبقى هي البوابة للمحاسب — frmEmployeeLoans:Add/Edit/Delete', () => {
  const accountant = (claims) => auth('Accountant', claims);
  assert.equal(policies.loans.canCreate(accountant(['frmEmployeeLoans:Add'])), true);
  assert.equal(policies.loans.canEdit(accountant(['frmEmployeeLoans:Edit'])), true);
  assert.equal(policies.loans.canCancel(accountant(['frmEmployeeLoans:Delete'])), true);
  // بلا مطالبة: الدور وحده لا يكفي (صفحة بلازور محكومة بالمطالبة فقط)
  assert.equal(policies.loans.canCreate(accountant([])), false);
  assert.equal(policies.loans.canEdit(accountant([])), false);
  assert.equal(policies.loans.canCancel(accountant([])), false);
  // ومدير الحسابات بالصيغة الثانية داخل أدوار الإنشاء القائمة
  assert.equal(policies.loans.canCreate(auth('AccountsManager')), true);
});

test('employeePenalties: لا توسيع — المحاسب و AccountsManager خارج أدواره بلازور الحرفية', () => {
  // أدوار بلازور (SystemRoles): AccountManager فقط بلا صيغة ثانية،
  // والمحاسب ليس من أدوار الإنشاء/العرض الكلي — يصل بالمطالبة أو الربط.
  assert.equal(policies.employeePenalties.canCreateByRole(auth('AccountManager')), true);
  assert.equal(policies.employeePenalties.canCreateByRole(auth('AccountsManager')), false);
  assert.equal(policies.employeePenalties.canCreateByRole(auth('Accountant')), false);
  assert.equal(policies.employeePenalties.canViewAll(auth('Accountant')), false);
  assert.equal(policies.employeePenalties.canViewAll(auth('HrManager')), true);
  assert.equal(policies.employeePenalties.canCreateByRole(auth('SalesManager')), false);
  assert.equal(policies.employeePenalties.canCreateByRole(auth('ProductionManager')), true);
});
