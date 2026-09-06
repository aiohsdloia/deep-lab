// Minimal CDP driver for the DeepLab WebView2 (raw, no deps).
//   env CDP_WS = page websocket debugger url
//   node cdp.mjs eval "<js>"          -> JSON result of Runtime.evaluate (awaitPromise)
//   node cdp.mjs text                 -> document.body.innerText
//   node cdp.mjs wait "<selector>" [ms] -> resolve {found,count} once element present
//   node cdp.mjs click "<selector>"   -> click first match via JS
//   node cdp.mjs fill "<selector>" "<value>" -> set value + dispatch input
const url = process.env.CDP_WS;
if (!url) {
  console.error("set CDP_WS");
  process.exit(2);
}
const [cmd, a, b] = process.argv.slice(2);

async function send(ws, id, method, params) {
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
  });
}

const js = {
  eval: `async () => ${a}`,
  text: `() => document.body ? (document.body.textContent || "").slice(0, 8000) : ""`,
  wait: `(sel) => new Promise((res) => { const t0 = Date.now(); const iv = setInterval(() => { const el = document.querySelector(sel); if (el || Date.now() - t0 > ${Number(b) || 15000}) { clearInterval(iv); res(el ? {found:true,count:document.querySelectorAll(sel).length} : {found:false}); } }, 200); })`,
  click: `(sel) => { const el = document.querySelector(sel); if (!el) return {ok:false,reason:"no element"}; el.scrollIntoView({block:"center"}); el.click(); return {ok:true}; }`,
  fill: `(sel, val) => { const el = document.querySelector(sel); if (!el) return {ok:false,reason:"no element"}; const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val); el.dispatchEvent(new Event("input", {bubbles:true})); el.dispatchEvent(new Event("change", {bubbles:true})); return {ok:true}; }`,
};

const ws = new WebSocket(url);
const guard = setTimeout(() => {
  console.error("timeout");
  process.exit(1);
}, 25000);
const done = () => {
  clearTimeout(guard);
  ws.close();
};
ws.addEventListener("open", async () => {
  try {
    let result;
    if (cmd === "eval") {
      result = await send(ws, 1, "Runtime.evaluate", {
        expression: `(${js.eval})()`,
        awaitPromise: true,
        returnByValue: true,
      });
      console.log(JSON.stringify(result?.result?.value ?? null));
    } else if (cmd === "text") {
      result = await send(ws, 1, "Runtime.evaluate", {
        expression: `(${js.text})()`,
        returnByValue: true,
      });
      console.log(String(result?.result?.value ?? ""));
    } else if (cmd === "wait") {
      result = await send(ws, 1, "Runtime.evaluate", {
        expression: `(${js.wait})("${String(a).replace(/"/g, '\\"')}")`,
        awaitPromise: true,
        returnByValue: true,
      });
      console.log(JSON.stringify(result?.result?.value ?? { found: false }));
    } else if (cmd === "click") {
      result = await send(ws, 1, "Runtime.evaluate", {
        expression: `(${js.click})("${String(a).replace(/"/g, '\\"')}")`,
        returnByValue: true,
      });
      console.log(JSON.stringify(result?.result?.value ?? { ok: false }));
    } else if (cmd === "fill") {
      result = await send(ws, 1, "Runtime.evaluate", {
        expression: `(${js.fill})("${String(a).replace(/"/g, '\\"')}", ${JSON.stringify(String(b ?? ""))})`,
        returnByValue: true,
      });
      console.log(JSON.stringify(result?.result?.value ?? { ok: false }));
    } else {
      console.error(`unknown command ${cmd}`);
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  } finally {
    done();
  }
});
ws.addEventListener("error", (event) => {
  console.error("ws error");
  process.exitCode = 1;
});
setTimeout(() => {
  console.error("timeout");
  process.exit(1);
}, 20000);
