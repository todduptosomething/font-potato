'use strict';
// Analytics consent. Google Analytics is deliberately NOT in index.html —
// the tag only ever reaches the page through loadAnalytics() below, and only
// after someone has actively said yes. Someone who declines, or who simply
// never answers, gets no Google cookie and no request made in their name.
//
// Not a module: this has to run before anything else paints so the banner
// doesn't pop in late, and it must not depend on the engine loading. It has
// no imports for the same reason.

(function () {
  const KEY = 'fp-analytics-consent';   // 'granted' | 'denied'
  const GA_ID = 'G-5BETCLFHKE';

  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };

  let loaded = false;
  function loadAnalytics() {
    if (loaded) return;
    loaded = true;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag('js', new Date());
    // No cookie is written until this point, so a first page_view here is the
    // first thing Google ever hears about this visitor.
    gtag('config', GA_ID);
  }

  function hide() {
    const el = document.getElementById('cookieBar');
    if (el) el.hidden = true;
  }

  // Declining has to clear the cookies Google already set, not just stop
  // setting new ones — anyone who visited before this banner existed (or who
  // agreed and later changed their mind) is still carrying a _ga identifier,
  // and leaving it in place would make "no thanks" a lie. Expiring a cookie
  // requires matching the domain and path it was written with, and GA writes
  // to the registrable domain, so try the bare host and each parent domain.
  function clearGaCookies() {
    const names = document.cookie.split(';')
      .map((c) => c.split('=')[0].trim())
      .filter((n) => /^_ga/.test(n) || n === '_gid');
    const host = location.hostname;
    const parts = host.split('.');
    const domains = [''];
    for (let i = 0; i < parts.length - 1; i++) domains.push('; domain=.' + parts.slice(i).join('.'));
    for (const n of names) {
      for (const d of domains) {
        document.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + d;
      }
    }
  }

  function decide(choice) {
    write(choice);
    hide();
    if (choice === 'granted') { loadAnalytics(); return; }
    clearGaCookies();
    // A tag already running in this tab can't be unloaded — only a reload
    // actually stops it reporting, so do that rather than let the page keep
    // sending events after someone just said no.
    if (loaded) location.reload();
  }

  function wire() {
    const bar = document.getElementById('cookieBar');
    if (!bar) return;
    document.getElementById('cookieYes').addEventListener('click', () => decide('granted'));
    document.getElementById('cookieNo').addEventListener('click', () => decide('denied'));

    const saved = read();
    if (saved === 'granted') loadAnalytics();
    else if (saved !== 'denied') bar.hidden = false;   // never asked yet

    // Lets someone change their mind later — the menu links to this.
    const reopen = document.getElementById('cookieReopen');
    if (reopen) reopen.addEventListener('click', (e) => { e.preventDefault(); bar.hidden = false; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
