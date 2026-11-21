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

    /* ---------- native components ---------- */

    /*
     * The page's implementations of NSH native components, by the name an
     * app mounts them with (`native("name")`). A factory gets a context and
     * returns an instance:
     *
     *   NshTizen.registerComponent('tv.player', function (ctx) {
     *       // ctx.id, ctx.name, ctx.element (the container <div>),
     *       // ctx.emit(name, data): an event to the app (onNativeEvent),
     *       // ctx.rect(): the container's rect on the page.
     *       return {
     *           props: function (changed, all) {},  // after every change
     *           frame: function (rect) {},          // {x, y, width, height, visible}
     *           command: function (name, args) {},  // ElementRef::command
     *           destroy: function () {}
     *       };
     *   });
     *
     * Every method is optional. Props arrive before the first frame.
     */
    var components = {};
    function registerComponent(name, factory) { components[name] = factory; }

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

    function Renderer(container, send, M) {
        this.send = send;
        this.M = M;
        this.nodes = {};
        this.keyListeners = [];
        this.focused = null;      /* a focusable view the app focused */
        this.editing = null;      /* the input with the DOM focus */
        this.componentNodes = [];
        this.placed = false;      /* a frame or the tree changed in this batch */
        this.blobs = {};          /* in-memory image URI -> blob URL */
        this.autoFocus = null;
        this.style = document.createElement('style');
        this.style.textContent =
            '@keyframes nsh-spin{to{transform:rotate(360deg)}}' +
            '@keyframes nsh-ping{75%,100%{transform:scale(2);opacity:0}}' +
            '@keyframes nsh-pulse{50%{opacity:.5}}' +
            '@keyframes nsh-bounce{0%,100%{transform:translateY(-25%);animation-timing-function:cubic-bezier(.8,0,1,1)}50%{transform:none;animation-timing-function:cubic-bezier(0,0,.2,1)}}' +
            '.nsh-in{position:absolute;border:0;margin:0;padding:0;background:transparent;outline:none;box-sizing:border-box;resize:none}';
        document.head.appendChild(this.style);
        this.placeholderRules = {};
        var root = new Node(ROOT_ID, 'view');
        root.w = container.clientWidth || 1920;
        root.h = container.clientHeight || 1080;
        root.restyle();
        this.nodes[ROOT_ID] = root;
        container.appendChild(root.el);
    }

    var R = Renderer.prototype;

    R.apply = function (ops) {
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
            case 'r':
                if (n && n.el.parentNode) n.el.parentNode.removeChild(n.el);
                if (n) n.parent = null;
                this.placed = true;
                break;
            case 'd': if (n) this.destroy(n); break;
            case 'f': if (n) this.frame(n, op[2], op[3], op[4], op[5]); break;
            case 's': if (n && n.css !== op[2]) { n.css = op[2]; n.restyle(); } break;
            case 'a': if (n && n.anim !== op[2]) { n.anim = op[2]; n.restyle(); } break;
            case 't': if (n) this.text(n, op[2]); break;
            case 'e': if (n) this.setEvents(n, op[2]); break;
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
            case 'in': if (n) this.inputConfig(n, op[2]); break;
            case 'iv': if (n && n.input) this.inputValue(n, op[2], op[3]); break;
            case 'ic': if (n && n.input) this.inputContent(n, op[2], op[3], op[4], op[5]); break;
            case 'fo': if (n) this.focus(n, op[2]); break;
            case 'n': if (n) this.component(n, op[2]); break;
            case 'np': if (n && n.comp) this.componentProps(n, op[2]); break;
            case 'nc':
                if (n && n.comp && n.comp.instance.command) n.comp.instance.command(op[2], op[3]);
                break;
            case 'x': this.exit(); break;
            default:
                M.unknown[op[0]] = (M.unknown[op[0]] || 0) + 1;
            }
        }
        if (this.placed && this.componentNodes.length) this.placeComponents();
        if (this.autoFocus) {
            var a = this.autoFocus;
            this.autoFocus = null;
            if (a.input && a.el.parentNode) a.input.el.focus();
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
        if (child.input && child.input.config.auto) this.autoFocus = child;
    };

    R.destroy = function (n) {
        if (n.el.parentNode) n.el.parentNode.removeChild(n.el);
        if (n.comp) {
            if (n.comp.instance.destroy) n.comp.instance.destroy();
            this.componentNodes.splice(this.componentNodes.indexOf(n), 1);
            n.comp = null;
        }
        if (this.editing === n) this.editing = null;
        if (this.focused === n) this.focused = null;
        var k = this.keyListeners.indexOf(n);
        if (k >= 0) this.keyListeners.splice(k, 1);
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

    R.setEvents = function (n, bits) {
        n.events = bits;
        var k = this.keyListeners.indexOf(n);
        if (bits & KEYS) {
            if (k < 0) this.keyListeners.push(n);
        } else if (k >= 0) {
            this.keyListeners.splice(k, 1);
        }
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

    /* An in-memory image's bytes (`image_bytes`), shown by its URI. */
    R.imageBytes = function (uri, bytes) {
        if (this.blobs[uri]) return;
        this.blobs[uri] = URL.createObjectURL(new Blob([bytes]));
    };

    R.src = function (uri) { return this.blobs[uri] || uri; };

    R.image = function (n, op) {
        var self = this;
        var src = op[2], fit = op[3], placeholder = op[4], blur = op[5], position = op[6], tint = op[7];
        if (!n.img) {
            var img = document.createElement('img');
            img.onload = function () {
                img.style.backgroundImage = '';
                if (n.events & LOAD) self.send({ t: 'image', id: n.id, ok: 1, w: img.naturalWidth, h: img.naturalHeight });
            };
            img.onerror = function () {
                if (n.events & ERROR) self.send({ t: 'image', id: n.id, ok: 0, error: 'could not load ' + img.src });
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
                im.el.style.display = 'none';
            }
            var url = src ? 'url("' + this.src(src) + '")' : 'none';
            var size = fit === 'cover' ? 'cover' : fit === 'fill' ? '100% 100%' : 'contain';
            im.mask.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;background-color:' + tint +
                ';-webkit-mask-image:' + url + ';-webkit-mask-size:' + size + ';-webkit-mask-repeat:no-repeat;-webkit-mask-position:' +
                (position || 'center') + ';';
        } else if (im.mask) {
            n.el.removeChild(im.mask);
            im.mask = null;
            im.el.style.display = '';
        }
        im.el.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:' + fit + ';' +
            (position ? 'object-position:' + position + ';' : '') + (blur > 0 ? 'filter:blur(' + blur + 'px);' : '') +
            (placeholder ? 'background:url("' + this.src(placeholder) + '") center/contain no-repeat;' : '') +
            (tint ? 'display:none;' : '');
        /* The element still loads the source under a mask, for its events. */
        var resolved = src ? this.src(src) : null;
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

    R.makeInput = function (n, multiline) {
        var self = this;
        var old = n.input;
        var el = document.createElement(multiline ? 'textarea' : 'input');
        el.className = 'nsh-in';
        el.id = 'nsh-in-' + n.id;
        var input = n.input = { el: el, config: old ? old.config : {}, count: old ? old.count : 0, box: old ? old.box : null };
        if (old) {
            el.value = old.el.value;
            n.el.replaceChild(el, old.el);
        } else {
            n.el.appendChild(el);
        }
        el.addEventListener('input', function () {
            input.count++;
            self.send({ t: 'text', id: n.id, name: 'onChangeText', text: el.value, count: input.count });
        });
        el.addEventListener('keydown', function (e) {
            var submit = input.config.submit || 'blur';
            /* Enter, or the TV keyboard's Done (65376). */
            if ((e.keyCode === 13 || e.keyCode === 65376) && !(submit === 'newline' && e.keyCode === 13)) {
                e.preventDefault();
                self.send({ t: 'text', id: n.id, name: 'onSubmitEditing', text: el.value, count: input.count });
                if (submit === 'blur') el.blur();
            } else if (e.keyCode === 65385) {
                /* The keyboard's Cancel. */
                el.blur();
            }
        });
        el.addEventListener('focus', function () {
            self.editing = n;
            self.focusChanged(n, true);
        });
        el.addEventListener('blur', function () {
            if (self.editing === n) self.editing = null;
            self.focusChanged(n, false);
        });
        if (input.box) this.inputContent(n, input.box[0], input.box[1], input.box[2], input.box[3]);
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
        var rule = c.phc ? '#nsh-in-' + n.id + '::placeholder{color:' + c.phc + '}' : '';
        if (this.placeholderRules[n.id] !== rule) {
            this.placeholderRules[n.id] = rule;
            var all = '';
            for (var k in this.placeholderRules) all += this.placeholderRules[k];
            if (!this.phStyle) { this.phStyle = document.createElement('style'); document.head.appendChild(this.phStyle); }
            this.phStyle.textContent = all;
        }
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

    R.focus = function (n, on) {
        if (n.input) {
            if (on) n.input.el.focus(); else n.input.el.blur();
            return;
        }
        if (on) {
            if (this.focused === n) return;
            var old = this.focused;
            this.focused = n;
            if (old) this.focusChanged(old, false);
            if (this.editing) this.editing.input.el.blur();
            this.focusChanged(n, true);
        } else if (this.focused === n) {
            this.focused = null;
            this.focusChanged(n, false);
        }
    };

    /* Focus and Blur, and the focused state where the core tracks it. */
    R.focusChanged = function (n, on) {
        if (!this.nodes[n.id]) return;
        this.send({ t: 'focus', id: n.id, on: on ? 1 : 0 });
        if (n.states & FOCUSED) this.send({ t: 'states', id: n.id, states: on ? FOCUSED : 0 });
    };

    /*
     * Where a remote key goes: the input being edited, else the view the
     * app focused, else the newest view listening for keys (an app's root
     * view listens before any focus exists), else the root.
     */
    R.keyTarget = function () {
        if (this.editing) return this.editing;
        if (this.focused && this.nodes[this.focused.id]) return this.focused;
        for (var i = this.keyListeners.length - 1; i >= 0; i--) {
            if (this.attached(this.keyListeners[i])) return this.keyListeners[i];
        }
        return this.nodes[ROOT_ID];
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
        var comp = { name: name, props: {}, rect: null, instance: null };
        var ctx = {
            id: n.id,
            name: name,
            element: n.el,
            emit: function (event, data) {
                if (!self.nodes[n.id]) return;
                self.send({ t: 'native', id: n.id, name: event, data: JSON.stringify(data === undefined ? null : data) });
            },
            rect: function () { return self.rectOf(n); }
        };
        comp.instance = factory(ctx) || {};
        n.comp = comp;
        this.componentNodes.push(n);
        this.placed = true;
    };

    R.componentProps = function (n, changed) {
        var props = n.comp.props;
        for (var k in changed) {
            if (changed[k] === null) delete props[k]; else props[k] = changed[k];
        }
        if (n.comp.instance.props) n.comp.instance.props(changed, props);
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
            if (n.comp.instance.frame) n.comp.instance.frame(r);
        }
    };

    R.exit = function () {
        if (this.onExit) { this.onExit(); return; }
        try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* not a TV */ }
    };

    return {
        ROOT_ID: ROOT_ID,
        PRESS: PRESS,
        FOCUS_BITS: FOCUS_BITS,
        registerComponent: registerComponent,
        components: components,
        Renderer: Renderer
    };
})();
