const crypto = require('crypto');

// ============================================================
// روابط المشاركة العامة الموقّعة — نسخة مطابقة لآلية بلازور
// (COCOBOLOERPNEW.Helpers.ShareTokenService) حتى تعمل الروابط
// الصادرة من بلازور على الـ API والعكس:
//
//   token   = Base64Url(payloadJson) + "." + Base64Url(HMAC)
//   payload = {"Type":"quotation","Id":123,"ExpiresAt":<unix-sec>}
//   HMAC    = HMAC-SHA256(key = UTF8(secret), data = UTF8(payloadB64))
//   secret  = Blazor "Security:ShareSecret" — يُضبط هنا في متغير
//             البيئة SHARE_SECRET بنفس القيمة تمامًا (32 حرفًا فأكثر).
//
// عند غياب السر أو قصره تُعطَّل الروابط العامة (404) بدل قبول أي شيء.
// ============================================================

const MIN_SHARE_SECRET_LENGTH = 32;
let warnedAboutShareSecret = false;

function getShareSecret() {
  const secret = process.env.SHARE_SECRET || process.env.SECURITY_SHARE_SECRET;
  if (!secret || secret.length < MIN_SHARE_SECRET_LENGTH) return null;
  return secret;
}

function isShareTokenEnabled() {
  return getShareSecret() !== null;
}

function base64UrlDecodeToBuffer(value) {
  let s = String(value).replace(/-/g, '+').replace(/_/g, '/');
  switch (s.length % 4) {
    case 2: s += '=='; break;
    case 3: s += '='; break;
    case 0: break;
    default: throw new Error('Invalid base64url length');
  }
  return Buffer.from(s, 'base64');
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// توليد توكن مشاركة — مطابق حرفيًا لـ Blazor Helpers/ShareTokenService.cs
// (GenerateToken): payload JSON بترتيب المفاتيح Type/Id/ExpiresAt كما يسرّبه
// System.Text.Json من خصائص TokenPayload بالترتيب نفسه، وExpiresAt بالثواني،
// والتوقيع HMAC-SHA256 فوق Base64Url(payload) بمفتاح UTF8(SHARE_SECRET).
// validityDays يُقيَّد 1..90 والافتراضي 30 — Endpoints/QuotationEndpoints.cs:63.
function generateShareToken(type, id, validityDays) {
  const secret = getShareSecret();
  if (!secret) return null;
  const days = Math.min(Math.max(Number(validityDays) || 30, 1), 90);
  const expiresAt = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
  const payloadJson = JSON.stringify({ Type: String(type), Id: Number(id), ExpiresAt: expiresAt });
  const payloadB64 = base64UrlEncode(Buffer.from(payloadJson, 'utf8'));
  const sigB64 = base64UrlEncode(computeHmac(secret, payloadB64));
  return { token: `${payloadB64}.${sigB64}`, expiresAt, expiresInDays: days };
}

function computeHmac(secret, payloadB64) {
  return crypto
    .createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(payloadB64, 'utf8'))
    .digest();
}

// يعيد { type, id, expiresAt } عند الصلاح، وnull في كل حالات الرفض —
// بنفس ترتيب فحوص بلازور: التوقيع أولًا (بمقارنة ثابتة الزمن)، ثم الانتهاء.
function validateShareToken(token) {
  const secret = getShareSecret();
  if (!secret) {
    if (!warnedAboutShareSecret) {
      warnedAboutShareSecret = true;
      console.warn('⚠️ SHARE_SECRET غير مضبوط أو أقصر من 32 حرفًا — روابط عروض الأسعار العامة معطّلة (404).');
    }
    return null;
  }

  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  try {
    const expectedSig = computeHmac(secret, parts[0]);
    const providedSig = base64UrlDecodeToBuffer(parts[1]);
    if (providedSig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(expectedSig, providedSig)) return null;

    const payloadJson = base64UrlDecodeToBuffer(parts[0]).toString('utf8');
    const payload = JSON.parse(payloadJson);
    if (!payload || typeof payload !== 'object') return null;

    const expiresAt = Number(payload.ExpiresAt);
    if (!Number.isFinite(expiresAt)) return null;
    if (Math.floor(Date.now() / 1000) > expiresAt) return null;

    const id = Number(payload.Id);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (typeof payload.Type !== 'string' || !payload.Type) return null;

    return { type: payload.Type, id, expiresAt };
  } catch (_) {
    return null;
  }
}

module.exports = {
  validateShareToken,
  generateShareToken,
  isShareTokenEnabled,
};
