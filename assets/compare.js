/* 局部对比：直接使用已有照片 URL，不生成缩略图或改动原图。 */
(function () {
  'use strict';
  var root, panes, images, labels, status, controls, views, linked = true, generation = 0;
  var savedY = 0, savedFocus = null, savedInert = false;
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function geometry(side) {
    var r = panes[side].getBoundingClientRect(), img = images[side];
    var w = img.naturalWidth || r.width, h = img.naturalHeight || r.height;
    var fit = Math.min(r.width / w, r.height / h);
    return { width: r.width, height: r.height, baseW: w * fit, baseH: h * fit };
  }
  function bound(view, g) {
    var mx = Math.min(.5, g.width / (2 * g.baseW * view.s));
    var my = Math.min(.5, g.height / (2 * g.baseH * view.s));
    view.cx = clamp(view.cx, mx, 1 - mx); view.cy = clamp(view.cy, my, 1 - my);
    return view;
  }
  function scaleAt(view, g, factor, ax, ay) {
    var old = view.s, next = clamp(old * factor, 1, 8);
    view.cx += ax * g.width / g.baseW * (1 / old - 1 / next);
    view.cy += ay * g.height / g.baseH * (1 / old - 1 / next);
    view.s = next; return bound(view, g);
  }
  function panBy(view, g, dx, dy) {
    view.cx -= dx / (g.baseW * view.s); view.cy -= dy / (g.baseH * view.s);
    return bound(view, g);
  }
  function render() {
    if (!root || root.hidden) return;
    views.forEach(function (v, side) {
      var g = geometry(side); if (!g.width || !g.height) return;
      bound(v, g);
      images[side].style.width = g.baseW + 'px'; images[side].style.height = g.baseH + 'px';
      images[side].style.transform = 'translate(-50%, -50%) translate(' + ((.5 - v.cx) * g.baseW * v.s) + 'px,' + ((.5 - v.cy) * g.baseH * v.s) + 'px) scale(' + v.s + ')';
      labels[side].querySelector('output').textContent = v.s.toFixed(1) + '×';
    });
    controls.link.textContent = linked ? '联动：开' : '联动：关';
    controls.link.setAttribute('aria-pressed', String(linked));
    status.textContent = linked ? '双指缩放或拖动，两张一起查看' : '分别缩放、拖动对齐同一位置，再开启联动';
  }
  function zoom(side, factor, ax, ay) {
    (linked ? [0, 1] : [side]).forEach(function (i) { scaleAt(views[i], geometry(i), factor, ax || 0, ay || 0); });
    render();
  }
  function move(side, dx, dy) {
    var g = geometry(side);
    (linked ? [0, 1] : [side]).forEach(function (i) {
      var other = geometry(i);
      panBy(views[i], other, dx * other.width / g.width, dy * other.height / g.height);
    });
    render();
  }
  function reset() { views = [{s:1,cx:.5,cy:.5},{s:1,cx:.5,cy:.5}]; render(); }
  function close() {
    if (!root || root.hidden) return;
    generation++; root.hidden = true;
    document.body.classList.remove('no-scroll'); document.body.style.top = '';
    var app = document.querySelector('#app'); if (app) app.inert = savedInert;
    window.scrollTo(0, savedY);
    images.forEach(function (img) { img.removeAttribute('src'); });
    if (savedFocus && savedFocus.isConnected) savedFocus.focus();
  }
  function bindPane(side) {
    var pane = panes[side], points = new Map(), last = null;
    function snapshot() {
      var ps = Array.from(points.values());
      if (!ps.length) return null;
      if (ps.length === 1) return { x:ps[0].x,y:ps[0].y,d:0 };
      return {x:(ps[0].x+ps[1].x)/2,y:(ps[0].y+ps[1].y)/2,d:Math.hypot(ps[0].x-ps[1].x,ps[0].y-ps[1].y)};
    }
    pane.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      points.set(ev.pointerId,{x:ev.clientX,y:ev.clientY}); last = snapshot();
      pane.setPointerCapture(ev.pointerId); pane.focus({preventScroll:true});
    });
    pane.addEventListener('pointermove', function (ev) {
      if (!points.has(ev.pointerId)) return;
      ev.preventDefault(); points.set(ev.pointerId,{x:ev.clientX,y:ev.clientY}); var next = snapshot();
      if (last && next) {
        if (last.d && next.d) {
          var r = pane.getBoundingClientRect();
          zoom(side,next.d/last.d,(last.x-r.left)/r.width-.5,(last.y-r.top)/r.height-.5);
        }
        move(side,next.x-last.x,next.y-last.y);
      }
      last = next;
    });
    function end(ev) { points.delete(ev.pointerId); last = snapshot(); }
    pane.addEventListener('pointerup',end); pane.addEventListener('pointercancel',end); pane.addEventListener('lostpointercapture',end);
    pane.addEventListener('dblclick', function (ev) {
      var r = pane.getBoundingClientRect();
      zoom(side,views[side].s > 1 ? 1/views[side].s : 3,(ev.clientX-r.left)/r.width-.5,(ev.clientY-r.top)/r.height-.5);
    });
    pane.addEventListener('wheel', function (ev) {
      ev.preventDefault(); var r = pane.getBoundingClientRect();
      zoom(side,Math.exp(-ev.deltaY*.002),(ev.clientX-r.left)/r.width-.5,(ev.clientY-r.top)/r.height-.5);
    },{passive:false});
    pane.addEventListener('keydown', function (ev) {
      var dirs={ArrowLeft:[30,0],ArrowRight:[-30,0],ArrowUp:[0,30],ArrowDown:[0,-30]};
      if (dirs[ev.key]) {ev.preventDefault();move(side,dirs[ev.key][0],dirs[ev.key][1]);}
      if (ev.key==='+' || ev.key==='=' || ev.key==='-') {ev.preventDefault();zoom(side,ev.key==='-'?1/1.5:1.5);}
    });
    pane.addEventListener('blur', function () { points.clear(); last=null; });
  }
  function create() {
    root = document.createElement('section'); root.id='compareZoom'; root.hidden=true;
    root.setAttribute('role','dialog'); root.setAttribute('aria-modal','true'); root.setAttribute('aria-labelledby','cmpzTitle');
    root.innerHTML='<div class="cmpz-header"><h2 id="cmpzTitle">局部对比</h2><button type="button" data-close aria-label="关闭局部对比">关闭</button></div>' +
      '<div class="cmpz-controls"><button type="button" data-link>联动：开</button><button type="button" data-minus aria-label="缩小两张照片">−</button><button type="button" data-plus aria-label="放大两张照片">＋</button><button type="button" data-reset>还原</button></div>' +
      '<p class="cmpz-help"></p><div class="cmpz-grid">'+[0,1].map(function(i){return '<div class="cmpz-side"><div class="cmpz-label"><span></span><output></output></div><div class="cmpz-pane" tabindex="0" role="group" aria-label="'+(i?'较晚':'较早')+'照片，可缩放拖动"><img class="cmpz-image" alt="" draggable="false"><span class="cmpz-loading">加载照片…</span></div></div>';}).join('')+'</div>';
    document.body.appendChild(root);
    panes=Array.from(root.querySelectorAll('.cmpz-pane'));images=Array.from(root.querySelectorAll('img'));labels=Array.from(root.querySelectorAll('.cmpz-label'));status=root.querySelector('.cmpz-help');
    controls={link:root.querySelector('[data-link]'),minus:root.querySelector('[data-minus]'),plus:root.querySelector('[data-plus]'),reset:root.querySelector('[data-reset]')};
    root.querySelector('[data-close]').onclick=close;
    controls.link.onclick=function(){linked=!linked;render();};
    // 共同按钮始终缩放两图，关闭联动后通过单图手势分别调整。
    function both(factor) {views.forEach(function(v,i){scaleAt(v,geometry(i),factor,0,0);});render();}
    controls.minus.onclick=function(){both(1/1.5);};controls.plus.onclick=function(){both(1.5);};controls.reset.onclick=reset;
    panes.forEach(function(p,i){bindPane(i);images[i].onload=function(){p.querySelector('.cmpz-loading').hidden=true;render();};images[i].onerror=function(){p.querySelector('.cmpz-loading').textContent='照片加载失败，请关闭后重试';};});
    root.addEventListener('keydown',function(ev){
      if(ev.key==='Escape'){ev.preventDefault();close();}
      if(ev.key==='Tab'){
        var all=Array.from(root.querySelectorAll('button,[tabindex="0"]')),first=all[0],last=all[all.length-1];
        if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus();}
        else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus();}
      }
    });
    window.addEventListener('resize',render);
  }
  function open(items) {
    if (!items || items.length!==2) return;
    if (!root) create();
    if (!root.hidden) close();
    savedY=window.scrollY;savedFocus=document.activeElement;
    var app=document.querySelector('#app');savedInert=app?app.inert:false;if(app)app.inert=true;
    linked=true;views=[{s:2,cx:.5,cy:.5},{s:2,cx:.5,cy:.5}];var current=++generation;
    root.hidden=false;document.body.classList.add('no-scroll');document.body.style.top=-savedY+'px';
    items.forEach(function(item,i){
      labels[i].querySelector('span').textContent=item.label || '';images[i].removeAttribute('src');
      var hint=panes[i].querySelector('.cmpz-loading');hint.hidden=false;hint.textContent='加载照片…';
      Promise.resolve(item.url).then(function(url){if(current===generation&&!root.hidden)images[i].src=url;},function(err){if(current===generation&&!root.hidden)hint.textContent='加载失败：'+(err.message||err);});
    });
    render();root.querySelector('[data-close]').focus();
  }
  window.PrettierCompare={open:open,close:close};
})();
