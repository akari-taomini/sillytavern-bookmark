/* Local-only, dependency-free SillyTavern extension. No network or persistence. */
(() => {
    'use strict';
    const KEY = '__stPrivateBookmarkV1';
    if (window[KEY]) return;
    window[KEY] = true;
    const MAX_CHARS = 120000;
    const WIDTH = 720;
    const MAX_HEIGHT = 1600;
    const SCALE = 2;
    const breathe = () => new Promise(resolve => setTimeout(resolve, 0));
    let active = null;
    let selected = null;
    let selectTimer;

    // Capture only a finished selection belonging to one message, before its menu steals focus.
    function rememberSelection() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        const elementOf = node => node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        const start = elementOf(range.startContainer)?.closest('.mes_text');
        const end = elementOf(range.endContainer)?.closest('.mes_text');
        if (!start || start !== end || !start.closest('#chat')) return;
        const text = selection.toString();
        if (text.trim()) selected = { message: start.closest('.mes'), text };
    }
    document.addEventListener('pointerup', rememberSelection, { passive: true });
    document.addEventListener('selectionchange', () => {
        clearTimeout(selectTimer);
        selectTimer = setTimeout(rememberSelection, 160);
    });

    function userName() {
        try { return String(window.SillyTavern?.getContext?.().name1 || '').trim(); }
        catch { return ''; }
    }

    function openEditor(message) {
        if (active) { active.focus(); return; }
        const content = message.querySelector('.mes_text');
        if (!content) return;
        const full = content.innerText || content.textContent || '';
        const snippet = selected?.message === message ? selected.text : '';
        selected = null;
        // Speaker labels and avatars are never included in the export.
        const name = userName() || (message.getAttribute('is_user') === 'true'
            ? message.querySelector('.name_text')?.textContent?.trim() || '' : '');
        const dialog = document.createElement('dialog');
        dialog.className = 'st-bookmark-dialog';
        dialog.dataset.theme = 'paper';
        dialog.setAttribute('aria-label', '私密书摘编辑器');
        dialog.innerHTML = `
          <div class="st-bookmark-shell">
            <header class="st-bookmark-header"><h2>楼层书摘</h2><button type="button" data-action="close" aria-label="关闭书摘">关闭</button></header>
            <div class="st-bookmark-layout">
              <section class="st-bookmark-controls" aria-label="书摘设置">
                <div class="st-bookmark-actions"><button type="button" data-action="full">整层正文</button><button type="button" data-action="snippet">选中片段</button></div>
                <label>摘录原文 <small>这里显示未打码原文，仅在本地编辑；右侧预览与导出会应用遮罩。</small><textarea data-field="body" spellcheck="false"></textarea></label>
                <label>标题（可留空）<input type="text" data-field="title" placeholder="书摘" maxlength="100"></label>
                <label><input type="checkbox" data-field="maskUser" checked> 遮罩 user 名称</label>
                <label>user 名称<input type="text" data-field="user" autocomplete="off" spellcheck="false"><small data-role="nameHint"></small></label>
                <label>额外打码名称 / 文本<textarea data-field="names" placeholder="每行一个，按原样匹配&#10;例如：小明&#10;@example" spellcheck="false"></textarea><small>区分大小写，较长名称优先。使用实心遮罩，不把被遮住的文字写进图片。</small></label>
                <label>排版<select data-field="theme"><option value="paper">温暖书页</option><option value="clean">极简留白</option><option value="night">深色夜读</option><option value="compact">紧凑手记</option></select></label>
                <label>字号<select data-field="size"><option value="0">模板默认</option><option value="24">小</option><option value="28">中</option><option value="32">大</option></select></label>
                <div class="st-bookmark-status" role="status" aria-live="polite"></div>
                <div class="st-bookmark-actions"><button type="button" class="st-bookmark-primary" data-action="save" disabled>保存全部 PNG</button><button type="button" data-action="cancel" hidden>取消导出</button></div>
                <small>长文自动分页。可在每张预览下单独保存；图片不包含头像、楼层编号或账号信息。</small>
              </section>
              <section class="st-bookmark-preview" aria-label="打码后的图片预览"></section>
            </div>
          </div>`;
        document.body.append(dialog);
        active = dialog;
        const field = key => dialog.querySelector(`[data-field="${key}"]`);
        const action = key => dialog.querySelector(`[data-action="${key}"]`);
        const preview = dialog.querySelector('.st-bookmark-preview');
        const status = dialog.querySelector('.st-bookmark-status');
        field('body').value = snippet || full;
        field('user').value = name;
        dialog.querySelector('[data-role="nameHint"]').textContent = name
            ? '已填入当前 user 名称；请确认别名也已加入额外打码列表。'
            : '未自动获得 user 名称，请在这里填写需要遮罩的名称。';
        action('snippet').disabled = !snippet;
        let revision = 0;
        let timer;
        let pages = [];
        let exporting = false;
        let exportToken = 0;
        let exportRun = 0;
        const urls = new Set();
        const gone = () => !dialog.isConnected;
        const close = () => {
            revision++; exportToken++; clearTimeout(timer);
            for (const url of urls) URL.revokeObjectURL(url);
            dialog.close(); dialog.remove(); active = null;
        };
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        action('close').onclick = close;

        function invalidate() {
            revision++; exportToken++; exportRun++; exporting = false;
            clearTimeout(timer);
            lazy.disconnect();
            pages = [];
            // Never leave a stale, potentially less-redacted preview visible after a privacy edit.
            preview.replaceChildren();
            action('save').disabled = true;
            action('cancel').hidden = true;
            status.textContent = '正在排版…';
            timer = setTimeout(() => render(revision), 140);
        }
        dialog.addEventListener('input', event => { if (event.target.matches('[data-field]')) invalidate(); });
        action('full').onclick = () => { field('body').value = full; invalidate(); };
        action('snippet').onclick = () => { field('body').value = snippet; invalidate(); };
        action('cancel').onclick = () => { exportToken++; status.textContent = '正在取消…'; };

        async function render(version) {
            const obsolete = () => gone() || version !== revision;
            try {
                const body = field('body').value;
                if (!body.trim()) { status.textContent = '请先选择或输入摘录文字。'; return; }
                if (body.length > MAX_CHARS) {
                    status.textContent = `单次支持 ${MAX_CHARS.toLocaleString()} 字符，请选择较短片段。`;
                    return;
                }
                if (field('maskUser').checked && !field('user').value.trim()) {
                    status.textContent = '请填写 user 名称，或明确取消“遮罩 user 名称”后继续。';
                    return;
                }
                const names = field('names').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
                if (field('maskUser').checked) names.push(field('user').value.trim());
                if (names.length > 200 || names.some(x => x.length > 500)) {
                    status.textContent = '最多支持 200 条打码文本，每条不超过 500 字符。'; return;
                }
                const unique = [...new Set(names)].sort((a, b) => b.length - a.length);
                const regex = unique.length ? new RegExp(unique.map(escapeRegex).join('|'), 'gu') : null;
                const redact = text => regex ? text.replace(regex, '\u2588\u2588\u2588') : text;
                // Raw text is removed before layout, and never drawn underneath a mask.
                const safeBody = redact(body.replace(/\r\n?/g, '\n'));
                const safeTitle = redact(field('title').value.trim());
                dialog.dataset.theme = field('theme').value;
                const css = getComputedStyle(dialog);
                const style = {
                    paper: css.getPropertyValue('--sb-paper').trim(),
                    ink: css.getPropertyValue('--sb-ink').trim(),
                    accent: css.getPropertyValue('--sb-accent').trim(),
                    font: css.getPropertyValue('--sb-font').trim(),
                    size: Number(field('size').value) || Number(css.getPropertyValue('--sb-body-size')),
                    spacing: Number(css.getPropertyValue('--sb-line-height')),
                    pad: Number(css.getPropertyValue('--sb-pad')),
                };
                const measure = document.createElement('canvas').getContext('2d');
                if (!measure) throw new Error('浏览器不支持 Canvas 2D');
                measure.font = `${style.size}px ${style.font}`;
                const lines = await wrap(safeBody, measure, WIDTH - style.pad * 2, obsolete);
                if (obsolete()) return;
                measure.font = `bold ${style.size + 6}px ${style.font}`;
                const titles = safeTitle ? await wrap(safeTitle, measure, WIDTH - style.pad * 2, obsolete) : [];
                if (obsolete()) return;
                const lineHeight = style.size * style.spacing;
                const titleHeight = titles.length ? titles.length * (style.size + 14) + 28 : 0;
                const capacity = Math.max(1, Math.floor((MAX_HEIGHT - style.pad * 2 - titleHeight - 46) / lineHeight));
                const count = Math.ceil(lines.length / capacity);
                pages = Array.from({ length: count }, (_, i) => ({
                    lines: lines.slice(i * capacity, (i + 1) * capacity), titles, style, index: i + 1, count,
                }));
                for (let i = 0; i < pages.length; i++) {
                    if (obsolete()) return;
                    const page = pages[i];
                    const figure = document.createElement('figure');
                    figure.className = 'st-bookmark-page';
                    const canvas = document.createElement('canvas');
                    canvas.setAttribute('role', 'img');
                    canvas.setAttribute('aria-label', `已打码书摘，第 ${i + 1} 页`);
                    const caption = document.createElement('figcaption');
                    const save = document.createElement('button');
                    save.type = 'button'; save.textContent = `保存第 ${i + 1} / ${count} 张`;
                    save.onclick = () => exportPages([page]);
                    caption.append(save); figure.append(canvas, caption); preview.append(figure);
                    // Low-resolution preview and lazy off-screen rendering bound memory usage.
                    canvas.style.aspectRatio = `${WIDTH} / ${heightOf(page)}`;
                    canvas.style.height = 'auto';
                    canvas.width = 1; canvas.height = 1;
                    lazyPages.set(canvas, page); lazy.observe(canvas);
                    await breathe();
                }
                if (obsolete()) return;
                status.textContent = `已生成 ${count} 张预览 · 导出为 2 倍清晰度 PNG`;
                action('save').disabled = false;
            } catch (error) {
                if (!obsolete()) { pages = []; preview.replaceChildren(); status.textContent = `生成失败：${error.message}`; }
            }
        }
        const lazyPages = new WeakMap();
        const lazy = new IntersectionObserver(entries => {
            for (const entry of entries) {
                const page = lazyPages.get(entry.target);
                if (entry.isIntersecting && page && entry.target.isConnected) draw(page, entry.target, 1);
                else { entry.target.width = 1; entry.target.height = 1; }
            }
        }, { root: null, rootMargin: '250px' });
        dialog.addEventListener('close', () => lazy.disconnect());

        async function exportPages(items) {
            if (exporting || !items.length) return;
            exporting = true;
            const token = ++exportToken;
            const run = ++exportRun;
            action('save').disabled = true;
            action('cancel').hidden = false;
            let saved = 0;
            try {
                for (const page of items) {
                    if (gone() || token !== exportToken) break;
                    status.textContent = `正在导出 ${saved + 1} / ${items.length}…`;
                    await breathe();
                    if (gone() || token !== exportToken) break;
                    const canvas = document.createElement('canvas');
                    draw(page, canvas, SCALE);
                    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                    canvas.width = 1; canvas.height = 1;
                    if (gone() || token !== exportToken) break;
                    if (!blob) throw new Error('图片编码失败，请单张保存');
                    const url = URL.createObjectURL(blob); urls.add(url);
                    const link = document.createElement('a');
                    link.href = url; link.download = `book-excerpt-${String(page.index).padStart(3, '0')}.png`;
                    document.body.append(link); link.click(); link.remove(); saved++;
                    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 60000);
                    await new Promise(resolve => setTimeout(resolve, 120));
                }
                if (!gone() && token === exportToken) status.textContent = `已发起 ${saved} 张下载。若浏览器拦截多文件下载，请逐张保存。`;
                else if (!gone() && run === exportRun) status.textContent = `已取消，已发起 ${saved} 张下载。`;
            } catch (error) {
                if (!gone() && token === exportToken) status.textContent = `导出失败：${error.message}`;
            } finally {
                if (!gone() && run === exportRun) {
                    exporting = false; action('cancel').hidden = true; action('save').disabled = !pages.length;
                }
            }
        }
        action('save').onclick = () => exportPages(pages.slice());
        dialog.showModal();
        invalidate();
    }

    function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    async function wrap(text, context, maxWidth, obsolete) {
        const lines = [];
        let line = '';
        let width = 0;
        let tick = performance.now();
        const cache = new Map();
        const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
        const chars = segmenter ? segmenter.segment(text) : text;
        for (const part of chars) {
            const char = typeof part === 'string' ? part : part.segment;
            if (char === '\n') { lines.push(line); line = ''; width = 0; }
            else {
                const printable = char === '\t' ? '    ' : char;
                let size = cache.get(printable);
                if (size === undefined) { size = context.measureText(printable).width; cache.set(printable, size); }
                if (width + size > maxWidth && line) { lines.push(line); line = ''; width = 0; }
                line += printable; width += size;
            }
            if (performance.now() - tick > 7) { await breathe(); if (obsolete()) return []; tick = performance.now(); }
        }
        lines.push(line);
        return lines;
    }

    function heightOf(page) {
        const s = page.style;
        const title = page.titles.length ? page.titles.length * (s.size + 14) + 28 : 0;
        return Math.ceil(s.pad * 2 + title + page.lines.length * s.size * s.spacing + 46);
    }

    function draw(page, canvas, scale) {
        const s = page.style;
        const height = heightOf(page);
        canvas.width = WIDTH * scale; canvas.height = height * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.fillStyle = s.paper; ctx.fillRect(0, 0, WIDTH, height);
        ctx.textBaseline = 'top';
        let y = s.pad;
        ctx.fillStyle = s.accent; ctx.fillRect(s.pad, y - 20, 32, 3);
        ctx.fillStyle = s.ink;
        ctx.font = `bold ${s.size + 6}px ${s.font}`;
        for (const title of page.titles) { ctx.fillText(title, s.pad, y); y += s.size + 14; }
        if (page.titles.length) y += 28;
        ctx.font = `${s.size}px ${s.font}`;
        for (const line of page.lines) { ctx.fillText(line, s.pad, y); y += s.size * s.spacing; }
        ctx.fillStyle = s.accent; ctx.font = `16px ${s.font}`;
        ctx.fillText(`${page.index} / ${page.count}`, s.pad, height - s.pad + 12);
    }

    // Observe insertion only. Streaming text nodes never trigger a full-chat rescan.
    const pending = new Set();
    let scheduled = false;
    function addEntry(message) {
        const menu = message.querySelector('.extraMesButtons');
        if (!menu || menu.querySelector('.st-bookmark-entry')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'st-bookmark-entry mes_button fa-solid fa-book-open';
        button.title = '生成书摘'; button.setAttribute('aria-label', '生成书摘');
        button.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation(); rememberSelection(); openEditor(message);
        });
        menu.append(button);
    }
    function enqueue(message) {
        if (!message) return;
        pending.add(message);
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            for (const item of pending) if (item.isConnected) addEntry(item);
            pending.clear();
        });
    }
    function attach(chat) {
        chat.querySelectorAll('.mes').forEach(enqueue);
        new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.matches('.mes')) enqueue(node);
                else if (node.matches('.extraMesButtons') || node.querySelector('.extraMesButtons')) enqueue(node.closest('.mes'));
                node.querySelectorAll('.mes').forEach(enqueue);
            }
        }).observe(chat, { childList: true, subtree: true });
    }
    function boot() {
        const chat = document.querySelector('#chat');
        if (chat) { attach(chat); return; }
        const observer = new MutationObserver(() => {
            const ready = document.querySelector('#chat');
            if (ready) { observer.disconnect(); attach(ready); }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
