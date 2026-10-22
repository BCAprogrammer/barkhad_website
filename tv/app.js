(function () {
  'use strict';

  /* ================= CONFIG ================= */
  var PLAYLISTS = [
    { url: 'playlist.m3u', fallback: 'https://raw.githubusercontent.com/bcaprogrammer/tv/main/playlist.m3u' },
    'https://iptv-org.github.io/iptv/categories/movies.m3u',
    'https://iptv-org.github.io/iptv/categories/series.m3u',
    'https://iptv-org.github.io/iptv/categories/animation.m3u',
    'https://iptv-org.github.io/iptv/countries/so.m3u'
  ];

  var STATUS_KEY = 'streamStatus.v2';
  var CACHE_TTL  = 24 * 60 * 60 * 1000;   // 24h

  /* ================= STATE ================= */
  var channels = [];
  var filtered = [];
  var currentIndex = -1;
  var currentTab = 'all';
  var query = '';
  var hls = null;
  var mediaRecorder = null;
  var recordChunks = [];
  var tearingDown = false;

  var profiles = [];
  var currentProfileId = '';
  var favs = new Set();

  var hideOffline = localStorage.getItem('hideOffline') === 'true';
  var streamStatus = new Map();   // url -> { status, ts }
  var statusSaveTimer = null;

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');
  var list  = $('list');
  var placeholder = $('placeholder');
  var modal = $('modal-backdrop');
  var modalInput = $('modal-input');
  var lastFocused = null;

  /* ================= HELPERS ================= */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var escapeAttr = escapeHtml;

  function channelKey(ch) {
    return ch.url || ch.id || ch.name;
  }

  function currentChannel() {
    return currentIndex >= 0 ? filtered[currentIndex] : null;
  }

  /* ================= STREAM STATUS =================
     Status is learned from real playback outcomes only.
     No speculative cross-origin probing on page load.            */
  function getStream(url) {
    var rec = streamStatus.get(url);
    if (!rec) return 'unknown';
    if (Date.now() - rec.ts > CACHE_TTL) {
      streamStatus.delete(url);
      return 'unknown';
    }
    return rec.status;
  }

  function setStream(url, status) {
    if (!url) return;
    var prev = getStream(url);
    if (prev === status) return;
    streamStatus.set(url, { status: status, ts: Date.now() });
    scheduleStatusSave();
  }

  function scheduleStatusSave() {
    clearTimeout(statusSaveTimer);
    statusSaveTimer = setTimeout(persistStatus, 800);
  }

  function persistStatus() {
    try {
      var arr = [];
      streamStatus.forEach(function (rec, url) {
        arr.push([url, rec.status, rec.ts]);
      });
      localStorage.setItem(STATUS_KEY, JSON.stringify(arr));
    } catch (e) { /* quota / private mode — ignore */ }
  }

  function loadCachedStatus() {
    try {
      var raw = JSON.parse(localStorage.getItem(STATUS_KEY) || '[]');
      var now = Date.now();
      raw.forEach(function (row) {
        if (!Array.isArray(row) || row.length < 3) return;
        if (now - row[2] < CACHE_TTL) {
          streamStatus.set(row[0], { status: row[1], ts: row[2] });
        }
      });
    } catch (e) { /* corrupt cache — start clean */ }
  }

  /* ================= PROFILES ================= */
  function uid() {
    return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function loadProfiles() {
    try {
      var raw = localStorage.getItem('profiles');
      if (raw) profiles = JSON.parse(raw);
    } catch (e) { profiles = []; }

    if (!Array.isArray(profiles) || profiles.length === 0) {
      profiles = [{ id: uid(), name: 'Default', favs: [] }];
    }

    currentProfileId = localStorage.getItem('currentProfileId') || '';
    if (!profiles.some(function (p) { return p.id === currentProfileId; })) {
      currentProfileId = profiles[0].id;
    }

    var cur = profiles.find(function (p) { return p.id === currentProfileId; });
    favs = new Set(cur && Array.isArray(cur.favs) ? cur.favs : []);
  }

  function saveProfiles() {
    try {
      var cur = profiles.find(function (p) { return p.id === currentProfileId; });
      if (cur) cur.favs = Array.from(favs);
      localStorage.setItem('profiles', JSON.stringify(profiles));
      localStorage.setItem('currentProfileId', currentProfileId);
    } catch (e) { /* quota exceeded — nothing safe to do here */ }
  }

  function switchProfile(id) {
    var next = profiles.find(function (p) { return p.id === id; });
    if (!next) return;
    saveProfiles();
    currentProfileId = id;
    favs = new Set(next.favs || []);
    localStorage.setItem('currentProfileId', currentProfileId);
    renderProfileSelect();
    updateCounts();
    applyFilter();
    toast('Switched to "' + next.name + '"');
  }

  function createProfile(name) {
    name = (name || '').trim() || ('Profile ' + (profiles.length + 1));
    var p = { id: uid(), name: name, favs: [] };
    profiles.push(p);
    saveProfiles();
    switchProfile(p.id);
  }

  function deleteProfile(id) {
    if (profiles.length <= 1) {
      toast('Cannot delete the last profile', 'error');
      return;
    }
    var p = profiles.find(function (x) { return x.id === id; });
    if (!p) return;
    if (!confirm('Delete profile "' + p.name + '"? Its favorites will be lost.')) return;

    profiles = profiles.filter(function (x) { return x.id !== id; });
    if (currentProfileId === id) {
      currentProfileId = profiles[0].id;
      favs = new Set(profiles[0].favs || []);
    }
    saveProfiles();
    renderProfileSelect();
    updateCounts();
    applyFilter();
    toast('Deleted "' + p.name + '"');
  }

  function renderProfileSelect() {
    var sel = $('profile-select');
    sel.textContent = '';
    profiles.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      opt.selected = (p.id === currentProfileId);
      sel.appendChild(opt);
    });
  }

  /* One-time migration: older versions keyed favorites by tvg-id,
     which collides across feeds. Re-key them to the stream URL. */
  function migrateFavKeys() {
    var changed = false;
    channels.forEach(function (ch) {
      if (!ch.id) return;
      if (favs.has(ch.id) && ch.url) {
        favs.delete(ch.id);
        favs.add(ch.url);
        changed = true;
      }
    });
    if (changed) saveProfiles();
  }

  /* ================= CATEGORIZATION + PARSER ================= */
  function categorize(ch) {
    var g = (ch.group || '').toLowerCase();
    var n = (ch.name || '').toLowerCase();
    if (g.indexOf('movie') > -1 || g.indexOf('film') > -1 ||
        g.indexOf('cinema') > -1 || n.indexOf(' (movie)') > -1) return 'movies';
    if (g.indexOf('series') > -1 || g.indexOf('show') > -1 ||
        g.indexOf('season') > -1 || n.indexOf(' s0') > -1 || n.indexOf(' s1') > -1) return 'series';
    if (g.indexOf('animation') > -1 || g.indexOf('anime') > -1 ||
        g.indexOf('cartoon') > -1 || g.indexOf('kids') > -1) return 'animation';
    return 'live';
  }

  function parseM3U(text) {
    var out = [];
    var lines = text.split('\n');
    var cur = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      if (line.indexOf('#EXTINF') === 0) {
        var nameM  = line.match(/,(.+)$/);
        var groupM = line.match(/group-title="([^"]*)"/);
        var logoM  = line.match(/tvg-logo="([^"]*)"/);
        var idM    = line.match(/tvg-id="([^"]*)"/);
        cur = {
          name:  nameM  ? nameM[1].trim()  : 'Unknown',
          group: groupM ? groupM[1].trim() : 'General',
          logo:  logoM  ? logoM[1].trim()  : '',
          id:    idM    ? idM[1].trim()    : '',
          url: ''
        };
      } else if (line.charAt(0) !== '#' && cur) {
        cur.url = line;
        cur.type = categorize(cur);
        out.push(cur);
        cur = null;
      }
    }
    return out;
  }

  /* ================= LOAD ================= */
  function loadAll() {
    setStatus('Loading playlist…', 'loading');

    var chain = Promise.resolve();
    var all = [];

    PLAYLISTS.forEach(function (entry) {
      chain = chain.then(function () {
        var primary  = typeof entry === 'string' ? entry : entry.url;
        var fallback = typeof entry === 'string' ? null : entry.fallback;
        var targets  = fallback ? [primary, fallback] : [primary];

        var attempt = function (i) {
          if (i >= targets.length) return Promise.resolve();
          return fetch(targets[i], { cache: 'no-store' })
            .then(function (r) {
              if (!r.ok) throw new Error('HTTP ' + r.status);
              return r.text();
            })
            .then(function (txt) {
              all = all.concat(parseM3U(txt));
            })
            .catch(function (err) {
              console.error('Playlist failed:', targets[i], err);
              return attempt(i + 1);
            });
        };
        return attempt(0);
      });
    });

    return chain.then(function () {
      channels = all;

      if (channels.length === 0) {
        setStatus('No channels', 'error');
        list.innerHTML =
          '<div class="empty"><div class="icon" aria-hidden="true">📭</div>' +
          '<h3>Couldn\'t load playlist</h3>' +
          '<p>Check the source URLs in PLAYLISTS.</p></div>';
        return;
      }

      migrateFavKeys();
      setStatus(channels.length + ' items', '');
      updateCounts();
      applyFilter();
      enableControls(true);
    });
  }

  function updateCounts() {
    var c = { all: channels.length, live: 0, movies: 0, series: 0, animation: 0 };
    channels.forEach(function (ch) { if (c[ch.type] != null) c[ch.type]++; });

    $('count-all').textContent       = c.all;
    $('count-favorites').textContent = favs.size;
    $('count-live').textContent      = c.live;
    $('count-movies').textContent    = c.movies;
    $('count-series').textContent    = c.series;
    $('count-animation').textContent = c.animation;
  }

  /* ================= FILTER + RENDER ================= */
  function applyFilter() {
    var q = query.toLowerCase();

    filtered = channels.filter(function (ch) {
      var key = channelKey(ch);

      if (currentTab === 'favorites') {
        if (!favs.has(key)) return false;
      } else if (currentTab !== 'all' && ch.type !== currentTab) {
        return false;
      }

      if (hideOffline && getStream(ch.url) === 'dead') return false;

      if (q) {
        if (ch.name.toLowerCase().indexOf(q) === -1 &&
            ch.group.toLowerCase().indexOf(q) === -1) return false;
      }
      return true;
    });

    renderList();

    $('list-count').textContent =
      filtered.length + ' item' + (filtered.length === 1 ? '' : 's');

    var titles = {
      all: 'All', favorites: '★ Favorites', live: 'Live TV',
      movies: 'Movies', series: 'Series', animation: 'Animation'
    };
    $('list-title').textContent = titles[currentTab] || 'Channels';
  }

  function renderList() {
    if (filtered.length === 0) {
      var msg = currentTab === 'favorites'
        ? { icon: '★', h: 'No favorites yet', p: 'Tap the ☆ on any channel to save it here.' }
        : { icon: '🔍', h: 'Nothing here', p: 'Try a different category or search.' };
      list.innerHTML =
        '<div class="empty"><div class="icon" aria-hidden="true">' + msg.icon + '</div>' +
        '<h3>' + msg.h + '</h3><p>' + msg.p + '</p></div>';
      return;
    }

    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      var ch = filtered[i];
      var key = channelKey(ch);
      var isFav = favs.has(key);
      var status = getStream(ch.url);
      var dotClass = status === 'ok' ? 'ok' : status === 'dead' ? 'dead'
                   : status === 'checking' ? 'checking' : '';
      var dot = status !== 'unknown'
        ? '<span class="stream-dot ' + dotClass + '" aria-hidden="true"></span>'
        : '';
      var initial = (ch.name || '?').charAt(0).toUpperCase();

      html +=
        '<div class="channel' + (i === currentIndex ? ' active' : '') + '"' +
             ' data-index="' + i + '" role="button" tabindex="0">' +
          '<div class="ch-num">' + (i + 1) + '</div>' +
          '<div class="ch-logo" data-initial="' + escapeAttr(initial) + '">' +
            (ch.logo
              ? '<img src="' + escapeAttr(ch.logo) + '" alt="" loading="lazy" decoding="async">'
              : escapeHtml(initial)) +
          '</div>' +
          '<div class="ch-info">' +
            '<div class="ch-name">' + escapeHtml(ch.name) + ' ' + dot + '</div>' +
            '<div class="ch-group">' + escapeHtml(ch.group) + '</div>' +
          '</div>' +
          '<button type="button" class="ch-fav' + (isFav ? ' on' : '') + '"' +
                  ' data-fav="' + escapeAttr(key) + '"' +
                  ' aria-label="' + (isFav ? 'Remove from favorites' : 'Add to favorites') + '">' +
            (isFav ? '★' : '☆') +
          '</button>' +
        '</div>';
    }
    list.innerHTML = html;
  }

  /* ---------- Delegated events on the list ---------- */
  list.addEventListener('click', function (e) {
    var favBtn = e.target.closest('.ch-fav');
    if (favBtn) {
      e.stopPropagation();
      toggleFav(favBtn.dataset.fav);
      return;
    }
    var row = e.target.closest('.channel');
    if (row) play(parseInt(row.dataset.index, 10));
  });

  list.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var row = e.target.closest('.channel');
    if (!row || e.target.closest('.ch-fav')) return;
    e.preventDefault();
    play(parseInt(row.dataset.index, 10));
  });

  /* Logo fallback — capture phase, because error does not bubble */
  list.addEventListener('error', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    var box = img.parentElement;
    if (box && box.classList.contains('ch-logo')) {
      box.textContent = box.dataset.initial || '?';
    }
  }, true);

  function toggleFav(key) {
    if (!key) return;
    if (favs.has(key)) favs.delete(key); else favs.add(key);
    saveProfiles();
    updateCounts();
    applyFilter();
  }

  /* ================= PLAYBACK ================= */
  function play(i) {
    if (i < 0 || i >= filtered.length) return;
    var ch = filtered[i];
    if (!ch.url) return;

    currentIndex = i;
    renderList();

    var active = list.querySelector('.channel.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    placeholder.style.display = 'none';
    $('np-title').textContent = ch.name;
    $('np-group').textContent = ch.group;
    $('download').disabled = false;
    setStatus('Playing: ' + ch.name, '');

    stopPlayback();

    var src = ch.url;

    if (/\.m3u8($|\?)/i.test(src)) {
      if (window.Hls && Hls.isSupported()) {
        hls = new Hls({
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          capLevelToPlayerSize: true,
          enableWorker: true
        });
        hls.loadSource(src);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, function () {
          $('quality').disabled = false;
          video.play().catch(function () {});
        });

        hls.on(Hls.Events.ERROR, function (_, data) {
          if (!data.fatal) return;
          setStream(ch.url, 'dead');
          renderList();
          toast('Stream error: ' + data.type, 'error');
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        video.play().catch(function () {});
      } else {
        toast('HLS not supported in this browser', 'error');
      }
    } else {
      video.src = src;
      video.play().catch(function () {});
    }
  }

  function stopPlayback() {
    tearingDown = true;
    if (hls) { hls.destroy(); hls = null; }
    video.pause();
    video.removeAttribute('src');
    video.load();
    $('quality').disabled = true;
    tearingDown = false;
  }

  video.addEventListener('playing', function () {
    var ch = currentChannel();
    if (!ch) return;
    if (getStream(ch.url) !== 'ok') {
      setStream(ch.url, 'ok');
      renderList();
    }
  });

  video.addEventListener('error', function () {
    if (tearingDown) return;
    var ch = currentChannel();
    if (!ch || (!video.currentSrc && !hls)) return;
    setStream(ch.url, 'dead');
    renderList();
  });

  function next() {
    if (filtered.length === 0) return;
    play((currentIndex + 1) % filtered.length);
  }
  function prev() {
    if (filtered.length === 0) return;
    play((currentIndex - 1 + filtered.length) % filtered.length);
  }

  /* ================= DOWNLOAD ================= */
  function download() {
    var ch = currentChannel();
    if (!ch) return;

    if (/\.(mp4|mkv|webm|mov)($|\?)/i.test(ch.url)) {
      /* Note: the download attribute is ignored cross-origin.
         This navigates to the file; the server must send
         Content-Disposition: attachment for a true download. */
      var a = document.createElement('a');
      a.href = ch.url;
      a.download = ch.name + '.mp4';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Opening file…');
      return;
    }

    if (typeof MediaRecorder === 'undefined' || !video.captureStream) {
      toast('Download not supported for this stream', 'error');
      return;
    }

    try {
      var stream = video.captureStream();
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      recordChunks = [];

      mediaRecorder.ondataavailable = function (e) {
        if (e.data.size) recordChunks.push(e.data);
      };

      mediaRecorder.onstop = function () {
        var blob = new Blob(recordChunks, { type: 'video/webm' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = ch.name + '.webm';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        hideDownloadBar();
      };

      mediaRecorder.start(1000);
      showDownloadBar(ch.name);
      setStatus('Recording…', 'loading');
    } catch (e) {
      toast('Recording failed: ' + e.message, 'error');
    }
  }

  function showDownloadBar(name) {
    $('dl-title').textContent = 'Recording: ' + name;
    $('dl-status').textContent = 'Recording in real-time…';
    $('dl-fill').style.width = '100%';
    $('download-bar').classList.add('visible');
  }
  function hideDownloadBar() {
    $('download-bar').classList.remove('visible');
    $('dl-fill').style.width = '0%';
  }
  function cancelDownload() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    hideDownloadBar();
    setStatus('', '');
  }

  /* ================= UI HELPERS ================= */
  function setStatus(text, state) {
    $('status-text').textContent = text;
    $('status-dot').className = 'status-dot' + (state ? ' ' + state : '');
  }

  function enableControls(on) {
    $('prev').disabled = !on;
    $('next').disabled = !on;
  }

  var toastTimer;
  function toast(msg, kind) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3000);
  }

  /* ================= EVENTS ================= */
  $('tabs').addEventListener('click', function (e) {
    var btn = e.target.closest('.tab');
    if (!btn) return;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    currentTab = btn.dataset.tab;
    currentIndex = -1;
    applyFilter();
  });

  $('search').addEventListener('input', function (e) {
    query = e.target.value.trim();
    currentIndex = -1;
    applyFilter();
  });

  $('prev').addEventListener('click', prev);
  $('next').addEventListener('click', next);
  $('download').addEventListener('click', download);
  $('dl-cancel').addEventListener('click', cancelDownload);

  $('hide-offline').addEventListener('change', function (e) {
    hideOffline = e.target.checked;
    try { localStorage.setItem('hideOffline', hideOffline); } catch (err) {}
    applyFilter();
  });

  $('profile-select').addEventListener('change', function (e) {
    switchProfile(e.target.value);
  });

  /* ---------- Modal ---------- */
  function openModal() {
    lastFocused = document.activeElement;
    modalInput.value = '';
    modal.classList.add('visible');
    setTimeout(function () { modalInput.focus(); }, 50);
  }

  function closeModal() {
    modal.classList.remove('visible');
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  $('profile-new').addEventListener('click', openModal);
  $('modal-cancel').addEventListener('click', closeModal);

  $('modal-create').addEventListener('click', function () {
    createProfile(modalInput.value);
    closeModal();
  });

  modalInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      createProfile(modalInput.value);
      closeModal();
    }
  });

  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal();
  });

  $('profile-delete').addEventListener('click', function () {
    deleteProfile(currentProfileId);
  });

  /* ---------- Quality ---------- */
  $('quality').addEventListener('change', function (e) {
    if (!hls || !hls.levels || !hls.levels.length) return;

    var q = e.target.value;
    if (q === 'auto') {
      hls.currentLevel = -1;
      return;
    }

    var target = parseInt(q, 10);
    var idx = -1;
    for (var i = 0; i < hls.levels.length; i++) {
      if (hls.levels[i].height <= target) { idx = i; break; }
    }
    if (idx < 0) idx = hls.levels.length - 1;
    hls.currentLevel = idx;
  });

  /* ---------- Global keyboard ---------- */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal.classList.contains('visible')) {
      closeModal();
      return;
    }
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (modal.classList.contains('visible')) return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); next(); }
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { e.preventDefault(); prev(); }
  });

  /* ---------- Persistence ---------- */
  window.addEventListener('pagehide', function () {
    saveProfiles();
    persistStatus();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { saveProfiles(); persistStatus(); }
  });

  /* ================= START ================= */
  $('hide-offline').checked = hideOffline;

  loadProfiles();
  renderProfileSelect();
  loadCachedStatus();
  loadAll();

})();