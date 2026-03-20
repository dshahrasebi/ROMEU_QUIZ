/* public/lang.js — client i18n helpers: window.t(), window.applyI18n() */
(function () {
  'use strict';

  window._lang = 'en';

  /**
   * Translate a key, optionally substituting {placeholder} variables.
   * Falls back to the 'en' locale, then to the raw key.
   */
  window.t = function (key, vars) {
    const dict = (window.I18N || {})[window._lang] || {};
    const fallback = (window.I18N || {}).en || {};
    let str = (key in dict) ? dict[key] : (fallback[key] !== undefined ? fallback[key] : key);
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
      });
    }
    return str;
  };

  /**
   * Set the active language and re-translate every marked element in the DOM.
   * Elements can carry:
   *   data-i18n             → textContent
   *   data-i18n-html        → innerHTML  (use only for trusted static strings)
   *   data-i18n-placeholder → input/textarea placeholder
   *   data-i18n-title       → title attribute
   */
  window.applyI18n = function (lang) {
    window._lang = lang || 'en';
    document.documentElement.lang = window._lang;

    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = window.t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = window.t(el.dataset.i18nHtml);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.placeholder = window.t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.title = window.t(el.dataset.i18nTitle);
    });
  };
}());
