// ── ClaimFlow internal email design system ────────────────────────
// Ops / fraud-team emails are working tools, so they follow one layout: a banner with the one
// thing that matters, scannable facts, colour WITH labels, one clear action. Table layout and
// inline styles only (Outlook ignores flexbox and <style>). Every value is HTML-escaped.
// Copied into Code nodes (same pattern as pii-crypto.js).
const UI = {
  brand: '#0b4f6c', text: '#1f2933', muted: '#52606d', faint: '#7b8794', line: '#e4e7eb', panel: '#f5f7fa',
  tone: {
    high:   { bg: '#fdecea', fg: '#7a271a', solid: '#b42318', line: '#f5c2bd' },
    medium: { bg: '#fef3e2', fg: '#7a4a0b', solid: '#b54708', line: '#f7d9a8' },
    low:    { bg: '#e7f5ee', fg: '#05603a', solid: '#067647', line: '#b7e2cc' },
    info:   { bg: '#e8f1f8', fg: '#0b4f6c', solid: '#0b4f6c', line: '#c3dbea' },
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const money = (n) => (n === null || n === undefined || n === '' ? 'n/a' : 'R ' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
const toneForScore = (score) => (score >= 60 ? 'high' : score >= 25 ? 'medium' : 'low');
const labelForTone = { high: 'HIGH RISK', medium: 'MEDIUM RISK', low: 'LOW RISK', info: '' };

function heading(text) {
  return `<p style="margin:18px 0 6px;font-size:11px;font-weight:bold;letter-spacing:.06em;color:${UI.muted};">${esc(String(text).toUpperCase())}</p>`;
}
function para(text, style = '') {
  return `<p style="margin:0 0 10px;font-size:13px;line-height:1.55;color:${UI.text};${style}">${esc(text)}</p>`;
}
// rows: [[label, valueHtmlOrText, {html:true, emphasis:'high'}]]
function factsTable(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px 0 6px;">${rows.map(([k, v, o = {}]) => {
    const val = o.html ? v : esc(v);
    const color = o.emphasis ? UI.tone[o.emphasis].solid : UI.text;
    return `<tr><td style="padding:6px 10px 6px 0;font-size:13px;color:${UI.muted};width:38%;vertical-align:top;border-bottom:1px solid ${UI.line};">${esc(k)}</td><td style="padding:6px 0;font-size:13px;color:${color};font-weight:${o.emphasis ? 'bold' : 'normal'};border-bottom:1px solid ${UI.line};">${val}</td></tr>`;
  }).join('')}</table>`;
}
function bar(pct, tone = 'info') {
  const w = Math.max(0, Math.min(100, Math.round(pct)));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:4px;"><tr><td style="background:${UI.line};height:6px;border-radius:3px;font-size:0;line-height:0;"><table role="presentation" width="${w}%" cellpadding="0" cellspacing="0"><tr><td style="background:${UI.tone[tone].solid};height:6px;border-radius:3px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table>`;
}
// chips: [{text, tone}]
function chips(items) {
  if (!items.length) return para('None', `color:${UI.muted};`);
  return `<p style="margin:0 0 6px;line-height:2.1;">${items.map((c) => {
    const t = UI.tone[c.tone || 'info'];
    return `<span style="display:inline-block;background:${t.bg};color:${t.fg};border:1px solid ${t.line};border-radius:12px;padding:2px 10px;font-size:12px;margin:0 4px 0 0;white-space:nowrap;">${esc(c.text)}</span>`;
  }).join('')}</p>`;
}
function list(items) {
  return `<ul style="margin:0 0 6px 18px;padding:0;">${items.map((i) => `<li style="font-size:13px;line-height:1.6;color:${UI.text};">${esc(i)}</li>`).join('')}</ul>`;
}
function quote(text, label) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 6px;"><tr><td style="border-left:3px solid #9aa5b1;background:${UI.panel};padding:10px 12px;font-size:13px;line-height:1.55;font-style:italic;color:${UI.text};">${esc(text)}</td></tr></table>${label ? `<p style="margin:0 0 6px;font-size:11px;color:${UI.faint};">${esc(label)}</p>` : ''}`;
}
function button(href, label, note) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;"><tr><td align="center"><a href="${esc(href)}" style="display:inline-block;background:${UI.brand};color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:6px;font-size:14px;font-weight:bold;">${esc(label)}</a></td></tr></table>${note ? `<p style="margin:6px 0 0;text-align:center;font-size:12px;color:${UI.muted};">${esc(note)}</p>` : ''}`;
}
// tiles: [{label, value, tone}]
function kpiTiles(tiles) {
  const w = Math.floor(100 / tiles.length);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:0 -6px 4px;"><tr>${tiles.map((t) => {
    const tone = UI.tone[t.tone || 'info'];
    return `<td width="${w}%" style="background:${tone.bg};border:1px solid ${tone.line};border-radius:8px;padding:10px 12px;vertical-align:top;"><div style="font-size:22px;font-weight:bold;color:${tone.fg};line-height:1.1;">${esc(t.value)}</div><div style="font-size:11px;color:${tone.fg};margin-top:4px;">${esc(t.label)}</div></td>`;
  }).join('')}</tr></table>`;
}
// rows: [[cells...]], headers: [..]
function dataTable(headers, rows, emptyText = 'None') {
  if (!rows.length) return para(emptyText, `color:${UI.muted};`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:2px 0 6px;"><tr>${headers.map((h) => `<td style="padding:6px 8px;font-size:11px;font-weight:bold;color:${UI.muted};background:${UI.panel};border-bottom:1px solid ${UI.line};">${esc(h)}</td>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td style="padding:6px 8px;font-size:13px;color:${UI.text};border-bottom:1px solid ${UI.line};">${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
}
// banner: {tone, badge:{value,label}?, title, subtitle}
function banner(b) {
  const t = UI.tone[b.tone || 'info'];
  const badge = b.badge ? `<td width="76" style="padding-right:14px;vertical-align:middle;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" style="background:${t.solid};color:#ffffff;border-radius:8px;padding:8px 10px;min-width:56px;"><div style="font-size:22px;font-weight:bold;line-height:1;">${esc(b.badge.value)}</div><div style="font-size:10px;margin-top:3px;">${esc(b.badge.label)}</div></td></tr></table></td>` : '';
  return `<tr><td style="background:${t.bg};border-bottom:1px solid ${t.line};padding:14px 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${badge}<td style="vertical-align:middle;"><div style="font-size:16px;font-weight:bold;color:${t.fg};">${esc(b.title)}</div>${b.subtitle ? `<div style="font-size:13px;color:${t.fg};margin-top:3px;">${esc(b.subtitle)}</div>` : ''}</td></tr></table></td></tr>`;
}
// Full email. bodyHtml is already-built (escaped) component HTML.
function layout({ product = 'Acme Cover', section, bannerSpec, bodyHtml, footer }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#eef1f5;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:20px 0;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #d9dee5;border-radius:10px;overflow:hidden;">
<tr><td style="background:${UI.brand};padding:14px 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="color:#ffffff;font-size:16px;font-weight:bold;">${esc(product)} &middot; ${esc(section)}</td><td align="right" style="color:#cfe0ea;font-size:12px;">Internal: claims staff only</td></tr></table></td></tr>
${bannerSpec ? banner(bannerSpec) : ''}
<tr><td style="padding:8px 22px 20px;">${bodyHtml}</td></tr>
<tr><td style="background:#f8fafc;border-top:1px solid ${UI.line};padding:10px 22px;font-size:11px;color:${UI.faint};">${esc(footer || 'Generated by ClaimFlow. Contains no claimant contact details by design.')}</td></tr>
</table></td></tr></table></body></html>`;
}
// ── end of shared code ── (the line below is stripped when copied into n8n)
module.exports = { UI, esc, money, toneForScore, labelForTone, heading, para, factsTable, bar, chips, list, quote, button, kpiTiles, dataTable, banner, layout };
