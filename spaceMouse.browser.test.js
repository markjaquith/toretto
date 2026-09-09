import assert from "node:assert/strict";
import test from "node:test";
import puppeteer from "puppeteer-core";

const url = new URL(process.env.TORETTO_TEST_URL || "http://127.0.0.1:4178");
const connectedStatus = "3Dconnexion driver connected. Focus the canvas and move the SpaceMouse to confirm input.";

// Only the browser's network boundary is faked; transport, driver, hook and React are real.
async function openPage(browser, options = {}) {
  const page = await browser.newPage();
  const unexpectedRequests = [];
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (["http:", "https:"].includes(target.protocol) && target.origin !== url.origin) {
      unexpectedRequests.push(request.url());
      void request.abort();
    } else {
      void request.continue();
    }
  });
  await page.evaluateOnNewDocument(({ pendingDiscovery = false, hidScenario = "empty" }) => {
    const nativeFetch = window.fetch.bind(window);
    const NativeWebSocket = window.WebSocket;
    const state = window.spaceMouseTest = {
      discoveries: [], sockets: [], unexpected: [], hidEnumerations: 0,
    };
    const hid = new EventTarget();
    hid.getDevices = async () => {
      state.hidEnumerations += 1;
      if (hidScenario === "denied") throw new Error("Permission policy blocked enumeration");
      return [];
    };
    Object.defineProperty(navigator, "hid", {
      configurable: true, value: hidScenario === "unavailable" ? undefined : hid,
    });
    window.fetch = (input, init = {}) => {
      const target = new URL(input instanceof Request ? input.url : input, location.href);
      if (target.origin === location.origin) return nativeFetch(input, init);
      if (target.href !== "https://127.51.68.120:8181/3dconnexion/nlproxy") {
        state.unexpected.push(target.href);
        return Promise.reject(new Error("Unexpected external fetch"));
      }
      const request = { url: target.href, init, jsonReads: 0 };
      state.discoveries.push(request);
      return new Promise((resolve) => {
        request.resolve = () => resolve({
          ok: true,
          json: async () => { request.jsonReads += 1; return { port: 8182 }; },
        });
        // Deliberately ignore abort here so cancellation must also guard late results.
        if (!pendingDiscovery || state.discoveries.length > 1) request.resolve();
      });
    };
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      onopen = null;
      onmessage = null;
      onerror = null;
      onclose = null;

      constructor(address, protocol) {
        super();
        const target = new URL(address, location.href);
        if (target.host === location.host && protocol === "vite-hmr") {
          return new NativeWebSocket(address, protocol);
        }
        if (target.href !== "wss://127.51.68.120:8182/" || protocol !== "wamp") {
          state.unexpected.push(String(address));
          throw new Error("Unexpected WebSocket endpoint or protocol");
        }
        this.url = target.href;
        this.protocol = protocol;
        this.messages = [];
        this.updates = [];
        this.subscriptions = [];
        this.pending = new Map();
        this.sequence = 0;
        state.sockets.push(this);
        state.server = this;
        queueMicrotask(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          this.emit(new Event("open"));
          this.deliver([0, `session-${state.sockets.length}`, 1, "test-3DxNLServer"]);
        });
      }

      emit(event) {
        this.dispatchEvent(event);
        this[`on${event.type}`]?.(event);
      }

      deliver(message) {
        this.emit(new MessageEvent("message", { data: JSON.stringify(message) }));
      }

      send(text) {
        if (this.readyState !== 1) throw new Error("Socket is not open");
        const message = JSON.parse(text);
        this.messages.push(message);
        const [type, id, procedure, resource, properties] = message;
        if (type === 1) return;
        if (type === 5) { this.subscriptions.push(id); return; }
        if (type === 3 || type === 4) {
          const pending = this.pending.get(id);
          if (!pending) throw new Error("Reply without a server request");
          this.pending.delete(id);
          clearTimeout(pending.timer);
          if (type === 3) pending.resolve(message[2]);
          else pending.reject(new Error(message[3]));
          return;
        }
        if (type !== 2) throw new Error("Unexpected WAMP message");
        let result = null;
        if (procedure === "3dx_rpc:create") {
          if (resource === "3dconnexion:3dmouse") result = { connexion: 2 };
          else if (resource === "3dconnexion:3dcontroller") result = { instance: 1 };
          else throw new Error("Unexpected resource");
        } else if (procedure === "3dx_rpc:update") {
          if (resource !== "3dconnexion:3dcontroller/1") throw new Error("Wrong controller");
          this.updates.push(properties);
          if ("focus" in properties) this.focused = properties.focus;
        } else if (procedure !== "3dx_rpc:delete") {
          throw new Error("Unexpected RPC procedure");
        }
        queueMicrotask(() => {
          if (this.readyState === 1) this.deliver([3, id, result]);
        });
      }

      request(procedure, property, ...values) {
        if (this.readyState !== 1 || !this.subscriptions.includes("3dconnexion:3dcontroller/1")) {
          return Promise.reject(new Error("Controller is not subscribed"));
        }
        return new Promise((resolve, reject) => {
          const id = `server-${++this.sequence}`;
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`No WAMP reply for ${property}`));
          }, 2000);
          this.pending.set(id, { resolve, reject, timer });
          this.deliver([8, "3dconnexion:3dcontroller/1", [2, id, procedure, "toretto", property, ...values]]);
        });
      }

      sendRead(property) { return this.request("self:read", property); }
      sendUpdate(property, value) { return this.request("self:update", property, value); }

      close() {
        this.readyState = 3;
        queueMicrotask(() => this.emit(new CloseEvent("close")));
      }
    };
  }, options);
  await page.goto(url.href);
  await page.waitForSelector(".spatializer-camera");
  await paint(page);
  return { page, unexpectedRequests };
}

