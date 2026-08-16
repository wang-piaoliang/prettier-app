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

  var MAX_EDGE = 1600;      // 够看清毛孔和色斑，又不至于几 MB
  var TARGET_LUMA = 0.56;
  var QUALITY = 0.86;

  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('这张图读不了（HEIC 只有 Safari 能解）'));
      };
      img.src = url;
    });
  }

  function averageLuma(ctx, w, h) {
    // 抽样足够判断整体明暗，不必遍历几百万像素
    var sample = 32;
    var data = ctx.getImageData(0, 0, w, h).data;
    var step = Math.max(1, Math.floor(Math.sqrt(w * h / (sample * sample))));
    var sum = 0, n = 0;
    for (var i = 0; i < data.length; i += 4 * step) {
      sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      n++;
    }
    return n ? sum / n : TARGET_LUMA;
  }

  function normalize(blob) {
    return loadImage(blob).then(function (img) {
      var scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.max(1, Math.round(img.naturalWidth * scale));
      var h = Math.max(1, Math.round(img.naturalHeight * scale));

      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);

      var luma = averageLuma(ctx, w, h);
      var gain = Math.min(1.25, Math.max(0.72, TARGET_LUMA / (luma || TARGET_LUMA)));
      if (Math.abs(gain - 1) > 0.02) {
        ctx.clearRect(0, 0, w, h);
        ctx.filter = 'brightness(' + gain.toFixed(3) + ')';
        ctx.drawImage(img, 0, 0, w, h);
        ctx.filter = 'none';
      }

      return new Promise(function (resolve) {
        canvas.toBlob(function (out) {
          // 转换失败就退回原图 —— 宁可亮一点，也不能把照片弄丢
          resolve({ blob: out || blob, width: w, height: h, gain: gain });
        }, 'image/jpeg', QUALITY);
      });
    });
  }

  window.PrettierPhoto = { normalize: normalize, MAX_EDGE: MAX_EDGE };
})();
