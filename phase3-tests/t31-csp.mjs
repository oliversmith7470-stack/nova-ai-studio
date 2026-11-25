// T31-CSP — Content-Security-Policy + Cache-Control on served HTML
// (Rev 2 §13.2, Rev 3 §C-1.9).
//
// Design requirements:
//   (a) every HTML response carries Cache-Control: no-store (so a stale
//       nonce can never be replayed with its header);
//   (b) a CSP header whose nonce matches the nonce injected into the
//       HTML's <script>/<style> tags;
//   (c) the inventory of inline handlers / inline styles must be zero
//       before enforcement (the design inventoried 92 inline handlers
//       and 9 inline style attributes in the pre-Phase-3 file);
//   (d) Rev 2 §13.2 stages the policy: REPORT-ONLY first, enforcement
//       only after a full report-only pass with zero violations.
//
// The implementation (as read 25 Nov 2026) ships the policy as
// Content-Security-Policy-Report-Only — enforcement is a recorded
// separate step, NOT claimed. This test therefore asserts the staged
// state literally: no-store + report-only CSP with a nonce that
// matches the HTML, zero inline handlers/styles in the served body,
// and records the absence of the enforcing header as the staged state
// (a note, not a pass — enforcement remains an open step).

import {
  bootWithAssets, Recorder, runMain, seamPresent,
} from './harness.mjs';

const TITLE = 'CSP: no-store + nonce-matched CSP on served HTML, zero inline handlers/styles';

export async function run(rec) {
  const { mf } = await bootWithAssets();
  try {
    const res = await mf.dispatchFetch('http://localhost/');
    const html = await res.text();
    const cc = res.headers.get('cache-control') || '';
    const cspRO = res.headers.get('content-security-policy-report-only') || '';
    const cspEnforcing = res.headers.get('content-security-policy') || '';

    rec.check('C1', 'HTML response carries Cache-Control: no-store', cc.toLowerCase().includes('no-store'), 'no-store', cc);
    rec.check('C2', 'HTML response carries a Content-Security-Policy-Report-Only header', cspRO.length > 0, 'present', cspRO.slice(0, 80));

    // The nonce in the header must match the nonce(s) injected into the
    // served HTML's <script>/<style> tags.
    const headerNonce = (cspRO.match(/'nonce-([^']+)'/) || [])[1] || null;
    const htmlNonces = [...html.matchAll(/nonce="([^"]+)"/g)].map((m) => m[1]);
    const uniqueHtmlNonces = [...new Set(htmlNonces)];
    rec.check('C3', 'CSP nonce in the header matches the nonce(s) injected into the served HTML', headerNonce !== null && uniqueHtmlNonces.length === 1 && uniqueHtmlNonces[0] === headerNonce, 'one nonce, header == html', { headerNonce, htmlNonces: uniqueHtmlNonces });
    rec.check('C4', 'every <script> and <style> tag in the served HTML carries the nonce', htmlNonces.length > 0 && (html.match(/<script(?![^>]*\bnonce=)/gi) || []).length === 0 && (html.match(/<style(?![^>]*\bnonce=)/gi) || []).length === 0, 'all tagged', { scriptTags: (html.match(/<script/gi) || []).length, styleTags: (html.match(/<style/gi) || []).length, nonced: htmlNonces.length });

    // Inline-handler / inline-style inventory, measured on the SERVED
    // body at run time (the design's 92/9 counts are the pre-Phase-3
    // file; the implementation workstream has been removing them).
    const handlers = (html.match(/\son\w+\s*=/gi) || []).length;
    const styles = (html.match(/\sstyle\s*=/gi) || []).length;
    rec.check('C5', 'served HTML has zero inline event handlers (onclick=, onchange=, onsubmit=, oninput=, …)', handlers === 0, 0, handlers);
    rec.check('C6', 'served HTML has zero inline style= attributes', styles === 0, 0, styles);

    // Two successive responses must use DIFFERENT nonces (per-response
    // nonce — a replayed nonce must not validate against a fresh header).
    const res2 = await mf.dispatchFetch('http://localhost/');
    const html2 = await res2.text();
    const nonce2 = (res2.headers.get('content-security-policy-report-only') || '').match(/'nonce-([^']+)'/)?.[1] || null;
    rec.check('C7', 'a second HTML response carries a different nonce (per-response nonce)', nonce2 !== null && headerNonce !== null && nonce2 !== headerNonce, 'different nonce', { first: headerNonce, second: nonce2 });
    void html2;

    // Enforcement stage (Rev 2 §13.2): the enforcing header is NOT set
    // at this stage by recorded decision. Assert the staged state —
    // report-only present, enforcing absent — and leave enforcement as
    // an open step rather than claiming it.
    rec.check('C8', 'staged state: enforcing Content-Security-Policy header is NOT yet set (report-only stage, Rev 2 §13.2)', cspEnforcing === '', 'absent at this stage', cspEnforcing || '(absent)');
    rec.note('Enforcement (the enforcing Content-Security-Policy header) is a separate step after a full report-only pass with zero violations — NOT claimed by this implementation and NOT asserted as present here. When enforcement lands, C8 must be flipped to require it.');
    rec.note(`Design inventory (pre-Phase-3 file): 92 inline handlers, 9 inline style attributes. Served body at run time: ${handlers} handlers, ${styles} style attributes, ${(html.match(/<script/gi) || []).length} <script> tag(s), ${(html.match(/<style/gi) || []).length} <style> tag(s).`);
  } finally {
    await mf.dispose();
  }
  void seamPresent;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-CSP', TITLE, run);
}
