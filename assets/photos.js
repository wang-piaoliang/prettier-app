/* 本机照片库：路径是稳定身份；云端仅作可选备份。
   复用现有 IndexedDB，已下载的 SHA 缓存可自动迁入，无需重传照片。 */
(function () {
  'use strict';
  var scope = '', pending = {};
  function configure(c) { scope = [c.owner || '', c.repo || '', c.branch || 'main'].join('/'); }
  function prefix() { return '__photo:' + encodeURIComponent(scope) + ':'; }
  function mode() { try { return localStorage.getItem('prettier.photos.mode.' + scope) === 'local' ? 'local' : 'backup'; } catch (e) { return 'backup'; } }
  function setMode(v) { localStorage.setItem('prettier.photos.mode.' + scope, v === 'local' ? 'local' : 'backup'); }
  function put(path, blob, sha) {
    if (!blob || !blob.size) return Promise.reject(new Error('照片为空，不能保存'));
    return putAt(prefix() + path, path, blob, sha);
  }
  function putAt(key, path, blob, sha) {
    return window.GitStore.cachePut(key, { path: path, blob: blob, sha: sha || '', size: blob.size }, true);
  }
  function get(path, sha) {
    var key = prefix() + path;
    var requestKey = key + ':' + (sha || '');
    if (pending[requestKey]) return pending[requestKey];
    var task = window.GitStore.cacheGet(key, true).then(function (record) {
      if (record && record.blob && (!sha || !record.sha || record.sha === sha || sha.indexOf('local:') === 0)) return record.blob;
      return window.GitStore.cacheGet(sha || ('local:' + path)).then(function (legacy) {
        if (legacy && legacy.size) return putAt(key, path, legacy, sha).then(function () { return legacy; });
        if (!sha || sha.indexOf('local:') === 0) throw new Error('这张照片不在本机，请从原设备导入照片备份');
        return window.GitStore.readBlobBySha(sha).then(function (blob) {
          return putAt(key, path, blob, sha).then(function () { return blob; });
        });
      });
    });
    pending[requestKey] = task;
    task.then(function () { delete pending[requestKey]; }, function () { delete pending[requestKey]; });
    return task;
  }
  function prepare(files, queuedBackup) {
    var base = prefix(), policy = queuedBackup ? 'backup' : mode();
    return files.reduce(function (chain, f) {
      return chain.then(function () { return f.blob ? putAt(base + f.path, f.path, f.blob) : null; });
    }, Promise.resolve()).then(function () {
      return policy === 'local' ? files.filter(function (f) { return !f.blob; }) : files;
    });
  }
  function remove(paths) {
    var base = prefix();
    return Promise.all(paths.map(function (p) { return window.GitStore.cacheDelete(base + p); }));
  }
  function records(metadataOnly) { return window.GitStore.cacheList(prefix(), metadataOnly).then(function (rows) { return rows.map(function (r) { return r.value; }).filter(function (r) { return r && r.blob; }); }); }
  function stats() { return records(true).then(function (rows) { return { count: rows.length, bytes: rows.reduce(function (n, r) { return n + (r.size || r.blob.size || 0); }, 0) }; }); }
  function keepStorage() {
    if (navigator.storage && navigator.storage.persist) return navigator.storage.persist().catch(function () { return false; });
    return Promise.resolve(false);
  }
  // ZIP 使用 STORE（无压缩），Blob 按照片拼接，避免把整个照片库读进内存。
  var crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function header(size) { var bytes = new Uint8Array(size); return { bytes: bytes, view: new DataView(bytes.buffer) }; }
  function exportBackup(settings, entries, onStep) {
    var savedScope = scope;
    return records(true).then(function (rows) {
      if (!rows.length) throw new Error('本机还没有照片，请先保存历史照片');
      var manifest = { format: 'prettier-photos-v1', scope: savedScope, settings: settings || {}, entries: entries || [], photos: rows.map(function (r, i) {
        return { path: r.path, sha: r.sha || '', file: 'photos/' + i + '.jpg', mime: r.blob.type || 'image/jpeg' };
      }) };
      var files = [{ name: 'prettier-photos.json', blob: new Blob([JSON.stringify(manifest)], { type: 'application/json' }) }];
      rows.forEach(function (r, i) { files.push({ name: 'photos/' + i + '.jpg', path: r.path, sha: r.sha }); });
      var parts = [], central = [], offset = 0;
      return files.reduce(function (chain, file, i) {
        return chain.then(function () {
          if (onStep) onStep(i, rows.length);
          var source = file.path ? get(file.path, file.sha) : Promise.resolve(file.blob);
          return source.then(function (blob) { file.blob = blob; return blob.arrayBuffer(); }).then(function (buffer) {
            var name = new TextEncoder().encode(file.name), crc = crc32(new Uint8Array(buffer));
            if (offset + file.blob.size > 0xffffffff) throw new Error('照片备份超过 4GB，请分批备份');
            var local = header(30), v = local.view;
            v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true);
            v.setUint32(14, crc, true); v.setUint32(18, file.blob.size, true); v.setUint32(22, file.blob.size, true); v.setUint16(26, name.length, true);
            var dir = header(46); v = dir.view;
            v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x800, true);
            v.setUint32(16, crc, true); v.setUint32(20, file.blob.size, true); v.setUint32(24, file.blob.size, true); v.setUint16(28, name.length, true); v.setUint32(42, offset, true);
            parts.push(local.bytes, name, file.blob); central.push(dir.bytes, name);
            offset += 30 + name.length + file.blob.size;
          });
        });
      }, Promise.resolve()).then(function () {
        var centralSize = central.reduce(function (n, b) { return n + b.length; }, 0), end = header(22), v = end.view;
        v.setUint32(0, 0x06054b50, true); v.setUint16(8, files.length, true); v.setUint16(10, files.length, true); v.setUint32(12, centralSize, true); v.setUint32(16, offset, true);
        return new Blob(parts.concat(central, [end.bytes]), { type: 'application/zip' });
      });
    });
  }
  function importBackup(file, onStep) {
    var offset = 0, files = {}, manifest, savedScope = scope, base = prefix();
    function next() {
      return file.slice(offset, offset + 30).arrayBuffer().then(function (buffer) {
        if (buffer.byteLength < 4) throw new Error('照片备份不完整');
        var v = new DataView(buffer), signature = v.getUint32(0, true);
        if (signature === 0x02014b50) return;
        if (signature !== 0x04034b50 || buffer.byteLength < 30 || v.getUint16(8, true) !== 0 || (v.getUint16(6, true) & 9)) throw new Error('请选择由 Prettier 导出的照片备份');
        var size = v.getUint32(18, true), nameSize = v.getUint16(26, true), extra = v.getUint16(28, true), crc = v.getUint32(14, true);
        var start = offset + 30 + nameSize + extra;
        if (start + size > file.size) throw new Error('照片备份不完整');
        return file.slice(offset + 30, offset + 30 + nameSize).text().then(function (name) {
          files[name] = { blob: file.slice(start, start + size), crc: crc };
          offset = start + size;
          return next();
        });
      });
    }
    return next().then(function () {
      if (!files['prettier-photos.json']) throw new Error('不是 Prettier 照片备份');
      var info = files['prettier-photos.json'];
      return info.blob.arrayBuffer().then(function (buffer) {
        if (crc32(new Uint8Array(buffer)) !== info.crc) throw new Error('照片备份清单校验失败');
        return new TextDecoder().decode(buffer);
      });
    }).then(function (text) {
      manifest = JSON.parse(text);
      if (manifest.format !== 'prettier-photos-v1' || manifest.scope !== savedScope || !Array.isArray(manifest.photos)) throw new Error('照片备份不属于当前数据仓库');
      // 先校验整包，再写入；损坏备份不能部分覆盖已有照片。
      return manifest.photos.reduce(function (chain, photo) {
        return chain.then(function () {
          var f = files[photo.file];
          if (!f || typeof photo.path !== 'string' || /(^|\/)\.\.(\/|$)/.test(photo.path)) throw new Error('照片备份缺少文件或路径无效');
          return f.blob.arrayBuffer().then(function (buffer) { if (crc32(new Uint8Array(buffer)) !== f.crc) throw new Error('照片备份校验失败：' + photo.path); });
        });
      }, Promise.resolve());
    }).then(function () {
      return manifest.photos.reduce(function (chain, photo, i) {
        return chain.then(function () {
          if (onStep) onStep(i + 1, manifest.photos.length);
          var f = files[photo.file];
          return putAt(base + photo.path, photo.path, f.blob.slice(0, f.blob.size, photo.mime || 'image/jpeg'), photo.sha);
        });
      }, Promise.resolve()).then(function () { return manifest.photos.length; });
    });
  }
  window.PrettierPhotos = { configure: configure, mode: mode, setMode: setMode, put: put, get: get, prepare: prepare, remove: remove, stats: stats, keepStorage: keepStorage, exportBackup: exportBackup, importBackup: importBackup };
})();
