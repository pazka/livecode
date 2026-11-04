// livecode preview frame bootstrap. This document is loaded in an iframe sandboxed without
// allow-same-origin (opaque origin). It asks the editor for the page, then replaces itself with it.
// One frame renders one version: the editor creates a fresh frame for every refresh.
"use strict";
(function () {
  var done = false;
  window.addEventListener("message", function (e) {
    if (done || e.source !== window.parent || !e.data || e.data.__lc !== 1 || e.data.type !== "render") return;
    done = true;
    document.open();
    document.write(String(e.data.html));
    document.close();
  });
  window.parent.postMessage({ __lc: 1, type: "ready" }, "*");
})();
