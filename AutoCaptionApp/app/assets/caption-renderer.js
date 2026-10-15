/**
 * CaptionRenderer
 *
 * Single shared rendering engine for preview and export.
 * Precomputes layout once; draws from cache during playback.
 *
 * Architecture:
 *   Transcript words → groupWords() → CaptionGroup[]
 *       → computeLayout() → LayoutGroup[] (precomputed geometry)
 *           → draw(ctx, layoutGroup, activeWordId) → pixels
 */

export function groupWords(words, grouping) {
    const active = words.filter(w => !w.deleted);
    const groups = [];
    let current = [];
    let groupStart = null;

    for (const word of active) {
        if (current.length === 0) {
            current.push(word);
            groupStart = word.start;
            continue;
        }

        const timeDiff = word.start - groupStart;
        const charCount = current.reduce((sum, w) => sum + w.text.length, 0) + current.length - 1 + 1 + word.text.length;

        if (current.length >= grouping.maxWords || timeDiff > grouping.maxSeconds || charCount > grouping.maxCharacters) {
            groups.push({
                words: current,
                start: groupStart,
                end: current[current.length - 1].end
            });
            current = [word];
            groupStart = word.start;
        } else {
            current.push(word);
        }
    }

    if (current.length > 0) {
        groups.push({
            words: current,
            start: groupStart,
            end: current[current.length - 1].end
        });
    }

    return groups;
}

export function findGroupAtTime(groups, time) {
    for (let i = 0; i < groups.length; i++) {
        if (time >= groups[i].start && time <= groups[i].end) {
            return i;
        }
    }
    return -1;
}

function measureWord(ctx, text, fontSize, font, bold) {
    ctx.font = `${bold ? 'bold ' : ''}${fontSize}px ${font}`;
    return ctx.measureText(text).width;
}

export function computeLayout(groups, style, canvasWidth, canvasHeight) {
    const offscreen = document.createElement('canvas');
    offscreen.width = 1;
    offscreen.height = 1;
    const ctx = offscreen.getContext('2d');

    const fontSize = canvasHeight * (style.mainSize / 1080);
    const activeFontSize = canvasHeight * (style.activeSize / 1080);
    const wordGap = fontSize * 0.3;

    // Vertical position: yPx is the caption baseline measured in a 1080p
    // reference frame (0 = very top, 1080 = very bottom). Older presets stored
    // {placement, offsetPx} with offset measured from the bottom — migrate.
    const pos = style.position || {};
    let yPx = pos.yPx;
    if (yPx == null) {
        yPx = pos.placement === 'bottom' ? 1080 - (pos.offsetPx ?? 220)
            : pos.placement === 'top' ? (pos.offsetPx ?? 100)
            : 540;
    }
    yPx = Math.min(1080, Math.max(0, yPx));
    const y = canvasHeight * (yPx / 1080);

    return groups.map((group, groupIndex) => {
        const wordLayouts = group.words.map((word) => {
            const normalW = measureWord(ctx, word.text, fontSize, style.font, false);
            const activeW = measureWord(ctx, word.text, activeFontSize, style.font, style.activeWordBold);
            const drawW = Math.max(normalW, activeW);
            return { word, normalW, activeW, drawW };
        });

        let totalWidth = 0;
        for (let i = 0; i < wordLayouts.length; i++) {
            totalWidth += wordLayouts[i].drawW;
            if (i < wordLayouts.length - 1) totalWidth += wordGap;
        }

        let scale = 1;
        if (totalWidth > canvasWidth * 0.95) {
            scale = (canvasWidth * 0.95) / totalWidth;
        }

        const scaledFontSize = fontSize * scale;
        const scaledActiveFontSize = activeFontSize * scale;
        const scaledGap = wordGap * scale;

        const finalLayouts = [];
        let x = (canvasWidth - totalWidth * scale) / 2;

        for (let i = 0; i < wordLayouts.length; i++) {
            const wl = wordLayouts[i];
            const w = wl.word;
            const normalW = wl.normalW * scale;
            const activeW = wl.activeW * scale;

            finalLayouts.push({
                word: w,
                x: x,
                normalW: normalW,
                activeW: activeW,
                fontSize: scaledFontSize,
                activeFontSize: scaledActiveFontSize
            });

            x += wl.drawW * scale + scaledGap;
        }

        return {
            index: groupIndex,
            words: group.words,
            start: group.start,
            end: group.end,
            layouts: finalLayouts,
            x: (canvasWidth - totalWidth * scale) / 2,
            y: y,
            totalWidth: totalWidth * scale,
            scale: scale,
            fontSize: scaledFontSize,
            activeFontSize: scaledActiveFontSize,
            gap: scaledGap
        };
    });
}

