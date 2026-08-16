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
      if (res.status === 401) { var e401 = new Error('令牌无效或已过期'); e401.noRetry = true; throw e401; }
      if (res.status === 403) {
        return res.text().then(function (t) {
          var e = new Error(/rate limit/i.test(t)
            ? 'GitHub 限流了，等几分钟再试'
            : '令牌权限不足 —— 需要这个仓库的 Contents: Read and write');
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

  /* ---------- 读 ---------- */

  function head() {
    return req(repoPath('/git/ref/heads/' + cfg.branch)).then(function (r) {
      return r.object.sha;
    });
  }

  // 一次拿到整棵树，省得为每个文件单独查 sha
  function tree(sha) {
    return req(repoPath('/git/trees/' + sha + '?recursive=1'));
  }

  function readJSON(path) {
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

  function commit(files, message, onStep) {
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
      }).then(function () { return newCommit.sha; });
    }).catch(function (err) {
      // 把「在哪一步失败」带出去，光看 HTTP 码没法判断
      err.step = lastStep;
      throw err;
    });
  }

  /* ---------- 删除 ----------
     Git 里删文件 = 提交一棵不含它的树。用 sha:null 标记删除。 */

  function commitDelete(paths, message) {
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
    return req(repoPath('')).then(function (r) {
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
      return out;
    }).catch(function (err) {
      out.error = err.message;
      out.step = err.step || '';
      if (!out.read) out.read = '❌ 读失败';
      else if (!out.write) out.write = '❌ 写失败';
      return out;
    });
  }

  window.GitStore = {
    selftest: selftest,
    configure: function (c) { Object.assign(cfg, c); },
    config: function () { return Object.assign({}, cfg, { token: cfg.token ? '***' : '' }); },
    req: req, repoPath: repoPath,
    head: head, tree: tree,
    readJSON: readJSON, readBlobBySha: readBlobBySha,
    commit: commit, commitDelete: commitDelete,
    utf8ToB64: utf8ToB64, b64ToUtf8: b64ToUtf8, b64ToBlob: b64ToBlob,
    cacheGet: cacheGet, cachePut: cachePut, cacheClear: cacheClear,
  };
})();
