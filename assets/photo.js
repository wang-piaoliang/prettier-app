/* ============================================================
   照片归一化
   ------------------------------------------------------------
   做两件事，都是为了让不同时间拍的照片能横向比较：

   ① 压平 HDR。iPhone 拍的是 HDR，Safari 按扩展动态范围渲染，
      缩略图看着过曝，而且每张的亮度色调都不一样。CSS 滤镜压不住它 ——
      滤镜作用在已经被提亮的结果上。重画进 canvas 再导出 JPEG，
      canvas 的输出必然是 SDR/sRGB，HDR 增益在这一步被压平。

   ② 温和的亮度归一。只把明显偏亮/偏暗的拉回来，增益夹在 0.72–1.25，
      不做"修图" —— 皮肤档案要的是真实。

   对这个项目这不是锦上添花：每张明暗都不同的话，色斑深浅根本没法纵向比。
   做法取自 nutriflow（那边是为了餐食缩略图整齐），这里的理由更硬。
   ============================================================ */

(function () {
  'use strict';

  /* 这是一份要放大看毛孔、色斑、细纹的档案，
     压太狠就失去意义了 —— 用户反馈「在相册里比在 App 里清晰」。
     2560 边长在 iPhone 上放大两三倍仍然锐利，一张约 1MB。 */
  var MAX_EDGE = 2560;
  var TARGET_LUMA = 0.56;
  var QUALITY = 0.92;

  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      var timer = setTimeout(function () {
        img.onload = img.onerror = null;
        img.src = '';
        URL.revokeObjectURL(url);
        reject(new Error('照片读取超时，请重新选择这张照片'));
      }, 30000);
      img.onload = function () { clearTimeout(timer); URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        reject(new Error('无法读取这张照片；HEIC/HEIF 请用 Safari 打开，或在相册中导出 JPEG 后重试'));
      };
      img.src = url;
    });
  }

  function averageLuma(ctx, w, h) {
    // 抽样足够判断整体明暗，不必遍历几百万像素
    var sample = 32;
    var sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = sampleCanvas.height = sample;
    var sampleCtx = sampleCanvas.getContext('2d');
    sampleCtx.drawImage(ctx.canvas, 0, 0, sample, sample);
    var data = sampleCtx.getImageData(0, 0, sample, sample).data;
    var step = 1;
    var sum = 0, n = 0;
    for (var i = 0; i < data.length; i += 4 * step) {
      sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      n++;
    }
    return n ? sum / n : TARGET_LUMA;
  }

  function normalizeOne(blob) {
    return loadImage(blob).then(function (img) {
      var scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.max(1, Math.round(img.naturalWidth * scale));
      var h = Math.max(1, Math.round(img.naturalHeight * scale));

      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('照片处理失败，请关闭其他页面后重试');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      var luma = averageLuma(ctx, w, h);
      var gain = Math.min(1.25, Math.max(0.72, TARGET_LUMA / (luma || TARGET_LUMA)));
      if (Math.abs(gain - 1) > 0.02) {
        ctx.clearRect(0, 0, w, h);
        ctx.filter = 'brightness(' + gain.toFixed(3) + ')';
        ctx.drawImage(img, 0, 0, w, h);
        ctx.filter = 'none';
      }

      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (out) {
          canvas.width = canvas.height = 1;
          if (!out) { reject(new Error('照片转换失败，请重新选择或导出 JPEG 后重试')); return; }
          resolve({ blob: out, width: w, height: h, gain: gain });
        }, 'image/jpeg', QUALITY);
      });
    });
  }

  var processing = Promise.resolve();
  function normalize(blob) {
    var next = processing.then(function () { return normalizeOne(blob); });
    processing = next.catch(function () {});
    return next;
  }

  window.PrettierPhoto = { normalize: normalize, MAX_EDGE: MAX_EDGE };
})();