async function click(page, name) {
  await page.waitForFunction((label) => [...document.querySelectorAll("button")]
    .some((button) => button.textContent.trim() === label && !button.disabled), {}, name);
  const button = await page.evaluateHandle((label) => [...document.querySelectorAll("button")]
    .find((candidate) => candidate.textContent.trim() === label), name);
  try { await button.click(); } finally { await button.dispose(); }
}

async function status(page, text) {
  try {
    await page.waitForFunction((expected) => document.querySelector('[role="status"]')?.textContent === expected, {}, text);
  } catch (cause) {
    const actual = await page.evaluate(() => ({
      status: document.querySelector('[role="status"]')?.textContent,
      unexpected: window.spaceMouseTest.unexpected,
      sockets: window.spaceMouseTest.sockets.map((socket) => ({
        readyState: socket.readyState, messages: socket.messages,
      })),
    }));
    throw new Error(`Expected status ${JSON.stringify(text)}; browser state: ${JSON.stringify(actual)}`, { cause });
  }
}

async function paint(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("SpaceMouse is visible without hardware and makes no driver or third-party requests before click", async () => {
  const browser = await puppeteer.launch({ channel: "chrome", headless: true });
  try {
    for (const hidScenario of ["empty", "unavailable", "denied"]) {
      const { page, unexpectedRequests } = await openPage(browser, { hidScenario });
      try {
        assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].some((button) =>
          button.textContent.trim() === "SpaceMouse" && !button.disabled && button.getBoundingClientRect().width > 0)), true, hidScenario);
        assert.deepEqual(await page.evaluate(() => ({
          discoveries: window.spaceMouseTest.discoveries.length,
          sockets: window.spaceMouseTest.sockets.length,
          hid: window.spaceMouseTest.hidEnumerations,
          unexpected: window.spaceMouseTest.unexpected,
          sdk: typeof window._3Dconnexion,
        })), { discoveries: 0, sockets: 0, hid: 0, unexpected: [], sdk: "undefined" });
        assert.equal(await page.$('[role="status"]'), null);
        assert.deepEqual(unexpectedRequests, []);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});

test("local WAMP controller confirms input and preserves camera commands, focus and dialog guards", async () => {
  const browser = await puppeteer.launch({ channel: "chrome", headless: true });
  try {
    const { page, unexpectedRequests } = await openPage(browser);
    await click(page, "SpaceMouse");
    await status(page, connectedStatus);
    assert.deepEqual(await page.evaluate(() => {
      const { discoveries, server } = window.spaceMouseTest;
      return {
        discovery: discoveries.map(({ url, init }) => ({ url, credentials: init.credentials, redirect: init.redirect, referrerPolicy: init.referrerPolicy })),
        socket: [server.url, server.protocol],
        prefixes: server.messages.filter(([type]) => type === 1),
        creates: server.messages.filter((message) => message[2] === "3dx_rpc:create").map((message) => message.slice(2)),
        subscriptions: server.subscriptions,
        timing: server.updates.some((update) => update.frame?.timingSource === 1),
        focused: server.focused,
      };
    }), {
      discovery: [{ url: "https://127.51.68.120:8181/3dconnexion/nlproxy", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }],
      socket: ["wss://127.51.68.120:8182/", "wamp"],
      prefixes: [[1, "3dx_rpc", "wss://127.51.68.120/3dconnexion#"], [1, "3dconnexion", "wss://127.51.68.120/3dconnexion"], [1, "self", `${url.origin}/`]],
      creates: [["3dx_rpc:create", "3dconnexion:3dmouse", "0.7.0"], ["3dx_rpc:create", "3dconnexion:3dcontroller", 2, { version: 0.7, name: "Toretto", rowMajorOrder: false }]],
      subscriptions: ["3dconnexion:3dcontroller/1"], timing: true, focused: true,
    });
    assert.equal(await page.evaluate(() => window.spaceMouseTest.server.sendUpdate("motion", true)), null);
    await status(page, "SpaceMouse input confirmed.");
    await page.waitForFunction(() => window.spaceMouseTest.server.updates.some((update) => Number.isFinite(update.frame?.time)));
    assert.equal(await page.evaluate(() => window.spaceMouseTest.server.sendUpdate("motion", false)), null);
    const frames = await page.evaluate(() => window.spaceMouseTest.server.updates.filter((update) => "time" in (update.frame || {})).length);
    await paint(page);
    assert.equal(await page.evaluate(() => window.spaceMouseTest.server.updates.filter((update) => "time" in (update.frame || {})).length), frames, "motion false stops frame updates");
    await status(page, "SpaceMouse input confirmed.");

    for (const command of ["Reset", "Center", "Fit"]) {
      const focusCount = await page.evaluate(() => window.spaceMouseTest.server.updates.filter((update) => update.focus === true).length);
      await click(page, command);
      await page.waitForFunction(() => ![...document.querySelectorAll("button")]
        .some((button) => ["Center", "Fit"].includes(button.textContent.trim()) && button.disabled));
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".spatializer-camera")), true, `${command} returns canvas focus`);
      assert.equal(await page.evaluate((count) => window.spaceMouseTest.server.focused &&
        window.spaceMouseTest.server.updates.filter((update) => update.focus === true).length > count, focusCount), true, `${command} reclaims driver focus through WAMP`);
      const before = await page.$eval(".spatializer-stage", (element) => element.style.transform);
      await page.evaluate(async () => {
        const server = window.spaceMouseTest.server;
        const matrix = await server.sendRead("view.affine");
        matrix[12] += 40;
        await server.sendUpdate("transaction", 1);
        await server.sendUpdate("view.affine", matrix);
        await server.sendUpdate("transaction", 0);
      });
      await page.waitForFunction((previous) => document.querySelector(".spatializer-stage").style.transform !== previous, {}, before);
      assert.equal(await page.evaluate(() => window.spaceMouseTest.server.sendRead("view.constructionPlane")), null);
      assert.equal(await page.evaluate(() => window.spaceMouseTest.server.sendRead("view.rotatable")), true);
      const beforeRotation = await page.$eval(".spatializer-world", (element) => element.style.transform);
      await page.evaluate(async () => {
        const server = window.spaceMouseTest.server;
        const matrix = await server.sendRead("view.affine");
        const c = Math.cos(Math.PI / 8), s = Math.sin(Math.PI / 8);
        for (let column = 0; column < 4; column++) {
          const x = matrix[column * 4], z = matrix[column * 4 + 2];
          matrix[column * 4] = c * x + s * z;
          matrix[column * 4 + 2] = -s * x + c * z;
        }
        await server.sendUpdate("transaction", 1);
        await server.sendUpdate("view.affine", matrix);
        await server.sendUpdate("transaction", 0);
      });
      await page.waitForFunction((previous) => document.querySelector(".spatializer-world").style.transform !== previous, {}, beforeRotation);
      assert.deepEqual(await page.evaluate(() => [window.spaceMouseTest.discoveries.length, window.spaceMouseTest.sockets.length]), [1, 1], `${command} does not reconnect`);
    }

    await click(page, "Open…");
    await page.waitForSelector('[role="dialog"]');
    await page.waitForFunction(() => window.spaceMouseTest.server.focused === false);
    const before = await page.$eval(".spatializer-stage", (element) => element.style.transform);
    await page.evaluate(async () => {
      const server = window.spaceMouseTest.server;
      const matrix = await server.sendRead("view.affine");
      matrix[12] += 40;
      await server.sendUpdate("view.affine", matrix);
    });
    await paint(page);
    assert.equal(await page.$eval(".spatializer-stage", (element) => element.style.transform), before, "source dialog blocks WAMP navigation");
    assert.deepEqual(await page.evaluate(() => window.spaceMouseTest.unexpected), []);
    assert.deepEqual(unexpectedRequests, []);
  } finally { await browser.close(); }
});

