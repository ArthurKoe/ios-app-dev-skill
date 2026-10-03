// Number and text formatting helpers. DOM-free (also used by export/printPlan.js).

const nf = (digits) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const NF0 = nf(0);
const NF1 = nf(1);
const NF2 = nf(2);

/**
 * Formats a number with a fixed maximum of fraction digits and thousands separators.
 * @param {number} value
 * @param {number} [digits=0]
 * @returns {string}
 */
export function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return '–';
  return (digits === 0 ? NF0 : digits === 1 ? NF1 : digits === 2 ? NF2 : nf(digits)).format(value);
}

/**
 * Mass: "840 g", "1.24 kg".
 * @param {number} grams
 * @returns {string}
 */
export function formatGrams(grams) {
  if (!Number.isFinite(grams)) return '–';
  if (grams >= 1000) return `${formatNumber(grams / 1000, grams >= 10000 ? 1 : 2)} kg`;
  return `${formatNumber(grams, grams < 10 ? 1 : 0)} g`;
}

/**
 * Filament length: "86 m", "1.2 km".
 * @param {number} metres
 * @returns {string}
 */
export function formatMetres(metres) {
  if (!Number.isFinite(metres)) return '–';
  if (metres >= 1000) return `${formatNumber(metres / 1000, 2)} km`;
  return `${formatNumber(metres, metres < 10 ? 1 : 0)} m`;
}

/**
 * Duration: "45 min", "3 h 20 min", "2 d 4 h".
 * @param {number} minutes
 * @returns {string}
 */
export function formatDuration(minutes) {
  if (!Number.isFinite(minutes)) return '–';
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

/**
 * Money with a currency symbol prefix: "€12.40".
 * @param {number} amount
 * @param {string} [symbol='€']
 * @returns {string}
 */
export function formatMoney(amount, symbol = '€') {
  if (!Number.isFinite(amount)) return '–';
  return `${symbol}${amount.toFixed(2)}`;
}

/**
 * Length in mm, switching to cm for large values: "4.2 mm", "98.4 cm".
 * @param {number} mm
 * @param {{digits?:number, cm?:boolean}} [opts]
 * @returns {string}
 */
export function formatMm(mm, { digits = 1, cm = false } = {}) {
  if (!Number.isFinite(mm)) return '–';
  if (cm && Math.abs(mm) >= 100) return `${formatNumber(mm / 10, 1)} cm`;
  return `${formatNumber(mm, digits)} mm`;
}

/**
 * Ground distance: "850 m", "12.5 km", "900 km".
 * @param {number} km
 * @returns {string}
 */
export function formatKm(km) {
  if (!Number.isFinite(km)) return '–';
  if (km < 1) return `${formatNumber(km * 1000, 0)} m`;
  return `${formatNumber(km, km < 10 ? 2 : km < 100 ? 1 : 0)} km`;
}

/**
 * Map scale: "1:850,000" (rounded to 3 significant digits).
 * @param {number} denominator
 * @returns {string}
 */
export function formatScale(denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return '–';
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(denominator)) - 2);
  return `1:${formatNumber(Math.round(denominator / mag) * mag, 0)}`;
}

/**
 * Elevation: "2,700 m".
 * @param {number|null} m
 * @returns {string}
 */
export function formatElevation(m) {
  if (m === null || !Number.isFinite(m)) return '–';
  return `${formatNumber(m, 0)} m`;
}

/**
 * Latitude/longitude pair: "45.950° N, 10.750° E".
 * @param {number} lat
 * @param {number} lon
 * @returns {string}
 */
export function formatLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}`;
}

/**
 * Bytes: "12.4 MB".
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${formatNumber(v, i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Escapes text for HTML element content and attribute values.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

/**
 * Picks black or white text for a background colour (WCAG relative luminance).
 * @param {string} hex '#rrggbb'
 * @returns {'#000000'|'#ffffff'}
 */
export function contrastText(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex));
  if (!m) return '#000000';
  const lin = (h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
  return L > 0.179 ? '#000000' : '#ffffff';
}