// '#rrggbb' / '#rgb' -> 'rgba(r,g,b,a)'. Non-hex colors pass through.
function hexToRgba(hex, alpha) {
    if (typeof hex !== 'string' || hex[0] !== '#') return hex;
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6) return hex;
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return hex;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function drawGroup(ctx, layoutGroup, activeWordId, style) {
    if (!layoutGroup) return;

    const { layouts, y, fontSize, activeFontSize, scale } = layoutGroup;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // Active-word highlight box: drawn as a pre-pass so it sits behind ALL
    // text (including neighbouring words' outlines), not just the active one.
    // padding/radius are in 1080p-reference pixels, scaled with the caption.
    const box = style.activeBox;
    if (box && box.enabled && activeWordId != null) {
        const unit = fontSize / 72;
        for (const wl of layouts) {
            if (wl.word.id !== activeWordId) continue;
            const drawSize = wl.activeFontSize;
            const pad = (box.padding || 0) * unit;
            const r = Math.min((box.radius || 0) * unit, drawSize / 2 + pad);
            const w = wl.activeW + pad * 2;
            const h = drawSize + pad * 2;
            // Center the box horizontally on the word's normal-text origin.
            const bx = wl.x - pad;
            const by = y - h / 2;
            ctx.save();
            ctx.fillStyle = box.color;
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
                ctx.roundRect(bx, by, w, h, r);
            } else {
                ctx.moveTo(bx + r, by);
                ctx.arcTo(bx + w, by, bx + w, by + h, r);
                ctx.arcTo(bx + w, by + h, bx, by + h, r);
                ctx.arcTo(bx, by + h, bx, by, r);
                ctx.arcTo(bx, by, bx + w, by, r);
                ctx.closePath();
            }
            ctx.fill();
            ctx.restore();
        }
    }

    if (style.effects.shadow.enabled) {
        const sh = style.effects.shadow;
        // Legacy presets only have `size` (used as blur, opaque color,
        // fixed 2px down-right offset). Fall back to that look when the
        // newer fields are absent.
        const opacity = (sh.opacity != null ? sh.opacity : 100) / 100;
        const dirDeg = sh.direction != null ? sh.direction : 45;
        const distance = sh.distance != null ? sh.distance : 2.83; // legacy offset was (2,2)
        const softness = sh.softness != null ? sh.softness : (sh.size != null ? sh.size : 5);
        // 0° = shadow straight down (light from above), increasing clockwise.
        const rad = dirDeg * Math.PI / 180;
        ctx.shadowColor = hexToRgba(sh.color, opacity);
        ctx.shadowBlur = softness * scale;
        ctx.shadowOffsetX = Math.sin(rad) * distance * scale;
        ctx.shadowOffsetY = Math.cos(rad) * distance * scale;
    }

    if (style.effects.glow.enabled) {
        ctx.shadowColor = style.effects.glow.color;
        ctx.shadowBlur = style.effects.glow.size * scale;
    }

    for (const wl of layouts) {
        const isCurrent = wl.word.id === activeWordId;
        const drawSize = isCurrent ? wl.activeFontSize : fontSize;
        const color = isCurrent ? style.activeColor : style.textColor;

        ctx.font = `${isCurrent && style.activeWordBold ? 'bold ' : ''}${drawSize}px ${style.font}`;

        if (style.effects.outline.enabled) {
            ctx.strokeStyle = style.effects.outline.color;
            ctx.lineWidth = style.effects.outline.size * scale;
            // Rounded joins: the default 'miter' join extrapolates long sharp
            // spikes at the tight-angle corners in letter outlines (worst on
            // condensed fonts like Impact) once lineWidth grows large.
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            ctx.strokeText(wl.word.text, wl.x, y);
        }

        ctx.fillStyle = color;
        ctx.fillText(wl.word.text, wl.x, y);
    }

    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
}

export function drawDiagnostics(ctx, layoutGroup, groupIndex, activeWordIndex) {
    if (!layoutGroup) return;

    const { x, y, totalWidth, words } = layoutGroup;
    const info = [
        `Group ${groupIndex}`,
        `Word ${activeWordIndex}/${words.length}`,
        `Width: ${Math.round(totalWidth)}px`,
        `Origin: (${Math.round(x)}, ${Math.round(y)})`
    ];

    const fontSize = 14;
    const padding = 6;
    const lineHeight = fontSize + 4;
    const boxH = info.length * lineHeight + padding * 2;
    const boxW = 200;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(8, 8, boxW, boxH);

    ctx.font = `${fontSize}px monospace`;
    ctx.fillStyle = '#00ff88';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    for (let i = 0; i < info.length; i++) {
        ctx.fillText(info[i], 8 + padding, 8 + padding + i * lineHeight);
    }
}
