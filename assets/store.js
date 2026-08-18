/* ============================================================
   GitHub 仓库当数据库 —— 通用模块
   ------------------------------------------------------------
   为什么不是 Cloudflare：workers.dev / pages.dev 在国内网络下 DNS 被污染
   （实测 pages.dev 解析到 127.0.0.1，workers.dev 直连超时），
   手机不挂代理打不开。而 api.github.com 实测直连 0.44s、
   带凭据读私有仓库 1.3s，是可用的。

   数据放私有仓库，多端共享：任何设备填一次令牌就看到同一份数据。
   副作用是每次改动都是一次 commit，所以天然有完整的版本历史。

   ⚠️ 用 Git Data API（blobs + tree + commit），不用 Contents API：
      Contents API 一次只能写一个文件，一条记录带 3 张照片就是 4 次提交、
      4 次往返，中间断网会留下半截状态。Git Data API 可以把多个文件
      打包成一次提交，要么全成要么全不成。

   与具体业务无关，换个 paths 配置就能给别的项目用。
   ============================================================ */

(function () {
  'use strict';

  var API = 'https://api.github.com';

  var cfg = {
    owner: '', repo: '', branch: 'main', token: '',
  };

  /* ---------- 基础请求 ---------- */

  /* 手机网络会抖，一次失败不代表真失败。
     只重试网络层错误和 5xx —— 401/403/404 重试多少次都一样。 */
  function req(pathname, opts, tries) {
    tries = tries == null ? 2 : tries;
    return req1(pathname, opts).catch(function (err) {
      if (tries <= 0 || err.noRetry) throw err;
      return new Promise(function (r) { setTimeout(r, 900); })
        .then(function () { return req(pathname, opts, tries - 1); });
    });
  }

  function req1(pathname, opts) {
    opts = opts || {};
    var headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
    if (opts.body) headers['Content-Type'] = 'application/json';

    return fetch(API + pathname, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      /* GitHub 的报文一定要带出来。
         早先这里把 403 一律翻译成「令牌权限不足」—— 是我猜的，不是 GitHub 说的。
         结果真出问题时（过期？限流？权限被改？）屏幕上只有一句猜测，
         照着它去查权限根本查不出来。宁可把原文摆出来。 */
      if (res.status === 401 || res.status === 403) {
        return res.text().then(function (t) {
          var raw = '';
          try { raw = (JSON.parse(t) || {}).message || ''; } catch (e2) { raw = (t || '').slice(0, 160); }

          var exp = res.headers.get('github-authentication-token-expiration') || '';
          var hint;
          if (res.status === 401) {
            hint = '令牌无效或已过期';
          } else if (/secondary rate limit|abuse detection/i.test(raw)) {
            var ra = res.headers.get('retry-after');
            hint = '短时间写得太多，GitHub 临时限流' + (ra ? '，' + ra + ' 秒后再试' : '，等几分钟再试');
          } else if (/rate limit/i.test(raw)) {
            hint = 'GitHub 限流了，等几分钟再试';
          } else if (/not accessible|not granted|permission/i.test(raw)) {
            hint = '令牌对这个仓库没有写权限（要 Contents: Read and write）';
          } else {
            hint = 'GitHub 拒绝了这次请求';
          }

          var e = new Error(hint + (raw ? '\nGitHub 原话：' + raw : '') +
                            (exp ? '\n令牌有效期至 ' + exp : ''));
          e.status = res.status;
          e.ghMessage = raw;
          e.tokenExpiry = exp;
          e.noRetry = true;
          throw e;
        });
      }
      if (res.status === 404) {
        var e404 = new Error('找不到：' + pathname);
        e404.notFound = true;
        e404.noRetry = true;
        throw e404;
      }
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('GitHub ' + res.status + '：' + t.slice(0, 200));
        });
      }
      return res.status === 204 ? null : res.json();
    });
  }

  function repoPath(p) {
    return '/repos/' + cfg.owner + '/' + cfg.repo + p;
  }

  /* ---------- base64 ⇄ 二进制 ----------
     btoa 只吃 latin-1，中文直接抛错；反过来解码也要按字节还原。 */

  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64ToUtf8(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function blobToB64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1]); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  function b64ToBlob(b64, mime) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime || 'image/jpeg' });
  }


  /* ================= 本地兜底 =================
     没有令牌、或令牌被 GitHub 拒了的时候，写入不能就这么失败掉 ——
     照片和记录是当场产生的，丢了补不回来。
     这一层把写入落到 IndexedDB（刷新、关机、重开都还在），
     等令牌恢复了再一次性补传上去。

     对上层完全透明：app.js 照常调 commit / updateJSON，
     区别只是提交去了本地而不是 GitHub。 */

  var K_SNAP = '__snapshot';   // { json: {path: 值}, tree: {path: sha} }
  var K_OUT  = '__outbox';     // { photos: [path], deletes: [path], dirty: [path] }

  var L = { on: false, ready: false, json: {}, tree: {}, photos: [], deletes: [], dirty: [], fresh: [] };

  function localLoad() {
    if (L.ready) return Promise.resolve(L);
    return Promise.all([cacheGet(K_SNAP), cacheGet(K_OUT)]).then(function (r) {
      var snap = r[0] || {}, out = r[1] || {};
      L.json = snap.json || {};
      L.tree = snap.tree || {};
      L.photos = out.photos || [];
      L.deletes = out.deletes || [];
      L.dirty = out.dirty || [];
      L.fresh = out.fresh || [];
      L.ready = true;
      return L;
    });
  }

  function localSave() {
    return Promise.all([
      cachePut(K_SNAP, { json: L.json, tree: L.tree }),
      cachePut(K_OUT, { photos: L.photos, deletes: L.deletes, dirty: L.dirty, fresh: L.fresh }),
    ]);
  }

  function uniqPush(arr, v) { if (arr.indexOf(v) < 0) arr.push(v); }

  /* 进入本地模式。seed 是上次同步下来的内容，用它打底，
     这样离线时看到的仍然是完整的历史，而不是一片空白。 */
  function goLocal(seed) {
    L.on = true;
    return localLoad().then(function () {
      if (seed && !Object.keys(L.json).length) {
        var d = seed.data || {};
        var entries = d.entries || [];
        var settings = Object.assign({}, d);
        delete settings.entries;
        L.json['settings.json'] = settings;
        L.json['entries.json'] = entries;
        L.tree = Object.assign({}, seed.tree || {});
      }
      return localSave();
    });
  }

  /* 补传期间必须真的走网络。
     否则 drain 里调的 commit 会被 isLocal() 拦下、又写回本地，
     然后清空待传清单 —— 报告「已上传」，其实一个字节都没出去。 */
  var forceRemote = false;

  function isLocal() { return !forceRemote && (L.on || !cfg.token); }

  // 401 / 403 —— 令牌这条路走不通了，别让数据跟着一起丢
  function tokenBlocked(err) {
    return err && (err.status === 401 || err.status === 403);
  }

  function localCommit(files, message) {
    return localLoad().then(function () {
      return files.reduce(function (chain, f) {
        return chain.then(function () {
          uniqPush(L.fresh, f.path);     // 本地新建的，云端还没有
          if (f.blob) {
            var key = 'local:' + f.path;
            L.tree[f.path] = key;          // photoURL 靠 tree 找 sha，本地也给一个
            uniqPush(L.photos, f.path);
            return cachePut(key, f.blob);
          }
          try { L.json[f.path] = JSON.parse(f.text); } catch (e) { L.json[f.path] = f.text; }
          uniqPush(L.dirty, f.path);
        });
      }, Promise.resolve());
    }).then(localSave).then(function () { return 'local'; });
  }

  function localDelete(paths) {
    return localLoad().then(function () {
      paths.forEach(function (p) {
        // 本地这一轮才建出来的，云端从来没有过，不用记删除
        var localOnly = L.photos.indexOf(p) >= 0 || L.fresh.indexOf(p) >= 0;
        L.photos = L.photos.filter(function (x) { return x !== p; });
        L.fresh = L.fresh.filter(function (x) { return x !== p; });
        L.dirty = L.dirty.filter(function (x) { return x !== p; });
        delete L.tree[p];
        delete L.json[p];
        if (!localOnly) uniqPush(L.deletes, p);
      });
      return localSave();
    });
  }

  function pending() {
    return { photos: L.photos.length, files: L.dirty.length, deletes: L.deletes.length,
             total: L.photos.length + L.dirty.length + L.deletes.length, local: isLocal() };
  }

  function mergeById(remote, local) {
    var out = (remote || []).slice();
    (local || []).forEach(function (x) {
      var at = out.findIndex(function (y) { return y && x && y.id === x.id; });
      if (at >= 0) out[at] = x; else out.push(x);
    });
    return out;
  }

  /* 补传：把本地攒下的一次性推上去。
     JSON 不直接覆盖 —— 先读云端再按 id 合并，
     免得把这期间别的设备写进去的记录抹掉。 */
  function drain(onStep) {
    var step = function (t) { if (onStep) onStep(t); };
    if (!cfg.token) return Promise.reject(new Error('还没有令牌'));

    return localLoad().then(function () {
      if (!L.photos.length && !L.dirty.length && !L.deletes.length) return { skipped: true };

      forceRemote = true;
      step('读取云端');
      return Promise.all([readJSON('entries.json'), readJSON('settings.json')])
        .then(function (r) {
          var remoteEntries = r[0] || [], remoteSettings = r[1] || {};
          var files = [];

          step('准备照片');
          return L.photos.reduce(function (chain, p) {
            return chain.then(function () {
              return cacheGet('local:' + p).then(function (b) {
                if (b) files.push({ path: p, blob: b });
              });
            });
          }, Promise.resolve()).then(function () {
            if (L.dirty.indexOf('entries.json') >= 0) {
              files.push({ path: 'entries.json',
                text: JSON.stringify(mergeById(remoteEntries, L.json['entries.json']), null, 2) });
            }
            if (L.dirty.indexOf('settings.json') >= 0) {
              var localS = L.json['settings.json'] || {};
              var merged = Object.assign({}, remoteSettings, localS);
              merged.products = mergeById(remoteSettings.products, localS.products);
              files.push({ path: 'settings.json', text: JSON.stringify(merged, null, 2) });
            }
            if (!files.length) return null;
            step('上传');
            return commit(files, '补传离线期间的 ' + files.length + ' 个文件', function (t) { step(t); });
          });
        })
        .then(function () {
          if (!L.deletes.length) return null;
          /* 只删云端真有的。
             删一个不存在的路径，GitHub 会用 422 GitRPC::BadObjectState 顶回来，
             整个补传就卡在这儿了 —— 而这类"幽灵删除"来源很多：
             本地建了又删的临时文件、别的设备已经删过的照片。 */
          step('核对云端');
          return head().then(tree).then(function (t) {
            var real = {};
            (t.tree || []).forEach(function (n) { real[n.path] = 1; });
            var todo = L.deletes.filter(function (p) { return real[p]; });
            if (!todo.length) return null;
            step('清理已删除的');
            return commitDelete(todo, '补传：删除 ' + todo.length + ' 个文件');
          });
        })
        .then(function () {
          var done = { photos: L.photos.length, files: L.dirty.length, deletes: L.deletes.length };
          L.photos = []; L.dirty = []; L.deletes = []; L.fresh = [];
          // 快照也清掉：下次再离线时重新拿刚同步下来的内容打底，而不是这份旧的
          L.json = {}; L.tree = {};
          L.on = false;
          forceRemote = false;
          return localSave().then(function () { return done; });
        })
        .catch(function (err) {
          // 失败就保持原样 —— 待传清单一项不少，下次还能重来
          forceRemote = false;
          // 令牌还是不行：退回本地，接着记，别让人卡在报错页上
          if (tokenBlocked(err)) L.on = true;
          throw err;
        });
    });
  }

  /* ---------- 读 ---------- */

  function head() {
    if (isLocal()) return localLoad().then(function () { return 'local'; });
    return req(repoPath('/git/ref/heads/' + cfg.branch)).then(function (r) {
      return r.object.sha;
    });
  }

  // 一次拿到整棵树，省得为每个文件单独查 sha
  function tree(sha) {
    if (sha === 'local') {
      return localLoad().then(function () {
        return { tree: Object.keys(L.tree).map(function (p) {
          return { path: p, type: 'blob', sha: L.tree[p] };
        }) };
      });
    }
    return req(repoPath('/git/trees/' + sha + '?recursive=1'));
  }

  function readJSON(path) {
    if (isLocal()) {
      return localLoad().then(function () {
        return L.json[path] === undefined ? null : L.json[path];
      });
    }
    return req(repoPath('/contents/' + encodeURI(path) + '?ref=' + cfg.branch))
      .then(function (r) { return JSON.parse(b64ToUtf8(r.content)); })
      .catch(function (err) {
        if (err.notFound) return null;
        throw err;
      });
  }

  /* 照片用 blobs 接口取。
     Contents API 对超过 1MB 的文件不返回内容，blobs 接口能到 100MB。 */
  function readBlobBySha(sha) {
    return req(repoPath('/git/blobs/' + sha)).then(function (r) {
      return b64ToBlob(r.content, 'image/jpeg');
    });
  }

  /* ---------- 写 ----------
     files: [{path, text}] 或 [{path, blob}]
     一次提交里可以带任意多个文件。 */

  /* 422 "Update is not a fast forward" = 从读 head 到更新分支这段时间里，
     分支被别的提交推进了（比如后台上传队列刚写完一条）。
     这时候整个提交要基于新的 head 重做一遍，不能只重试最后那一步。 */
  function commit(files, message, onStep, tries) {
    tries = tries == null ? 3 : tries;
    if (isLocal()) return localCommit(files, message);
    return commitOnce(files, message, onStep).catch(function (err) {
      // 令牌不灵了就地转存本地，绝不把刚拍的照片丢掉
      // 补传途中令牌又不行了：如实失败，待传清单原样留着，绝不能算成功
      if (tokenBlocked(err) && !forceRemote) { L.on = true; return localCommit(files, message); }
      if (tries <= 0 || !/not a fast forward/i.test(err.message || '')) throw err;
      return new Promise(function (r) { setTimeout(r, 600); })
        .then(function () { return commit(files, message, onStep, tries - 1); });
    });
  }

  function commitOnce(files, message, onStep) {
    var baseSha;
    var lastStep = '';
    var step = function (t) { lastStep = t; if (onStep) onStep(t); };
    step('读取分支');
    return head().then(function (sha) {
      baseSha = sha;
      /* 一张一张传，不用 Promise.all。
         手机上行带宽有限，6 张照片同时发 6 个几百 KB 的请求很容易一起超时，
         而且失败时分不清是哪张出的问题。串行慢一点，但稳得多、能报进度。 */
      var items = [];
      return files.reduce(function (chain, f, i) {
        return chain.then(function () {
          step('上传 ' + (i + 1) + '/' + files.length);
          var enc = f.blob
            ? blobToB64(f.blob).then(function (c) { return { content: c, encoding: 'base64' }; })
            : Promise.resolve({ content: f.text, encoding: 'utf-8' });
          return enc.then(function (body) {
            return req(repoPath('/git/blobs'), { method: 'POST', body: body });
          }).then(function (r) {
            items.push({ path: f.path, mode: '100644', type: 'blob', sha: r.sha });
          });
        });
      }, Promise.resolve()).then(function () { return items; });
    }).then(function (treeItems) {
      step('组织目录');
      return req(repoPath('/git/trees'), {
        method: 'POST',
        body: { base_tree: baseSha, tree: treeItems },
      });
    }).then(function (newTree) {
      step('生成提交');
      return req(repoPath('/git/commits'), {
        method: 'POST',
        body: { message: message, tree: newTree.sha, parents: [baseSha] },
      });
    }).then(function (newCommit) {
      step('更新分支');
      return req(repoPath('/git/refs/heads/' + cfg.branch), {
        method: 'PATCH',
        body: { sha: newCommit.sha },
      }, 0).then(function () { return newCommit.sha; });
    }).catch(function (err) {
      // 把「在哪一步失败」带出去，光看 HTTP 码没法判断
      err.step = lastStep;
      throw err;
    });
  }

  /* ---------- 删除 ----------
     Git 里删文件 = 提交一棵不含它的树。用 sha:null 标记删除。 */

  function commitDelete(paths, message, tries) {
    tries = tries == null ? 3 : tries;
    if (isLocal()) return localDelete(paths);
    return commitDeleteOnce(paths, message).catch(function (err) {
      if (tokenBlocked(err) && !forceRemote) { L.on = true; return localDelete(paths); }
      if (tries <= 0 || !/not a fast forward/i.test(err.message || '')) throw err;
      return new Promise(function (r) { setTimeout(r, 600); })
        .then(function () { return commitDelete(paths, message, tries - 1); });
    });
  }

  function commitDeleteOnce(paths, message) {
    var baseSha;
    return head().then(function (sha) {
      baseSha = sha;
      return req(repoPath('/git/trees'), {
        method: 'POST',
        body: {
          base_tree: baseSha,
          tree: paths.map(function (p) {
            return { path: p, mode: '100644', type: 'blob', sha: null };
          }),
        },
      });
    }).then(function (newTree) {
      return req(repoPath('/git/commits'), {
        method: 'POST',
        body: { message: message, tree: newTree.sha, parents: [baseSha] },
      });
    }).then(function (newCommit) {
      return req(repoPath('/git/refs/heads/' + cfg.branch), {
        method: 'PATCH', body: { sha: newCommit.sha },
      });
    });
  }

  /* ---------- 照片缓存 ----------
     照片不会变（新照片是新路径），所以按 sha 缓存进 IndexedDB，
     第二次打开就不用再走网络。这是缓存，不是数据源。 */

  var DB = 'prettier-cache', STORE = 'blobs', dbp = null;

  function db() {
    if (dbp) return dbp;
    if (!('indexedDB' in window)) return Promise.reject(new Error('无 IndexedDB'));
    dbp = new Promise(function (resolve, reject) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
    return dbp;
  }

  function cacheGet(key) {
    return db().then(function (d) {
      return new Promise(function (resolve) {
        var r = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function cachePut(key, blob) {
    return db().then(function (d) {
      return new Promise(function (resolve) {
        var t = d.transaction(STORE, 'readwrite');
        t.objectStore(STORE).put(blob, key);
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  }

  function cacheClear() {
    return db().then(function (d) {
      return new Promise(function (resolve) {
        var t = d.transaction(STORE, 'readwrite');
        t.objectStore(STORE).clear();
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  }

  /* 自检：分别验证「能读」和「能写」，直接指出问题出在哪 */
  function selftest() {
    var out = { read: null, write: null };
    /* 全程强制走网络。
       早先没加这一句：本地模式下 head/commit/commitDelete 全被本地接管，
       探针文件写进了本地又删掉，selftest 报告「能读能写」——
       可它根本没碰过 GitHub。而且还留下一条「去云端删 .probe」的待办，
       补传时删一个云端不存在的文件，撞 422 GitRPC::BadObjectState。 */
    forceRemote = true;
    var finish = function (r) { forceRemote = false; return r; };
    // 先问配额 —— 这个接口不计入限额，被限流时也答得出来
    return fetch(API + '/rate_limit', {
      headers: cfg.token ? { Authorization: 'Bearer ' + cfg.token } : {},
    }).then(function (res) {
      var exp = res.headers.get('github-authentication-token-expiration');
      if (exp) out.tokenExpiry = exp;
      return res.json().catch(function () { return null; });
    }).catch(function () { return null; }).then(function (rl) {
      var c = rl && rl.resources && rl.resources.core;
      if (c) out.quota = c.remaining + '/' + c.limit;
      return req(repoPath(''));
    }).then(function (r) {
      out.repo = r.full_name;
      out.private = r.private;
      out.read = '✅ 能读';
      return head();
    }).then(function (sha) {
      out.head = sha.slice(0, 7);
      // 写一个探针文件再删掉，确认真的有写权限
      return commit([{ path: '.probe', text: String(Date.now()) }], '连接自检');
    }).then(function () {
      out.write = '✅ 能写';
      return commitDelete(['.probe'], '连接自检：清理');
    }).then(function () {
      out.cleanup = '✅ 已清理';
      return finish(out);
    }).catch(function (err) {
      out.error = err.message;
      out.step = err.step || '';
      if (!out.read) out.read = '❌ 读失败';
      else if (!out.write) out.write = '❌ 写失败';
      return finish(out);
    });
  }

  /* 读—改—写循环。
     光重试提交是不够的：422 说明分支已经被别人推进了，
     而我们手里那份 JSON 是基于旧内容算出来的，硬推上去会覆盖别人刚写的。
     必须重新拉最新的、把改动重新套一遍，再提交。

     mutate(当前内容) → 新内容；返回 null 表示不需要改，直接跳过。 */
  function updateJSON(path, mutate, message, tries) {
    tries = tries == null ? 4 : tries;
    if (isLocal()) {
      return localLoad().then(function () {
        var next = mutate(L.json[path] === undefined ? null : L.json[path]);
        if (next == null) return null;
        return localCommit([{ path: path, text: JSON.stringify(next, null, 2) }], message);
      });
    }
    return readJSON(path).then(function (cur) {
      var next = mutate(cur);
      if (next == null) return null;
      return commitOnce(
        [{ path: path, text: JSON.stringify(next, null, 2) }], message
      );
    }).catch(function (err) {
      if (tokenBlocked(err) && !forceRemote) { L.on = true; return updateJSON(path, mutate, message, 0); }
      if (tries <= 0 || !/not a fast forward/i.test(err.message || '')) throw err;
      // 退避一下再来：并发写通常是几百毫秒内的事
      return new Promise(function (r) { setTimeout(r, 400 + Math.random() * 500); })
        .then(function () { return updateJSON(path, mutate, message, tries - 1); });
    });
  }

  window.GitStore = {
    selftest: selftest,
    updateJSON: updateJSON,
    configure: function (c) { Object.assign(cfg, c); },
    config: function () { return Object.assign({}, cfg, { token: cfg.token ? '***' : '' }); },
    req: req, repoPath: repoPath,
    head: head, tree: tree,
    readJSON: readJSON, readBlobBySha: readBlobBySha,
    commit: commit, commitDelete: commitDelete,
    utf8ToB64: utf8ToB64, b64ToUtf8: b64ToUtf8, b64ToBlob: b64ToBlob,
    cacheGet: cacheGet, cachePut: cachePut, cacheClear: cacheClear,
    goLocal: goLocal, isLocal: isLocal, pending: pending, drain: drain,
  };
})();
