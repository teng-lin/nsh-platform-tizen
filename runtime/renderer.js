/*
 * nsh-platform-tizen, the page's side: applies each committed batch of
 * NSH mount operations to the DOM (crates/nsh-platform-tizen/src/encode.rs
 * lists them), hosts the page's native components, inputs and images, and
 * reports what the user does back to the engine through `send(message)`.
 *
 * Every view is an absolutely positioned <div> at the frame the engine laid
 * out. Work per batch is kept to what changed: a frame sets only the
 * coordinates that moved, a style rewrites `cssText` only when it differs,
 * and a text reuses its runs' spans and text nodes.
 *
 * Where keys go and the focus of views are decided in the engine (the
 * page's tree lags a message behind it); the page keeps only the input the
 * user edits, whose DOM focus is the TV keyboard's.
 *
 * Plain ES2017: the oldest target is Tizen 5.5 (Chromium 69): no optional
 * chaining, nullish coalescing, flex gap, CSS min()/clamp()/inset.
 */
'use strict';

var NshTizen = (function () {
    var ROOT_ID = 1;
    /* The bits of op `e` (encode.rs `events`). */
    var PRESS = 1, KEYS = 8, FOCUS_BITS = 16, LOAD = 32, ERROR = 64;
    /* nsh_core::tailwind::state::FOCUSED. */
    var FOCUSED = 4;
    var BASE = 'position:absolute;box-sizing:border-box;';
    /* The TV keyboard's Done and Cancel. */
    var IME_DONE = 65376, IME_CANCEL = 65385;

    /* ---------- native components ---------- */

    /*
     * The page's implementations of NSH native components, by the name an
     * app mounts them with (`native("name")`). A factory gets a context and
     * returns an instance:
     *
     *   NshTizen.registerComponent('tv.player', function (ctx) {
     *       // ctx.id, ctx.name, ctx.element (the container <div>),
     *       // ctx.emit(name, data): an event to the app (onNativeEvent),
     *       // ctx.rect(): the container's rect on the page, in points,
     *       // ctx.scale: page pixels per point.
     *       return {
     *           props: function (changed, all, removed) {},  // after every change
     *           frame: function (rect) {},          // {x, y, width, height, visible}
     *           command: function (name, args) {},  // ElementRef::command
     *           destroy: function () {}
     *       };
     *   });
     *
     * Every method is optional. Props arrive before the first frame. A
     * prop set to `null` is in `changed` with the value null; one removed
     * is named in `removed` and absent from `all`. A component that throws
     * is reported (`__nsh.errors`) and does not stop the page.
     */
    var components = {};
    function registerComponent(name, factory) { components[name] = factory; }

    /* `url("…")` of `uri`, escaped: image URIs come from apps' data. */
    function cssUrl(uri) {
        return 'url("' + String(uri).replace(/["\\]/g, '\\$&').replace(/[\n\r\f]/g, ' ') + '")';
    }

    /*
     * Whether an <img> may load `uri` (not an in-memory image's key, which
     * the renderer maps to its blob): http(s), and the package's own files
     * by a relative URL that stays inside the package's directory. No
     * other scheme and no path out of it: `file:` would let a playlist's
     * logo probe the TV's files, `javascript:` nothing good. Parsed as the
     * browser parses it (leading spaces and tabs included). `base` is the
     * page's (tests pass another).
     */
    function imageAllowed(uri, base) {
        base = base || document.baseURI;
        var url;
        try { url = new URL(uri, base); } catch (e) { return false; }
        if (url.protocol === 'http:' || url.protocol === 'https:') return true;
        var trimmed = String(uri).replace(/^[\s\x00-\x1f]+/, '');
        /* A scheme, a root or a host of its own (/x, \\x, //x). */
        if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || /^[\/\\]/.test(trimmed)) return false;
        return url.href.indexOf(new URL('.', base).href) === 0;
    }

    /* ---------- the view tree ---------- */

    function Node(id, kind) {
        this.id = id;
        this.kind = kind;
        this.el = document.createElement('div');
        this.parent = null;
        this.x = 0; this.y = 0; this.w = 0; this.h = 0;
        this.css = '';
        this.anim = '';
        this.extra = kind === 'scroll' ? 'overflow:hidden;' : '';
        this.text = null;
        this.events = 0;
        this.states = 0;
        this.focusable = null;
        this.comp = null;
        this.input = null;
        this.img = null;
        this.sizer = null;
        this.sx = 0; this.sy = 0;
    }
    Node.prototype.restyle = function () {
        this.el.style.cssText = BASE + 'left:' + this.x + 'px;top:' + this.y + 'px;width:' + this.w +
            'px;height:' + this.h + 'px;' + this.extra + this.css + this.anim;
    };

    /* `scale`: page pixels per layout point (the container is zoomed by
     * it, see page.js), 1 when omitted; `size`: the root's `{w, h}` in
     * points (default: the container's). */
    function Renderer(container, send, M, scale, size) {
        this.send = send;
        this.scale = scale > 0 ? scale : 1;
        this.M = M;
        this.nodes = {};
        this.editing = null;      /* the input with the DOM focus */
        this.componentNodes = [];
        this.placed = false;      /* a frame or the tree changed in this batch */
        this.blobs = {};          /* in-memory image URI -> blob URL */
        this.autoFocus = [];      /* inputs inserted in this batch (`auto` focuses one) */
        this.disposed = false;
        /* Each held key's disposition, decided at its press: 'app' (sent
         * to the engine), 'swallowed' (an input or the page consumed it)
         * or 'browser' (the TV keyboard's own). Its repeats and release
         * follow it. */
        this.keys = {};
        this.style = document.createElement('style');
        this.style.textContent =
            '@keyframes nsh-spin{to{transform:rotate(360deg)}}' +
            '@keyframes nsh-ping{75%,100%{transform:scale(2);opacity:0}}' +
            '@keyframes nsh-pulse{50%{opacity:.5}}' +
            '@keyframes nsh-bounce{0%,100%{transform:translateY(-25%);animation-timing-function:cubic-bezier(.8,0,1,1)}50%{transform:none;animation-timing-function:cubic-bezier(0,0,.2,1)}}' +
            '.nsh-in{position:absolute;border:0;margin:0;padding:0;background:transparent;outline:none;box-sizing:border-box;resize:none}';
        document.head.appendChild(this.style);
        this.placeholderRules = {};
        this.phStyle = null;
        var root = new Node(ROOT_ID, 'view');
        root.w = size ? size.w : (container.clientWidth || 1920) / this.scale;
        root.h = size ? size.h : (container.clientHeight || 1080) / this.scale;
        root.restyle();
        this.nodes[ROOT_ID] = root;
        this.container = container;
        container.appendChild(root.el);
    }

    var R = Renderer.prototype;

    /* Whether `n` is still this renderer's node: a callback of a view
     * removed since (or of an old session) must not act. */
    R.live = function (n) { return !this.disposed && this.nodes[n.id] === n; };

    /* A host component's method, isolated: its throw is reported. */
    R.guard = function (n, what, f) {
        try { return f(); } catch (e) {
            var text = 'component ' + (n.comp ? n.comp.name : '?') + ' ' + what + ': ' + String(e && e.stack || e);
            if (this.report) {
                this.report(text);
            } else {
                this.M.errors.push(text.slice(0, 500));
                if (this.M.errors.length > 20) this.M.errors.shift();
            }
            return undefined;
        }
    };

    R.apply = function (ops) {
        if (this.disposed) return;
        var started = performance.now();
        var M = this.M;
        this.placed = false;
        var slow = M.slowOps, t = started;
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            var n = this.nodes[op[1]];
            if (slow) {
                var now = performance.now();
                if (i && now - t > 16 && slow.length < 20) slow.push([ops[i - 1][0], Math.round(now - t)]);
                t = now;
            }
            switch (op[0]) {
            case 'c': this.create(op[1], op[2]); break;
            case 'i': this.insert(n, this.nodes[op[2]], op[3]); break;
            case 'r': if (n) this.detach(n); break;
            case 'd': if (n) this.destroy(n); break;
            case 'f': if (n) this.frame(n, op[2], op[3], op[4], op[5]); break;
            case 's': if (n && n.css !== op[2]) { n.css = op[2]; n.restyle(); } break;
            case 'a': if (n && n.anim !== op[2]) { n.anim = op[2]; n.restyle(); } break;
            case 't': if (n) this.text(n, op[2]); break;
            case 'e': if (n) n.events = op[2]; break;
            case 'ts': if (n) n.states = op[2]; break;
            case 'vp':
                if (n) {
                    n.focusable = op[2];
                    if (op[3]) n.el.setAttribute('data-testid', op[3]); else n.el.removeAttribute('data-testid');
                }
                break;
            case 'sc': break;
            case 'ss': if (n) this.scrollSize(n, op[2], op[3]); break;
            case 'st': if (n) this.scrollTo(n, op[2], op[3]); break;
            case 'sb': if (n) this.scrollTo(n, n.sx + op[2], n.sy + op[3]); break;
            case 'im': if (n) this.image(n, op); break;
            case 'ir': this.releaseImage(op[1]); break;
            case 'in': if (n) this.inputConfig(n, op[2]); break;
            case 'iv': if (n && n.input) this.inputValue(n, op[2], op[3]); break;
            case 'ic': if (n && n.input) this.inputContent(n, op[2], op[3], op[4], op[5]); break;
            case 'fo': if (n) this.focus(n, op[2]); break;
            case 'n': if (n) this.component(n, op[2]); break;
            case 'np': if (n && n.comp) this.componentProps(n, op[2], op[3] || []); break;
            case 'nc':
                if (n && n.comp && n.comp.instance.command) {
                    var inst = n.comp.instance, name = op[2], args = op[3];
                    this.guard(n, 'command', function () { inst.command(name, args); });
                }
                break;
            case 'x': this.exit(); break;
            default:
                M.unknown[op[0]] = (M.unknown[op[0]] || 0) + 1;
            }
        }
        if (this.placed && this.componentNodes.length) this.placeComponents();
        /* Decided at the batch's end: an input's configuration (`auto`)
         * comes after its insert in the batch that mounts it. The last
         * one inserted takes the focus. */
        if (this.autoFocus.length) {
            var inserted = this.autoFocus;
            this.autoFocus = [];
            for (var k = inserted.length - 1; k >= 0; k--) {
                var a = inserted[k];
                if (a.input && a.input.config.auto && this.live(a) && this.attached(a)) { a.input.el.focus(); break; }
            }
        }
        M.batches++;
        M.ops += ops.length;
        M.applyMs += performance.now() - started;
    };

    R.create = function (id, kind) {
        if (id === ROOT_ID) return; /* the page made the root */
        var n = new Node(id, kind);
        n.restyle();
        this.nodes[id] = n;
        if (kind === 'input') this.makeInput(n, false);
        if (kind === 'scroll') {
            var self = this;
            n.el.addEventListener('scroll', function () {
                if (!self.live(n)) return;
                if (n.el.scrollLeft === n.sx && n.el.scrollTop === n.sy) return;
                n.sx = n.el.scrollLeft; n.sy = n.el.scrollTop;
                self.send({ t: 'scroll', id: id, x: n.sx, y: n.sy });
                if (self.componentNodes.length) self.placeComponents();
            });
        }
    };

    R.insert = function (parent, child, before) {
        if (!parent || !child) return;
        var b = before == null ? null : this.nodes[before];
        parent.el.insertBefore(child.el, b && b.el.parentNode === parent.el ? b.el : null);
        child.parent = parent;
        this.placed = true;
        if (child.input) this.autoFocus.push(child);
    };

    /* A detached subtree keeps no DOM focus: the TV keyboard closes. */
    R.detach = function (n) {
        if (n.el.parentNode) n.el.parentNode.removeChild(n.el);
        n.parent = null;
        if (this.editing && !this.attached(this.editing)) this.editing.input.el.blur();
        this.placed = true;
    };

    R.destroy = function (n) {
        if (n.el.parentNode) n.el.parentNode.removeChild(n.el);
        if (n.comp) {
            var inst = n.comp.instance;
            if (inst.destroy) this.guard(n, 'destroy', function () { inst.destroy(); });
            this.componentNodes.splice(this.componentNodes.indexOf(n), 1);
            n.comp = null;
        }
        if (n.input) {
            if (this.editing === n) { this.editing = null; n.input.el.blur(); }
            this.setPlaceholderRule(n.id, '');
        }
        if (n.img) { n.img.el.onload = null; n.img.el.onerror = null; }
        n.parent = null;
        delete this.nodes[n.id];
        this.placed = true;
    };

    /* A frame changes only the coordinates that moved: no cssText rewrite. */
    R.frame = function (n, x, y, w, h) {
        var s = n.el.style;
        if (n.x !== x) { n.x = x; s.left = x + 'px'; }
        if (n.y !== y) { n.y = y; s.top = y + 'px'; }
        if (n.w !== w) { n.w = w; s.width = w + 'px'; }
        if (n.h !== h) { n.h = h; s.height = h + 'px'; }
        this.placed = true;
    };

    /*
     * A text's runs: the box and each run's span and text node are kept and
     * only what differs is written (a guide's focus move changes a few
     * colors and strings, not the structure).
     */
    R.text = function (n, spec) {
        var tb = n.text;
        if (!tb) {
            var box = document.createElement('div');
            box.style.cssText = 'position:absolute;white-space:pre;left:' + spec.x + 'px;top:' + spec.y + 'px;';
            n.el.insertBefore(box, n.el.firstChild);
            tb = n.text = { box: box, spans: [], x: spec.x, y: spec.y };
        } else {
            if (tb.x !== spec.x) { tb.x = spec.x; tb.box.style.left = spec.x + 'px'; }
            if (tb.y !== spec.y) { tb.y = spec.y; tb.box.style.top = spec.y + 'px'; }
        }
        var runs = spec.runs, spans = tb.spans, styles = spec.styles;
        for (var i = 0; i < runs.length; i++) {
            var run = runs[i];
            var css = styles[run[4]] || '';
            var s = spans[i];
            if (!s) {
                var el = document.createElement('span');
                var node = document.createTextNode(run[0]);
                el.appendChild(node);
                s = spans[i] = { el: el, node: node, text: run[0], l: run[1], t: run[2], lh: run[3], css: css };
                el.style.cssText = 'position:absolute;left:' + run[1] + 'px;top:' + run[2] + 'px;line-height:' + run[3] + 'px;' + css;
                tb.box.appendChild(el);
                continue;
            }
            if (s.text !== run[0]) { s.text = run[0]; s.node.nodeValue = run[0]; }
            if (s.css !== css || s.lh !== run[3]) {
                s.css = css; s.lh = run[3]; s.l = run[1]; s.t = run[2];
                s.el.style.cssText = 'position:absolute;left:' + run[1] + 'px;top:' + run[2] + 'px;line-height:' + run[3] + 'px;' + css;
            } else {
                if (s.l !== run[1]) { s.l = run[1]; s.el.style.left = run[1] + 'px'; }
                if (s.t !== run[2]) { s.t = run[2]; s.el.style.top = run[2] + 'px'; }
            }
        }
        while (spans.length > runs.length) tb.box.removeChild(spans.pop().el);
    };

    /* ---------- scrolling ---------- */

    R.scrollSize = function (n, w, h) {
        if (!n.sizer) {
            n.sizer = document.createElement('div');
            n.sizer.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;visibility:hidden;';
            n.el.appendChild(n.sizer);
        }
        n.sizer.style.width = w + 'px';
        n.sizer.style.height = h + 'px';
    };

    R.scrollTo = function (n, x, y) {
        n.el.scrollLeft = x;
        n.el.scrollTop = y;
        /* What the browser applied (clamped to the content). */
        if (n.el.scrollLeft !== n.sx || n.el.scrollTop !== n.sy) {
            n.sx = n.el.scrollLeft; n.sy = n.el.scrollTop;
            this.send({ t: 'scroll', id: n.id, x: n.sx, y: n.sy });
        }
        this.placed = true;
    };

    /* ---------- images ---------- */

    /* An in-memory image's bytes (`image_bytes`), shown by its URI, as a
     * blob of its type (an SVG without one does not load). */
    R.imageBytes = function (uri, type, bytes) {
        if (this.blobs[uri]) return;
        this.blobs[uri] = URL.createObjectURL(type ? new Blob([bytes], { type: type }) : new Blob([bytes]));
    };

    /* No view shows in-memory image `uri` any more (op `ir`). */
    R.releaseImage = function (uri) {
        var url = this.blobs[uri];
        if (!url) return;
        delete this.blobs[uri];
        URL.revokeObjectURL(url);
    };

    R.src = function (uri) { return this.blobs[uri] || uri; };

    R.image = function (n, op) {
        var self = this;
        var src = op[2], fit = op[3], placeholder = op[4], blur = op[5], position = op[6], tint = op[7];
        var blocked = !!src && !this.blobs[src] && !imageAllowed(src);
        if (blocked) { this.M.blockedImages = (this.M.blockedImages || 0) + 1; src = null; }
        if (placeholder && !this.blobs[placeholder] && !imageAllowed(placeholder)) placeholder = null;
        if (!n.img) {
            var img = document.createElement('img');
            img.onload = function () {
                if (!self.live(n)) return;
                img.style.backgroundImage = '';
                if (n.events & LOAD) self.send({ t: 'image', id: n.id, ok: 1, w: img.naturalWidth, h: img.naturalHeight });
            };
            img.onerror = function () {
                if (!self.live(n) || !n.img.src) return;
                if (n.events & ERROR) self.send({ t: 'image', id: n.id, ok: 0, error: 'could not load the image' });
            };
            n.img = { el: img, mask: null, src: null };
            n.el.insertBefore(img, n.el.firstChild);
        }
        var im = n.img;
        if (tint) {
            /* An svg() painted in the text color: a mask of it. */
            if (!im.mask) {
                im.mask = document.createElement('div');
                n.el.insertBefore(im.mask, im.el);
            }
            var ms = im.mask.style;
            ms.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;-webkit-mask-repeat:no-repeat;';
            ms.setProperty('background-color', tint);
            ms.setProperty('-webkit-mask-image', src ? cssUrl(this.src(src)) : 'none');
            ms.setProperty('-webkit-mask-size', fit === 'cover' ? 'cover' : fit === 'fill' ? '100% 100%' : 'contain');
            ms.setProperty('-webkit-mask-position', position || 'center');
        } else if (im.mask) {
            n.el.removeChild(im.mask);
            im.mask = null;
        }
        var s = im.el.style;
        s.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
        s.setProperty('object-fit', fit);
        if (position) s.setProperty('object-position', position);
        if (blur > 0) s.setProperty('filter', 'blur(' + blur + 'px)');
        if (placeholder) s.setProperty('background', cssUrl(this.src(placeholder)) + ' center/contain no-repeat');
        /* The element still loads the source under a mask, for its events. */
        if (tint) s.setProperty('display', 'none');
        var resolved = src ? this.src(src) : null;
        if (blocked) {
            /* Not loaded: the app hears it failed. */
            im.src = null;
            im.el.removeAttribute('src');
            if (n.events & ERROR) this.send({ t: 'image', id: n.id, ok: 0, error: 'this image source is not allowed' });
            return;
        }
        if (im.src === resolved) return;
        im.src = resolved;
        if (resolved) {
            if (n.events & LOAD) this.send({ t: 'event', id: n.id, name: 'onLoadStart' });
            im.el.src = resolved;
        } else {
            im.el.removeAttribute('src');
        }
    };

    /* ---------- inputs ---------- */

    /*
     * The <input> (or <textarea>) of input `n`. Made again when `multiline`
     * changes: the text, the focus and the selection move to the new
     * element, and the swap reports no Blur or Focus.
     */
    R.makeInput = function (n, multiline) {
        var self = this;
        var old = n.input;
        var el = document.createElement(multiline ? 'textarea' : 'input');
        /* The type before the value and selection: an email or number
         * input set after them would drop them. */
        if (!multiline && old && old.config.type) el.type = old.config.type;
        el.className = 'nsh-in';
        el.id = 'nsh-in-' + n.id;
        var input = n.input = { el: el, config: old ? old.config : {}, count: old ? old.count : 0, box: old ? old.box : null, css: old ? old.css : '', swapping: false };
        el.addEventListener('input', function () {
            if (!self.live(n) || n.input !== input) return;
            input.count++;
            self.send({ t: 'text', id: n.id, name: 'onChangeText', text: el.value, count: input.count });
        });
        el.addEventListener('keydown', function (e) {
            if (!self.live(n) || n.input !== input) return;
            var submit = input.config.submit || 'blur';
            var code = e.keyCode;
            /* A repeat of a key pressed before this input took the focus
             * (an OK that focused it) is still that press's: the page's
             * handler takes it. */
            if (e.repeat && self.keys[code] && self.keys[code] !== 'swallowed') return;
            /* Enter, or the TV keyboard's Done; held, it submits once. */
            if ((code === 13 || code === IME_DONE) && !(submit === 'newline' && code === 13)) {
                e.preventDefault();
                self.consume(e);
                if (e.repeat) return;
                self.send({ t: 'text', id: n.id, name: 'onSubmitEditing', text: el.value, count: input.count });
                if (submit === 'blur') el.blur();
            } else if (code === IME_CANCEL) {
                self.consume(e);
                el.blur();
            }
        });
        el.addEventListener('focus', function () {
            if (!self.live(n) || n.input !== input || input.swapping) return;
            self.editing = n;
            self.inputFocus(n, true);
        });
        el.addEventListener('blur', function () {
            if (!self.live(n) || n.input !== input || input.swapping) return;
            if (self.editing === n) self.editing = null;
            self.inputFocus(n, false);
        });
        if (old) {
            var focused = document.activeElement === old.el;
            var start = old.el.selectionStart, end = old.el.selectionEnd;
            el.value = old.el.value;
            old.swapping = true;
            input.swapping = true;
            n.el.replaceChild(el, old.el);
            if (focused) {
                el.focus();
                try { el.setSelectionRange(start, end); } catch (e) { /* a number input has none */ }
            }
            input.swapping = false;
        } else {
            n.el.appendChild(el);
        }
        if (input.box) this.inputContent(n, input.box[0], input.box[1], input.box[2], input.box[3]);
    };

    /* An input handled key `e` itself: the page's key listener must not
     * see it, nor its release. */
    R.consume = function (e) {
        e.stopPropagation();
        /* Only a fresh press decides: a held key keeps what its press was
         * (an OK that focused this input is still the app's, release
         * included). */
        if (!e.repeat || !this.keys[e.keyCode]) this.keys[e.keyCode] = 'swallowed';
    };

    R.inputConfig = function (n, c) {
        if (!!c.ml !== (n.input.el.tagName === 'TEXTAREA')) this.makeInput(n, c.ml);
        var input = n.input, el = input.el;
        input.config = c;
        if (el.tagName === 'INPUT' && el.type !== c.type) el.type = c.type;
        el.placeholder = c.ph || '';
        if (c.max >= 0) el.maxLength = c.max; else el.removeAttribute('maxlength');
        el.readOnly = !!c.off;
        input.css = c.css;
        this.inputContent(n, input.box ? input.box[0] : 0, input.box ? input.box[1] : 0,
            input.box ? input.box[2] : n.w, input.box ? input.box[3] : n.h);
        this.setPlaceholderRule(n.id, c.phc ? '#nsh-in-' + n.id + '::placeholder{color:' + c.phc + '}' : '');
    };

    R.setPlaceholderRule = function (id, rule) {
        if ((this.placeholderRules[id] || '') === rule) return;
        if (rule) this.placeholderRules[id] = rule; else delete this.placeholderRules[id];
        var all = '';
        for (var k in this.placeholderRules) all += this.placeholderRules[k];
        if (!this.phStyle) { this.phStyle = document.createElement('style'); document.head.appendChild(this.phStyle); }
        this.phStyle.textContent = all;
    };

    R.inputContent = function (n, x, y, w, h) {
        var input = n.input;
        input.box = [x, y, w, h];
        input.el.style.cssText = 'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;' + (input.css || '');
    };

    /* The app's text, unless the user typed since the edit it is based on. */
    R.inputValue = function (n, text, count) {
        var input = n.input;
        if (count < input.count) return;
        if (input.el.value !== text) input.el.value = text;
    };

    /* ---------- focus ---------- */

    /*
     * `fo`: an input takes or leaves the DOM focus (the TV keyboard); a
     * view the app focused takes it from the input being edited, so the
     * keyboard closes when the focus moves off it. The engine reports the
     * views' own Focus and Blur.
     */
    R.focus = function (n, on) {
        if (n.input) {
            if (on && this.attached(n)) n.input.el.focus();
            else if (!on) n.input.el.blur();
            return;
        }
        if (on && this.editing && this.editing !== n) this.editing.input.el.blur();
        /* Blur on the root: whatever is focused, the input being edited
         * included. */
        if (!on && n.id === ROOT_ID && this.editing) this.editing.input.el.blur();
    };

    /* An input's Focus and Blur, and its focused state where the core
     * tracks it. */
    R.inputFocus = function (n, on) {
        if (!this.live(n)) return;
        this.send({ t: 'focus', id: n.id, on: on ? 1 : 0 });
        /* Always: the core tracks FOCUSED for every view (focus-within,
         * focus restore, culling). */
        this.send({ t: 'states', id: n.id, states: on ? FOCUSED : 0 });
    };

    R.attached = function (n) {
        for (var p = n; p; p = p.parent) if (p.id === ROOT_ID) return true;
        return false;
    };

    /* ---------- native components ---------- */

    R.component = function (n, name) {
        var self = this;
        var factory = components[name];
        if (!factory) {
            this.M.unknownComponents[name] = (this.M.unknownComponents[name] || 0) + 1;
            return;
        }
        var comp = { name: name, props: {}, rect: null, instance: {} };
        n.comp = comp;
        var ctx = {
            id: n.id,
            name: name,
            element: n.el,
            emit: function (event, data) {
                if (!self.live(n) || n.comp !== comp) return;
                var json;
                try { json = JSON.stringify(data === undefined ? null : data); } catch (e) { json = 'null'; }
                self.send({ t: 'native', id: n.id, name: String(event), data: json });
            },
            rect: function () { return self.rectOf(n); },
            scale: this.scale
        };
        comp.instance = this.guard(n, 'factory', function () { return factory(ctx); }) || {};
        this.componentNodes.push(n);
        this.placed = true;
    };

    R.componentProps = function (n, changed, removed) {
        var props = n.comp.props;
        for (var k in changed) props[k] = changed[k];
        for (var i = 0; i < removed.length; i++) delete props[removed[i]];
        var inst = n.comp.instance;
        if (inst.props) this.guard(n, 'props', function () { inst.props(changed, props, removed); });
    };

    /* A view's rect on the page: its frames summed, scroll offsets taken. */
    R.rectOf = function (n) {
        var x = 0, y = 0, attached = false;
        for (var p = n; p; p = p.parent) {
            if (p !== n) { x -= p.sx; y -= p.sy; }
            x += p.x; y += p.y;
            if (p.id === ROOT_ID) { attached = true; break; }
        }
        return { x: x, y: y, width: n.w, height: n.h, visible: attached && n.w > 0 && n.h > 0 };
    };

    R.placeComponents = function () {
        for (var i = 0; i < this.componentNodes.length; i++) {
            var n = this.componentNodes[i];
            var r = this.rectOf(n), o = n.comp.rect;
            if (o && o.x === r.x && o.y === r.y && o.width === r.width && o.height === r.height && o.visible === r.visible) continue;
            n.comp.rect = r;
            var inst = n.comp.instance;
            if (inst.frame) this.guard(n, 'frame', function () { inst.frame(r); });
        }
    };

    R.exit = function () {
        if (this.onExit) { this.onExit(); return; }
        try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* not a TV */ }
    };

    /* The app stopped: its native components go (a player closes), the
     * last frame stays on screen. */
    R.haltComponents = function () {
        var nodes = this.componentNodes.slice();
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i], inst = n.comp.instance;
            if (inst.destroy) this.guard(n, 'destroy', function () { inst.destroy(); });
            n.comp = null;
        }
        this.componentNodes = [];
        if (this.editing) this.editing.input.el.blur();
    };

    /* Ends this renderer (a new session replaces it): components are
     * destroyed, the DOM and styles removed, blobs released. */
    R.dispose = function () {
        if (this.disposed) return;
        this.haltComponents();
        this.disposed = true;
        var root = this.nodes[ROOT_ID];
        if (root && root.el.parentNode) root.el.parentNode.removeChild(root.el);
        if (this.style.parentNode) this.style.parentNode.removeChild(this.style);
        if (this.phStyle && this.phStyle.parentNode) this.phStyle.parentNode.removeChild(this.phStyle);
        for (var uri in this.blobs) URL.revokeObjectURL(this.blobs[uri]);
        this.blobs = {};
        this.nodes = {};
        this.componentNodes = [];
    };

    return {
        ROOT_ID: ROOT_ID,
        PRESS: PRESS,
        KEYS: KEYS,
        FOCUS_BITS: FOCUS_BITS,
        IME_DONE: IME_DONE,
        IME_CANCEL: IME_CANCEL,
        registerComponent: registerComponent,
        components: components,
        Renderer: Renderer,
        imageAllowed: imageAllowed,
        cssUrl: cssUrl
    };
})();