test("pending discovery can be cancelled and retried without reviving late discovery or socket events", async () => {
  const browser = await puppeteer.launch({ channel: "chrome", headless: true });
  try {
    const { page, unexpectedRequests } = await openPage(browser, { pendingDiscovery: true });
    await click(page, "SpaceMouse");
    await status(page, "Connecting to 3Dconnexion driver...");
    assert.deepEqual(await page.evaluate(() => [window.spaceMouseTest.discoveries.length, window.spaceMouseTest.sockets.length]), [1, 0]);
    await click(page, "Cancel SpaceMouse");
    await status(page, "SpaceMouse disconnected.");
    assert.equal(await page.evaluate(() => window.spaceMouseTest.discoveries[0].init.signal.aborted), true);
    await click(page, "SpaceMouse");
    await status(page, connectedStatus);
    await page.evaluate(() => window.spaceMouseTest.discoveries[0].resolve());
    await paint(page);
    assert.deepEqual(await page.evaluate(() => [window.spaceMouseTest.discoveries.length, window.spaceMouseTest.sockets.length, window.spaceMouseTest.discoveries[0].jsonReads]), [2, 1, 0], "late discovery does not create a socket");
    await status(page, connectedStatus);

    await click(page, "SpaceMouse");
    await status(page, "SpaceMouse disconnected.");
    assert.deepEqual(await page.evaluate(() => {
      const socket = window.spaceMouseTest.sockets[0];
      return { closed: socket.readyState, deletes: socket.messages.filter((message) => message[2] === "3dx_rpc:delete").map((message) => message[3]) };
    }), { closed: 3, deletes: ["3dconnexion:3dcontroller/1", "3dconnexion:3dmouse/2"] });
    await click(page, "SpaceMouse");
    await status(page, connectedStatus);
    await page.evaluate(() => {
      const old = window.spaceMouseTest.sockets[0];
      old.deliver([0, "late-welcome", 1, "test-3DxNLServer"]);
      old.deliver([8, "3dconnexion:3dcontroller/1", [2, "late-motion", "self:update", "toretto", "motion", true]]);
      old.emit(new Event("error"));
      old.emit(new CloseEvent("close"));
    });
    await paint(page);
    await status(page, connectedStatus);
    assert.deepEqual(await page.evaluate(() => [window.spaceMouseTest.discoveries.length, window.spaceMouseTest.sockets.length, window.spaceMouseTest.server.readyState]), [3, 2, 1]);
    await page.evaluate(async () => {
      await window.spaceMouseTest.server.sendUpdate("motion", true);
      await window.spaceMouseTest.server.sendUpdate("motion", false);
    });
    await status(page, "SpaceMouse input confirmed.");
    assert.deepEqual(await page.evaluate(() => window.spaceMouseTest.unexpected), []);
    assert.deepEqual(unexpectedRequests, []);
  } finally { await browser.close(); }
});

