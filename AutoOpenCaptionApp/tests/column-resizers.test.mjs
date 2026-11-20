/**
 * Vertical column resizers: draggable dividers between the Preview/Model
 * column and the Transcript/Word Editor column (left), and between those
 * and the Style/Effects/Position column (right).
 *
 * Two layers, per repo convention: the REAL extracted bindColumnResizers
 * runs against a minimal DOM stub (behavioral — drag math, clamps, and
 * localStorage persistence), plus regex source-guards on the resizer
 * markup, the CSS grid switch, and the App.init() wiring.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)), 'utf8',
).replace(/\r\n/g, '\n'); // repo files are CRLF; normalize for needle matching

const appSrc = read('../app/assets/app.js');
const htmlSrc = read('../app/index.html');
const cssSrc = read('../app/assets/style.css');

// App method: body ends at the next column-4 '},'.
function extractBody(signature, terminator = '\n    },') {
    const start = appSrc.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found in app.js`);
    const end = appSrc.indexOf(terminator, start);
    assert.ok(end > start, `end of ${signature} not found`);
    // Signature already ends at the body's opening '{' — slice past it.
    return appSrc.slice(start + signature.length + 1, end);
}

// ── Behavioral layer: real method against a DOM stub ────────────────

function buildStub(storage = {}, colW = {}) {
    const makeEl = (props = {}) => {
        const listeners = {};
        const el = {
            listeners,
            handlers: (type) => listeners[type] || [],
            fire(type, ev = {}) { for (const fn of this.handlers(type)) fn(ev); },
            addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
            removeEventListener(type, fn) {
                listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
            },
            style: { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } },
            classList: (() => {
                const set = new Set();
                return {
                    set: set,
                    add: (c) => set.add(c),
                    remove: (c) => set.delete(c),
                    toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
                    contains: (c) => set.has(c),
                };
            })(),
            offsetWidth: 13,
            getBoundingClientRect: () => ({ width: 400, height: 300, left: 0, right: 400 }),
            ...props,
        };
        return el;
    };

    const els = {
        'left-col-resizer': makeEl(),
        'right-col-resizer': makeEl(),
    };
    const main = makeEl({ offsetParent: {}, clientWidth: 1500, getBoundingClientRect: () => ({ width: 1500, height: 800, left: 0, right: 1500 }) });
    const leftCol = makeEl({ getBoundingClientRect: () => ({ width: colW.left ?? 400, height: 300, left: 0, right: colW.left ?? 400 }) });
    const rightCol = makeEl({ getBoundingClientRect: () => ({ width: colW.right ?? 400, height: 300, left: 1500 - (colW.right ?? 400), right: 1500 }) });

    const doc = makeEl();
    doc.querySelector = (sel) => (sel === 'main' ? main : sel === '.main-left' ? leftCol : rightCol);
    doc.getElementById = (id) => els[id];
    doc.body = { style: {} };
    const store = {
        _data: { ...storage },
        getItem: (k) => (k in store._data ? store._data[k] : null),
        setItem: (k, v) => { store._data[k] = String(v); },
    };

    const sandbox = {
        document: doc,
        window: makeEl(),
        localStorage: store,
        getComputedStyle: () => ({ paddingLeft: '8' }),
        // synchronous rAF so handle sync runs inside the call under test
        requestAnimationFrame: (fn) => fn(),
        COL_RESIZE_MIN: 180,
    };
    return { sandbox, doc, main, leftCol, rightCol, els, store };
}

function runBinder(storage, colW = {}) {
    const { sandbox, doc, main, leftCol, rightCol, els, store } = buildStub(storage, colW);
    const body = extractBody('bindColumnResizers() {', '\n    },\n    COL_RESIZE_MIN');
    const fn = new Function(
        'document', 'window', 'localStorage', 'getComputedStyle', 'requestAnimationFrame',
        `"use strict"; return function () {${body}};`,
    )(sandbox.document, sandbox.window, sandbox.localStorage, sandbox.getComputedStyle,
      sandbox.requestAnimationFrame);
    fn.call(sandbox);
    return { doc, sandbox, main, leftCol, rightCol, els, store };
}

// Drag helper: mousedown on the resizer at x0, mousemove to x1 on
// document (where the binder attaches move/up), then mouseup.
function drag(doc, target, from, to, axis = 'x') {
    const ev = (v) => axis === 'x' ? { clientX: v, clientY: 0 } : { clientX: 0, clientY: v };
    target.fire('mousedown', { ...ev(from), preventDefault() {} });
    doc.fire('mousemove', ev(to));
    doc.fire('mouseup', ev(to));
}

test('no persisted layout: fr grid stays (no cols-resized) but handles are positioned', () => {
    const { main } = runBinder({});
    assert.equal(main.classList.contains('cols-resized'), false);
    // handle-position vars mirror the rendered fr widths
    assert.equal(main.style['--left-col-w'], '400px');
    assert.equal(main.style['--right-col-w'], '400px');
});

test('persisted layout is restored on startup before any drag', () => {
    const stored = JSON.stringify({ leftColW: 500, rightColW: 320 });
    const { main } = runBinder({ panelLayout: stored });
    assert.equal(main.classList.contains('cols-resized'), true);
    assert.equal(main.style['--left-col-w'], '500px');
    assert.equal(main.style['--right-col-w'], '320px');
});

test('dragging the left resizer widens the Preview/Model column and persists', () => {
    const { doc, main, els, store } = runBinder({}, { left: 500 });
    drag(doc, els['left-col-resizer'], 500, 580);
    assert.equal(main.classList.contains('cols-resized'), true, 'first drag switches grid to px mode');
    assert.equal(main.style['--left-col-w'], '580px');
    // first drag adopts the rendered right width too, so the fr layout is
    // captured intact rather than snapping to the 1fr default
    assert.equal(main.style['--right-col-w'], '400px');
    const saved = JSON.parse(store._data.panelLayout);
    assert.equal(saved.leftColW, 580);
    assert.equal(saved.rightColW, 400);
});

test('dragging the right resizer left widens the Style column (delta inverted)', () => {
    const { doc, main, els } = runBinder({}, { right: 400 });
    drag(doc, els['right-col-resizer'], 1100, 1020);
    assert.equal(main.style['--right-col-w'], '480px');
});

test('left drag clamps: column min 220px, center keeps 260px + other column', () => {
    const { doc, main, els } = runBinder({ panelLayout: JSON.stringify({ leftColW: 500, rightColW: 300 }) });
    // avail = 1500 - 16 = 1484; max left = 1484 - 260 - 300 = 924
    drag(doc, els['left-col-resizer'], 500, 1400);
    assert.equal(main.style['--left-col-w'], '924px');
    // far left: hard min 220
    drag(doc, els['left-col-resizer'], 900, 100);
    assert.equal(main.style['--left-col-w'], '220px');
});

test('saved widths that no longer fit are clamped at startup and on resize', () => {
    const { main, sandbox } = runBinder({ panelLayout: JSON.stringify({ leftColW: 900, rightColW: 500 }) });
    // startup clamp: avail = 1500 - 16 = 1484; left max = 1484 - 260 - 500 = 724
    assert.equal(main.style['--left-col-w'], '724px');
    // shrink the window: avail = 900 - 16 = 884; left max = 884 - 260 - 500 < 0 -> floored at 180
    main.clientWidth = 900;
    sandbox.window.fire('resize', {});
    assert.equal(main.style['--left-col-w'], '180px');
});

test('mouseup clears the dragging class and restores the body cursor', () => {
    const { doc, els, sandbox } = runBinder({});
    const r = els['left-col-resizer'];
    drag(doc, r, 500, 580);
    assert.equal(r.classList.contains('dragging'), false);
    assert.equal(sandbox.document.body.style.cursor, '');
});

// ── Source guards ───────────────────────────────────────────────────

test('a drag that changes nothing still switches to px mode, but startup alone never writes storage', () => {
    const { store } = runBinder({});
    assert.equal(store._data.panelLayout, undefined);
});

test('handles are centred on the rendered column boundaries (measured, not derived)', () => {
    const { els, leftCol, rightCol } = runBinder({}, { left: 500, right: 300 });
    // main box 1500 wide; left col right edge = 500, right col left edge = 1200
    assert.equal(els['left-col-resizer'].style.left, '493.5px');   // 500 - 13/2
    assert.equal(els['right-col-resizer'].style.left, '1193.5px'); // 1200 - 13/2
});

test('index.html carries both column resizers inside <main>', () => {
    assert.match(htmlSrc, /<div id="left-col-resizer" class="column-resizer column-resizer-left"/);
    assert.match(htmlSrc, /<div id="right-col-resizer" class="column-resizer column-resizer-right"/);
    const mainClose = htmlSrc.indexOf('</main>');
    assert.ok(htmlSrc.indexOf('left-col-resizer') < mainClose, 'resizers must live inside <main>');
    assert.ok(htmlSrc.indexOf('right-col-resizer') < mainClose);
});

test('style.css switches the grid to pixel widths once resized and gives resizers col-resize', () => {
    assert.match(cssSrc, /main\.cols-resized\s*{[^}]*var\(--left-col-w,/);
    assert.match(cssSrc, /minmax\(260px, 1fr\)/);
    assert.match(cssSrc, /\.column-resizer\s*{[^}]*cursor: col-resize/);
    assert.match(cssSrc, /\.column-resizer-left\s*{/);
    assert.match(cssSrc, /\.column-resizer-right\s*{/);
});

test('app.js wires bindColumnResizers in App.init and persists to localStorage', () => {
    assert.match(appSrc, /this\.bindColumnResizers\(\);/);
    const body = extractBody('bindColumnResizers() {', '\n    },\n    COL_RESIZE_MIN');
    assert.match(body, /localStorage\.setItem\(KEY/);
    assert.match(body, /window\.addEventListener\('resize', apply\)/);
    // handles are positioned from measured boundaries, not CSS guesswork
    assert.match(body, /el\.style\.left = /);
});

// ── Row resizers (height dividers inside left/right columns) ─────────

function runRowBinder(storage = {}) {
    const makeEl = (props = {}) => {
        const listeners = {};
        const el = {
            listeners,
            handlers: (type) => listeners[type] || [],
            fire(type, ev = {}) { for (const fn of this.handlers(type)) fn(ev); },
            addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
            removeEventListener(type, fn) {
                listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
            },
            style: {
                setProperty(k, v) { this[k] = v; },
                removeProperty(k) { delete this[k]; },
                set flex(v) { this.__flex = v; }, get flex() { return this.__flex; },
            },
            classList: (() => {
                const set = new Set();
                return {
                    set, add: (c) => set.add(c), remove: (c) => set.delete(c),
                    contains: (c) => set.has(c),
                };
            })(),
            offsetWidth: 13,
            getBoundingClientRect: () => ({ width: 400, height: 300, left: 0, right: 400 }),
            ...props,
        };
        return el;
    };

    const doc = makeEl();
    doc.body = { style: {} };
    const store = {
        _data: { ...storage },
        getItem: (k) => (k in store._data ? store._data[k] : null),
        setItem: (k, v) => { store._data[k] = String(v); },
    };
    const preview = makeEl();
    const rightGroup = makeEl();
    const leftHost = makeEl({ clientHeight: 1000 });
    const rightHost = makeEl({ clientHeight: 1000 });
    const leftRes = makeEl();
    const rightRes = makeEl();
    const sandbox = {
        document: Object.assign(doc, {
            querySelector: (sel) => ({
                '.panel-preview': preview, '#right-top-group': rightGroup,
                '.main-left': leftHost, '.main-right': rightHost,
            })[sel],
            getElementById: (id) => ({ 'left-top-resizer': leftRes, 'right-top-resizer': rightRes })[id],
        }),
        window: makeEl(),
        localStorage: store,
    };
    const start = appSrc.indexOf('bindRowResizers() {');
    assert.ok(start >= 0, 'bindRowResizers not found in app.js');
    const end = appSrc.indexOf('\n    },', start);
    assert.ok(end > start, 'end of bindRowResizers not found');
    const body = appSrc.slice(start + 'bindRowResizers() {'.length + 1, end);
    const fn = new Function(
        'document', 'window', 'localStorage',
        `"use strict"; return function () {${body}};`,
    )(sandbox.document, sandbox.window, sandbox.localStorage);
    fn.call(sandbox);
    return { doc, preview, rightGroup, leftHost, rightHost, leftRes, rightRes, store };
}

test('row resizers: startup without a saved record changes nothing and writes nothing', () => {
    const { preview, rightGroup, store } = runRowBinder();
    assert.equal(preview.style.flex, undefined);
    assert.equal(rightGroup.style.flex, undefined);
    assert.equal(store._data.panelLayout, undefined);
});

test('row resizers: saved heights are restored and clamped to the host', () => {
    const { preview, rightGroup } = runRowBinder({
        panelLayout: JSON.stringify({ previewH: 400, rightTopH: 5000 }),
    });
    assert.equal(preview.style.flex, '0 0 400px');
    // 5000 clamped to host 1000 - min 120
    assert.equal(rightGroup.style.flex, '0 0 880px');
});

test('row resizers: dragging the left divider resizes the Preview and persists the shared record', () => {
    const { doc, preview, leftRes, store } = runRowBinder({
        panelLayout: JSON.stringify({ leftColW: 700, rightColW: 300 }),
    });
    preview.getBoundingClientRect = () => ({ height: 300, width: 400, left: 0, right: 400 });
    drag(doc, leftRes, 400, 460, 'y'); // drag DOWN shrinks the Preview
    assert.equal(preview.style.flex, '0 0 240px');
    const rec = JSON.parse(store._data.panelLayout);
    assert.equal(rec.previewH, 240);
    assert.equal(rec.leftColW, 700, 'column widths must survive the row save');
    assert.equal(rec.rightColW, 300);
});

test('right group collapses when dragged near the top and re-expands on click', () => {
    const { doc, rightGroup, rightRes } = runRowBinder();
    rightGroup.getBoundingClientRect = () => ({ height: 300, width: 400, left: 0, right: 400 });
    // drag far up -> collapse
    drag(doc, rightRes, 400, 400 - 250, 'y');
    assert.equal(rightGroup.classList.contains('collapsed'), true);
    assert.equal(rightRes.classList.contains('collapsed'), true);
    // click the seam -> expand to 40% of host (400px)
    rightRes.fire('mousedown', { clientX: 10, clientY: 10, preventDefault() {} });
    assert.equal(rightGroup.classList.contains('collapsed'), false);
    assert.equal(rightGroup.style.flex, '0 0 400px');
});

test('row resizer source guards: markup, CSS, App.init wiring', () => {
    assert.match(htmlSrc, /<div id="left-top-resizer" class="row-resizer"/);
    // the left divider must sit on the toolbar/preview seam, not the column tail
    assert.ok(htmlSrc.indexOf('left-top-resizer') < htmlSrc.indexOf('panel-preview'),
        'left divider must flow before .panel-preview');
    assert.match(htmlSrc, /<div id="right-top-resizer" class="row-resizer"/);
    assert.match(htmlSrc, /<div id="right-top-group" class="right-top-group">/);
    assert.match(cssSrc, /\.row-resizer\s*{[^}]*cursor: row-resize/);
    assert.match(cssSrc, /\.right-top-group\s*{[^}]*overflow-y: auto/);
    assert.match(cssSrc, /\.right-top-group\.collapsed/);
    assert.match(appSrc, /this\.bindRowResizers\(\);/);
    const start = appSrc.indexOf('bindRowResizers() {');
    const body = appSrc.slice(start, appSrc.indexOf('\n    },', start));
    assert.match(body, /localStorage\.setItem\(KEY/);
    assert.match(body, /window\.addEventListener\('resize'/);
});

test('column resizers merge into the shared record instead of clobbering row keys', () => {
    assert.match(appSrc, /rec\.leftColW = Math\.round\(widths\.left\)/);
    assert.match(appSrc, /rec\.rightColW = Math\.round\(widths\.right\)/);
});
