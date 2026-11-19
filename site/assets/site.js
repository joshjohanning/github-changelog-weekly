(function () {
  'use strict';

  var KEY = 'changelog-weekly-theme';
  var THEMES = ['auto', 'light', 'dark'];
  var root = document.documentElement;

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-color-mode', theme);
  }

  var select = document.getElementById('theme-select');
  if (!select) return;

  var current = 'auto';
  try {
    var stored = localStorage.getItem(KEY);
    if (THEMES.indexOf(stored) !== -1) current = stored;
  } catch (e) { /* storage unavailable */ }
  select.value = current;

  select.addEventListener('change', function () {
    var theme = THEMES.indexOf(select.value) === -1 ? 'auto' : select.value;
    apply(theme);
    try { localStorage.setItem(KEY, theme); } catch (e) { /* storage unavailable */ }
  });

  var active = document.querySelector('.sidebar a[aria-current="page"]');
  if (active) active.scrollIntoView({ block: 'center' });
})();