test("drag completion and cancellation restore eligible SpaceMouse focus", async () => {
  const browser = await puppeteer.launch({ channel: "chrome", headless: true });
  try {
    const { page } = await openPage(browser);
    await page.setViewport({ width: 1440, height: 1000 });
    await paint(page);
    await click(page, "SpaceMouse");
    await status(page, connectedStatus);
    for (const selector of [".spatializer-camera", ".spatializer-gizmo-center", '[aria-label="Canvas zoom"]']) {
      for (const cancel of [false, true]) {
        const label = `${selector} ${cancel ? "cancel" : "release"}`;
        await page.$eval(".spatializer-camera", element => element.focus());
        const target = await page.$(selector);
        const bounds = await target.boundingBox();
        assert.ok(bounds, `${label}: drag target is visible`);
        await target.evaluate(element => {
          element.addEventListener("pointerdown", event => { window.dragPointerId = event.pointerId; }, { once: true });
        });
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await page.evaluate(() => window.spaceMouseTest.server.sendUpdate("motion", true));
        await paint(page);
        assert.equal(await page.evaluate(() => window.spaceMouseTest.server.focused), false, `${label}: blocked during drag`);
        const before = await page.$eval(".spatializer-stage", element => element.style.transform);
        await page.evaluate(async () => {
          const server = window.spaceMouseTest.server;
          const matrix = await server.sendRead("view.affine");
          matrix[12] += 40;
          await server.sendUpdate("view.affine", matrix);
        });
        await paint(page);
        assert.equal(await page.$eval(".spatializer-stage", element => element.style.transform), before, `${label}: camera write blocked`);
        const range = selector.includes("Canvas zoom");
        if (cancel) {
          await target.evaluate(element => element.dispatchEvent(new PointerEvent("pointercancel", {
            bubbles: true, pointerId: window.dragPointerId,
          })));
          await paint(page);
          assert.equal(await page.evaluate(() => window.spaceMouseTest.server.focused), !range, `${label}: cancellation restores eligible focus before pointerup`);
        }
        await page.mouse.up();
        await paint(page);
        assert.equal(await page.evaluate(() => window.spaceMouseTest.server.focused), !range, `${label}: driver focus follows eligible canvas`);
        if (range) {
          assert.equal(await target.evaluate(element => document.activeElement === element), true, `${label}: range retains keyboard focus`);
          await page.$eval(".spatializer-camera", element => element.focus());
        }
        await page.evaluate(async () => {
          const server = window.spaceMouseTest.server;
          if (!server.focused) throw new Error("Driver is still unfocused");
          await server.sendUpdate("motion", true);
          const matrix = await server.sendRead("view.affine");
          matrix[12] += 40;
          await server.sendUpdate("transaction", 1);
          await server.sendUpdate("view.affine", matrix);
          await server.sendUpdate("transaction", 0);
          await server.sendUpdate("motion", false);
        });
        await page.waitForFunction(previous => document.querySelector(".spatializer-stage").style.transform !== previous, {}, before);
        await target.dispose();
      }
    }
    assert.deepEqual(await page.evaluate(() => [window.spaceMouseTest.discoveries.length, window.spaceMouseTest.sockets.length]), [1, 1]);
  } finally { await browser.close(); }
});
