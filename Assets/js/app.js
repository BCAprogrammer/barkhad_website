(function () {
  'use strict';

  var reduceMotion  = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarsePointer = window.matchMedia('(hover: none), (pointer: coarse)').matches;
  var canHover      = !reduceMotion && !coarsePointer;

  /* ------------------------------------------------------------------
     Image fallbacks — replaces the old inline onerror="" attributes
     ------------------------------------------------------------------ */
  Array.prototype.forEach.call(
    document.querySelectorAll('img[data-fallback]'),
    function (img) {
      img.addEventListener('error', function () { img.remove(); }, { once: true });
    }
  );

  /* ------------------------------------------------------------------
     Platform switch — hide the Android APK button on iOS
     ------------------------------------------------------------------ */
  var isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (isIOS) {
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-android]'),
      function (el) { el.hidden = true; }
    );
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-ios]'),
      function (el) { el.hidden = false; }
    );
  }

  /* ------------------------------------------------------------------
     Cursor glow — rAF loop parks itself when the pointer settles
     ------------------------------------------------------------------ */
  if (canHover) {
    var glow = document.querySelector('.cursor-glow');

    if (glow) {
      var x = window.innerWidth / 2;
      var y = window.innerHeight / 2;
      var tx = x;
      var ty = y;
      var running = false;

      var tick = function () {
        x += (tx - x) * 0.12;
        y += (ty - y) * 0.12;
        glow.style.transform =
          'translate(' + x + 'px,' + y + 'px) translate(-50%,-50%)';

        if (Math.abs(tx - x) < 0.1 && Math.abs(ty - y) < 0.1) {
          running = false;
          return;
        }
        requestAnimationFrame(tick);
      };

      var start = function () {
        if (running) return;
        running = true;
        requestAnimationFrame(tick);
      };

      window.addEventListener('mousemove', function (e) {
        tx = e.clientX;
        ty = e.clientY;
        glow.classList.add('on');
        start();
      }, { passive: true });

      window.addEventListener('mouseleave', function () {
        glow.classList.remove('on');
      });

      start();
    }
  }

  /* ------------------------------------------------------------------
     Scroll reveal
     ------------------------------------------------------------------ */
  var revealEls = document.querySelectorAll('.reveal, .reveal-stagger');

  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });

    Array.prototype.forEach.call(revealEls, function (el) { io.observe(el); });
  } else {
    Array.prototype.forEach.call(revealEls, function (el) {
      el.classList.add('is-visible');
    });
  }

  /* ------------------------------------------------------------------
     Sticky nav shading + scroll-spy
     ------------------------------------------------------------------ */
  var nav = document.getElementById('nav');
  var navLinks = document.querySelectorAll('.nav-links a[data-nav]');
  var sections = ['tv', 'apps', 'about', 'feedback']
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);

  if (nav && 'IntersectionObserver' in window && sections.length) {
    var navIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var id = entry.target.id;
        Array.prototype.forEach.call(navLinks, function (a) {
          a.classList.toggle('active', a.dataset.nav === id);
        });
      });
    }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });

    sections.forEach(function (s) { navIo.observe(s); });
  }

  if (nav) {
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        nav.classList.toggle('scrolled', window.scrollY > 20);
        ticking = false;
      });
    }, { passive: true });
  }

  /* ------------------------------------------------------------------
     Featured-card pointer tilt
     ------------------------------------------------------------------ */
  if (canHover) {
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-tilt]'),
      function (card) {
        var img = card.querySelector('.featured-image img');
        if (!img) return;

        card.addEventListener('mousemove', function (e) {
          var r = card.getBoundingClientRect();
          var px = (e.clientX - r.left) / r.width - 0.5;
          var py = (e.clientY - r.top) / r.height - 0.5;
          img.style.transform =
            'scale(1.08) translate(' + (px * -12) + 'px,' + (py * -12) + 'px)';
        });

        card.addEventListener('mouseleave', function () {
          img.style.transform = '';
        });
      }
    );
  }

})();