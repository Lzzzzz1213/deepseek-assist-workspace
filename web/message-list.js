(function () {
  'use strict';

  var DEFAULT_ROW_HEIGHT = 72;
  var MAX_LAYOUT_HEIGHT = 10000000;
  var MEASURE_EPSILON = 0.5;

  function positiveNumber(value, fallback) {
    var n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, MAX_LAYOUT_HEIGHT);
  }

  function nonNegativeNumber(value, fallback) {
    var n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(n, MAX_LAYOUT_HEIGHT);
  }

  function toText(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function toPx(value) {
    var n = Number(value);
    if (!Number.isFinite(n) || n < 0) n = 0;
    return n + 'px';
  }

  function setSpacerHeight(element, value) {
    var next = toPx(value);
    if (element.style.height !== next) element.style.height = next;
  }

  function create(options) {
    if (!options || !options.scroller || !options.list ||
        typeof options.renderItem !== 'function') {
      throw new TypeError('WorkroomMessageList.create 参数不完整');
    }

    var scroller = options.scroller;
    var list = options.list;
    var renderItem = options.renderItem;
    var overscan = nonNegativeNumber(options.overscan, 400);
    var maxMounted = Math.max(1, Math.floor(positiveNumber(options.maxMounted, 48)));
    var cacheSize = Math.max(
      maxMounted,
      Math.floor(positiveNumber(options.cacheSize, 64))
    );

    var destroyed = false;
    var items = [];
    var heights = [];
    var measured = new Uint8Array(0);
    var prefix = new Float64Array(1);
    var totalHeight = 0;
    var indexByKey = new Map();

    var cache = new Map();
    var mounted = new Set();
    var pendingMeasure = new Set();
    var wrapperMap = new WeakMap();

    var scope = null;
    var initialized = false;
    var dataVersion = 0;
    var rangeDataVersion = -1;
    var mountStart = 0;
    var mountEnd = 0;

    var followBottom = false;
    var listOffset = 0;
    var paddingTop = 0;
    var paddingBottom = 0;
    var lastWidth = 0;
    var lastHeight = 0;
    var ignoreFollowUntil = 0;
    var rafId = 0;
    var resizeObserver = null;

    function makeSpacer() {
      var spacer = document.createElement('div');
      spacer.className = 'wr-vlist-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      spacer.setAttribute('role', 'presentation');
      spacer.style.height = '0px';
      return spacer;
    }

    var topSpacer = makeSpacer();
    var bottomSpacer = makeSpacer();

    list.classList.add('wr-virtual-list');
    scroller.classList.add('wr-vlist-scroll');
    while (list.firstChild) list.removeChild(list.firstChild);
    list.appendChild(topSpacer);
    list.appendChild(bottomSpacer);

    function readPadding() {
      var style = window.getComputedStyle(scroller);
      var top = Number.parseFloat(style.paddingTop);
      var bottom = Number.parseFloat(style.paddingBottom);
      paddingTop = Number.isFinite(top) ? top : 0;
      paddingBottom = Number.isFinite(bottom) ? bottom : 0;
      listOffset = -paddingTop;
    }

    function normalizeEntries(rawEntries) {
      if (rawEntries === null || rawEntries === undefined) rawEntries = [];
      if (!Array.isArray(rawEntries)) {
        throw new TypeError('WorkroomMessageList entries 必须是数组');
      }
      var seen = new Set();
      var result = new Array(rawEntries.length);
      for (var i = 0; i < rawEntries.length; i++) {
        var input = rawEntries[i];
        if (!input || typeof input !== 'object') {
          throw new TypeError('WorkroomMessageList entry 必须是对象');
        }
        if (typeof input.key !== 'string' || input.key.length === 0) {
          throw new TypeError('WorkroomMessageList entry.key 必须是非空字符串');
        }
        if (seen.has(input.key)) {
          throw new TypeError('WorkroomMessageList entry.key 必须唯一');
        }
        seen.add(input.key);
        result[i] = {
          key: input.key,
          version: toText(input.version),
          revision: toText(input.revision),
          estimatedHeight: positiveNumber(input.estimatedHeight, DEFAULT_ROW_HEIGHT),
          entry: input
        };
      }
      return result;
    }

    function sameSignature(record, item) {
      return record.version === item.version && record.revision === item.revision;
    }

    function scheduleFrame() {
      if (destroyed || rafId) return;
      rafId = window.requestAnimationFrame(frame);
    }

    function buildPrefix() {
      var n = items.length;
      prefix = new Float64Array(n + 1);
      var sum = 0;
      for (var i = 0; i < n; i++) {
        prefix[i] = sum;
        var h = Number(heights[i]);
        if (!Number.isFinite(h) || h <= 0) h = items[i].estimatedHeight;
        sum += h;
      }
      prefix[n] = sum;
      totalHeight = sum;
    }

    function findItemAt(offset) {
      var n = items.length;
      if (!n) return 0;
      if (offset <= 0) return 0;
      if (offset >= totalHeight) return n - 1;
      var low = 0;
      var high = n - 1;
      while (low < high) {
        var mid = (low + high + 1) >> 1;
        if (prefix[mid] <= offset) low = mid;
        else high = mid - 1;
      }
      return low;
    }

    function findEndAt(offset) {
      var n = items.length;
      if (offset <= 0) return 0;
      if (offset >= totalHeight) return n;
      var low = 0;
      var high = n;
      while (low < high) {
        var mid = (low + high) >> 1;
        if (prefix[mid] < offset) low = mid + 1;
        else high = mid;
      }
      return low;
    }

    function computeRange(viewportTop, viewportHeight) {
      var n = items.length;
      if (!n) return [0, 0];

      var visibleStart = findItemAt(viewportTop);
      var visibleEnd = findEndAt(viewportTop + viewportHeight);
      if (visibleEnd <= visibleStart) {
        visibleEnd = Math.min(n, visibleStart + 1);
      }

      var start = visibleStart;
      var end = visibleEnd;
      var above = 0;
      var below = 0;
      while (start > 0 && above < overscan) {
        start--;
        above += heights[start];
      }
      while (end < n && below < overscan) {
        below += heights[end];
        end++;
      }

      var visibleCount = visibleEnd - visibleStart;
      var limit = Math.max(maxMounted, visibleCount);
      while (end - start > limit) {
        var aboveCount = visibleStart - start;
        var belowCount = end - visibleEnd;
        if (aboveCount >= belowCount && aboveCount > 0) start++;
        else if (belowCount > 0) end--;
        else break;
      }
      return [start, end];
    }

    function unmountRecord(record) {
      if (!record.mounted) return;
      record.mounted = false;
      mounted.delete(record);
      pendingMeasure.delete(record);
      if (resizeObserver) {
        try {
          resizeObserver.unobserve(record.wrapper);
        } catch (error) {
          /* 已移除的节点无需再次观察 */
        }
      }
      if (record.wrapper.parentNode) {
        record.wrapper.parentNode.removeChild(record.wrapper);
      }
    }

    function discardRecord(record) {
      unmountRecord(record);
      if (record.wrapper.parentNode) {
        record.wrapper.parentNode.removeChild(record.wrapper);
      }
      if (cache.get(record.key) === record) cache.delete(record.key);
      wrapperMap.delete(record.wrapper);
    }

    function discardAllRecords() {
      var records = Array.from(cache.values());
      for (var i = 0; i < records.length; i++) discardRecord(records[i]);
      cache.clear();
      mounted.clear();
      pendingMeasure.clear();
    }

    function touch(record) {
      if (cache.get(record.key) === record) {
        cache.delete(record.key);
        cache.set(record.key, record);
      }
    }

    function trimCache() {
      if (cache.size <= cacheSize) return;
      var records = Array.from(cache.values());
      for (var i = 0; i < records.length && cache.size > cacheSize; i++) {
        if (!records[i].mounted) discardRecord(records[i]);
      }
    }

    function createRecord(item, index) {
      var content = renderItem(item.entry, index);
      if (!content || content.nodeType !== 1) {
        throw new TypeError('WorkroomMessageList renderItem 必须返回 Element');
      }
      var wrapper = document.createElement('div');
      wrapper.className = 'wr-vlist-item';
      wrapper.appendChild(content);
      var record = {
        key: item.key,
        index: index,
        entry: item.entry,
        version: item.version,
        revision: item.revision,
        wrapper: wrapper,
        mounted: false
      };
      cache.set(record.key, record);
      wrapperMap.set(wrapper, record);
      return record;
    }

    function ensureRecord(index) {
      var item = items[index];
      var record = cache.get(item.key);
      if (record && !sameSignature(record, item)) {
        discardRecord(record);
        record = null;
      }
      if (!record) {
        record = createRecord(item, index);
      } else {
        record.index = index;
        record.entry = item.entry;
      }
      touch(record);
      return record;
    }

    function hideAll() {
      var records = Array.from(mounted);
      for (var i = 0; i < records.length; i++) unmountRecord(records[i]);
      setSpacerHeight(topSpacer, totalHeight);
      setSpacerHeight(bottomSpacer, 0);
      mountStart = 0;
      mountEnd = 0;
      rangeDataVersion = dataVersion;
    }

    function applyRange(start, end) {
      var n = items.length;
      start = Math.max(0, Math.min(start, n));
      end = Math.max(start, Math.min(end, n));

      setSpacerHeight(topSpacer, prefix[start]);
      setSpacerHeight(bottomSpacer, totalHeight - prefix[end]);

      if (start === mountStart && end === mountEnd &&
          rangeDataVersion === dataVersion) {
        return;
      }

      var active = Array.from(mounted);
      for (var i = 0; i < active.length; i++) {
        var record = active[i];
        if (record.index < start || record.index >= end ||
            !items[record.index] || items[record.index].key !== record.key) {
          unmountRecord(record);
        }
      }

      var next = bottomSpacer;
      for (var index = end - 1; index >= start; index--) {
        var itemRecord = ensureRecord(index);
        if (itemRecord.wrapper.parentNode !== list ||
            itemRecord.wrapper.nextSibling !== next) {
          list.insertBefore(itemRecord.wrapper, next);
        }
        if (!itemRecord.mounted) {
          itemRecord.mounted = true;
          mounted.add(itemRecord);
          if (resizeObserver) resizeObserver.observe(itemRecord.wrapper);
        }
        pendingMeasure.add(itemRecord);
        touch(itemRecord);
        next = itemRecord.wrapper;
      }

      trimCache();
      mountStart = start;
      mountEnd = end;
      rangeDataVersion = dataVersion;
      scheduleFrame();
    }

    function updateRangeForTop(viewportTop, viewportHeight) {
      var height = typeof viewportHeight === 'number'
        ? viewportHeight
        : scroller.clientHeight;
      if (!items.length || height <= 0) {
        hideAll();
        return;
      }
      var range = computeRange(Math.max(0, viewportTop), height);
      applyRange(range[0], range[1]);
    }

    function updateRangeFromScroll(viewportHeight) {
      var height = typeof viewportHeight === 'number'
        ? viewportHeight
        : scroller.clientHeight;
      if (height <= 0) {
        hideAll();
        return;
      }
      updateRangeForTop(scroller.scrollTop + listOffset, height);
    }

    function writeScrollTop(value) {
      var top = Number(value);
      if (!Number.isFinite(top) || top < 0) top = 0;
      ignoreFollowUntil = (window.performance && window.performance.now
        ? window.performance.now()
        : Date.now()) + 80;
      scroller.scrollTop = top;
    }

    function captureAnchor() {
      if (!items.length || scroller.clientHeight <= 0) return null;
      var viewportTop = scroller.scrollTop + listOffset;
      var index = findItemAt(viewportTop);
      return {
        key: items[index].key,
        offset: viewportTop - prefix[index],
        index: index
      };
    }

    function resolveAnchor(anchor, oldItems) {
      if (!anchor) return null;
      var index = indexByKey.get(anchor.key);
      if (index !== undefined) {
        return { index: index, offset: anchor.offset };
      }

      var start = Math.min(anchor.index, oldItems.length);
      var i;
      for (i = start + 1; i < oldItems.length; i++) {
        index = indexByKey.get(oldItems[i].key);
        if (index !== undefined) return { index: index, offset: 0 };
      }
      for (i = Math.min(start - 1, oldItems.length - 1); i >= 0; i--) {
        index = indexByKey.get(oldItems[i].key);
        if (index !== undefined) return { index: index, offset: 0 };
      }
      return null;
    }

    function restoreAnchor(anchor, oldItems, viewportHeight) {
      var resolved = resolveAnchor(anchor, oldItems);
      if (!resolved) return false;
      var offset = Math.max(0, Math.min(resolved.offset, heights[resolved.index] - 1));
      var viewportTop = prefix[resolved.index] + offset;
      updateRangeForTop(viewportTop, viewportHeight);
      writeScrollTop(viewportTop - listOffset);
      return true;
    }

    function scrollToEndInternal() {
      followBottom = true;
      if (!items.length) {
        hideAll();
        writeScrollTop(0);
        return;
      }
      var height = scroller.clientHeight;
      if (height <= 0) {
        hideAll();
        return;
      }
      updateRangeForTop(Math.max(0, totalHeight - height), height);
      writeScrollTop(scroller.scrollHeight - scroller.clientHeight);
      scheduleFrame();
    }

    function applyMeasurements(viewportHeight) {
      if (!pendingMeasure.size) return false;
      var batch = Array.from(pendingMeasure);
      pendingMeasure.clear();
      if (!items.length) return false;

      var anchor = followBottom ? null : captureAnchor();
      var changed = false;
      for (var i = 0; i < batch.length; i++) {
        var record = batch[i];
        if (!record.mounted || record.wrapper.parentNode !== list) continue;
        var index = record.index;
        if (index < 0 || index >= items.length ||
            items[index].key !== record.key) continue;
        var height = record.wrapper.getBoundingClientRect().height;
        if (!Number.isFinite(height) || height <= 0) continue;
        if (height > MAX_LAYOUT_HEIGHT) height = MAX_LAYOUT_HEIGHT;
        if (!measured[index] || Math.abs(heights[index] - height) > MEASURE_EPSILON) {
          heights[index] = height;
          measured[index] = 1;
          changed = true;
        }
      }
      if (!changed) return false;

      buildPrefix();
      if (followBottom) {
        scrollToEndInternal();
        return true;
      }
      if (anchor) restoreAnchor(anchor, items, viewportHeight);
      updateRangeFromScroll(viewportHeight);
      return true;
    }

    function handleWidthChange(width) {
      lastWidth = width;
      readPadding();
      if (!items.length) return;
      var height = scroller.clientHeight;
      if (height <= 0) {
        hideAll();
        return;
      }

      var keepBottom = followBottom;
      var anchor = keepBottom ? null : captureAnchor();
      for (var i = 0; i < items.length; i++) {
        // 旧测量值暂作估计，先保住长文锚点；挂载行随后按新宽度重测。
        measured[i] = 0;
      }
      buildPrefix();

      if (keepBottom) {
        scrollToEndInternal();
      } else if (anchor) {
        restoreAnchor(anchor, items, height);
      } else {
        updateRangeFromScroll(height);
      }

      var records = Array.from(mounted);
      for (var j = 0; j < records.length; j++) {
        if (records[j].mounted) pendingMeasure.add(records[j]);
      }
      scheduleFrame();
    }

    function frame() {
      rafId = 0;
      if (destroyed) return;

      var width = scroller.clientWidth;
      var height = scroller.clientHeight;
      var widthChanged = initialized && Math.abs(width - lastWidth) > 0.5;

      if (widthChanged) {
        handleWidthChange(width);
      } else if (height !== lastHeight) {
        lastHeight = height;
        if (height <= 0) {
          hideAll();
        } else if (followBottom) {
          scrollToEndInternal();
        } else {
          updateRangeFromScroll(height);
        }
      }

      lastWidth = width;
      lastHeight = height;

      if (pendingMeasure.size) applyMeasurements(height);
      if (!widthChanged) updateRangeFromScroll(height);
    }

    function onScroll() {
      if (destroyed) return;
      if (followBottom && scroller.clientHeight > 0 &&
          (window.performance && window.performance.now
            ? window.performance.now()
            : Date.now()) > ignoreFollowUntil) {
        var maxApprox = paddingTop + totalHeight + paddingBottom - scroller.clientHeight;
        if (maxApprox - scroller.scrollTop > 8) followBottom = false;
      }
      scheduleFrame();
    }

    function onResize(entries) {
      if (destroyed) return;
      for (var i = 0; i < entries.length; i++) {
        var target = entries[i].target;
        if (target === scroller) {
          scheduleFrame();
        } else {
          var record = wrapperMap.get(target);
          if (record && record.mounted) {
            pendingMeasure.add(record);
            scheduleFrame();
          }
        }
      }
    }

    function onWindowResize() {
      if (destroyed) return;
      if (!resizeObserver) {
        var records = Array.from(mounted);
        for (var i = 0; i < records.length; i++) pendingMeasure.add(records[i]);
      }
      scheduleFrame();
    }

    function stopFollowing() {
      followBottom = false;
    }

    function onWheel(event) {
      if (event.deltaY < 0) stopFollowing();
    }

    function onKeyDown(event) {
      if (event.key === 'ArrowUp' || event.key === 'PageUp' ||
          event.key === 'Home' || event.key === 'Enter' ||
          event.key === ' ' || event.key === 'Spacebar') {
        stopFollowing();
      }
    }

    function setItems(rawEntries, setOptions) {
      if (destroyed) return;
      var options = setOptions || {};
      var nextScope = options.scope === null || options.scope === undefined
        ? ''
        : String(options.scope);
      var reset = !!options.reset;
      var stickToBottom = !!options.stickToBottom;
      var nextItems = normalizeEntries(rawEntries);

      var scopeChanged = initialized && nextScope !== scope;
      var hadItems = items.length > 0;
      var oldItems = items;
      var oldIndexByKey = indexByKey;
      var oldHeights = heights;
      var oldMeasured = measured;
      var anchorBefore = !scopeChanged && !reset && !stickToBottom && hadItems
        ? captureAnchor()
        : null;

      var n = nextItems.length;
      var nextHeights = new Array(n);
      var nextMeasured = new Uint8Array(n);
      var nextIndexByKey = new Map();

      for (var i = 0; i < n; i++) {
        var item = nextItems[i];
        var oldIndex = oldIndexByKey.get(item.key);
        var oldItem = oldIndex === undefined ? null : oldItems[oldIndex];
        var reuse = !scopeChanged && oldItem &&
          oldItem.version === item.version &&
          oldItem.revision === item.revision;
        if (reuse) {
          var oldHeight = oldHeights[oldIndex];
          nextHeights[i] = Number.isFinite(oldHeight) && oldHeight > 0
            ? oldHeight
            : item.estimatedHeight;
          nextMeasured[i] = oldMeasured[oldIndex] || 0;
        } else {
          nextHeights[i] = item.estimatedHeight;
          nextMeasured[i] = 0;
        }
        nextIndexByKey.set(item.key, i);
      }

      if (scopeChanged) {
        discardAllRecords();
      } else {
        var cached = Array.from(cache.values());
        for (var c = 0; c < cached.length; c++) {
          var record = cached[c];
          var nextIndex = nextIndexByKey.get(record.key);
          if (nextIndex === undefined) {
            discardRecord(record);
            continue;
          }
          var nextItem = nextItems[nextIndex];
          if (!sameSignature(record, nextItem)) {
            discardRecord(record);
            continue;
          }
          record.index = nextIndex;
          record.entry = nextItem.entry;
        }
      }

      items = nextItems;
      heights = nextHeights;
      measured = nextMeasured;
      indexByKey = nextIndexByKey;
      dataVersion++;
      buildPrefix();
      scope = nextScope;
      initialized = true;

      followBottom = reset || stickToBottom || (!hadItems && items.length > 0);

      if (followBottom) {
        scrollToEndInternal();
        return;
      }
      if (scopeChanged) {
        writeScrollTop(0);
        updateRangeFromScroll();
        scheduleFrame();
        return;
      }
      if (anchorBefore && restoreAnchor(anchorBefore, oldItems)) return;
      updateRangeFromScroll();
      scheduleFrame();
    }

    function clear() {
      if (destroyed) return;
      setItems([], { scope: scope === null ? '' : scope, reset: true });
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('touchmove', stopFollowing);
      scroller.removeEventListener('pointerdown', stopFollowing);
      scroller.removeEventListener('focusin', stopFollowing);
      scroller.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onWindowResize);
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      discardAllRecords();
      if (topSpacer.parentNode) topSpacer.parentNode.removeChild(topSpacer);
      if (bottomSpacer.parentNode) bottomSpacer.parentNode.removeChild(bottomSpacer);
      list.classList.remove('wr-virtual-list');
      scroller.classList.remove('wr-vlist-scroll');
      items = [];
      heights = [];
      measured = new Uint8Array(0);
      prefix = new Float64Array(1);
      totalHeight = 0;
      indexByKey.clear();
      wrapperMap = new WeakMap();
    }

    readPadding();
    lastWidth = scroller.clientWidth;
    lastHeight = scroller.clientHeight;

    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('wheel', onWheel, { passive: true });
    scroller.addEventListener('touchmove', stopFollowing, { passive: true });
    scroller.addEventListener('pointerdown', stopFollowing, { passive: true });
    scroller.addEventListener('focusin', stopFollowing);
    scroller.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onWindowResize, { passive: true });

    if (typeof window.ResizeObserver === 'function') {
      resizeObserver = new window.ResizeObserver(onResize);
      resizeObserver.observe(scroller);
    }

    return {
      setItems: setItems,
      scrollToEnd: function () {
        if (destroyed) return;
        scrollToEndInternal();
      },
      clear: clear,
      destroy: destroy
    };
  }

  window.WorkroomMessageList = {
    create: create
  };
})();
