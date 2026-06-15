// Runs inside the renderer page (via webContents.executeJavaScript). Exercises
// the REAL app.js functions against the mock window.api. Returns a results
// array [{name, pass, detail}]. Uses bare identifiers because app.js is a
// classic script — its top-level const/let/function bindings live in the page's
// global scope.
(async () => {
  const results = [];
  const ok = (name, pass, detail = "") => results.push({ name, pass: !!pass, detail: String(detail) });
  const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const thinkingTab = () => document.querySelector(".popup-tab[data-tab='thinking']");
  const setModelViaPopup = (id) => document.querySelector(`#model-list button[data-value="${id}"]`).click();
  const hasInline = (parts) => (parts || []).some(p => p.inlineData && p.inlineData.data);
  const inlineDatas = (contents) => contents.flatMap(c => (c.parts || []).filter(p => p.inlineData).map(p => p.inlineData.data));

  try {
    // ---- Boot / options ----
    eq("boot: authMode", state.options.authMode, "adc");
    eq("boot: model count", state.options.models.length, 2);
    ok("boot: model popup populated", document.querySelectorAll("#model-list button").length === 2);
    eq("boot: auth pill text", $("auth-mode").textContent, "ADC");

    // ---- Pure helpers ----
    eq("titleFromPrompt: empty", titleFromPrompt("   "), "New chat");
    eq("titleFromPrompt: trim+collapse", titleFromPrompt("  hello   world "), "hello world");
    ok("titleFromPrompt: truncation", titleFromPrompt("x".repeat(80)).length === 49 && titleFromPrompt("x".repeat(80)).endsWith("…"));

    // groupByRecency
    {
      const now = new Date(2026, 5, 13, 12, 0, 0).getTime();
      const day = 86400000;
      const chats = [
        { id: "a", updatedAt: now - 1000 },
        { id: "b", updatedAt: now - (1.5 * day) },
        { id: "c", updatedAt: now - (4 * day) },
        { id: "d", updatedAt: now - (30 * day) },
      ];
      const g = groupByRecency(chats, now);
      ok("groupByRecency: today", g.Today.length === 1 && g.Today[0].id === "a");
      ok("groupByRecency: yesterday", g.Yesterday.length === 1 && g.Yesterday[0].id === "b");
      ok("groupByRecency: last7", g["Last 7 days"].length === 1 && g["Last 7 days"][0].id === "c");
      ok("groupByRecency: older", g.Older.length === 1 && g.Older[0].id === "d");
    }

    // Cost helpers
    eq("formatCost: zero", formatCost(0), "$0.00");
    eq("formatCost: sub-dollar", formatCost(0.1342), "$0.134");
    eq("formatCost: mid", formatCost(12.5), "$12.50");
    eq("formatPerMillion: whole", formatPerMillion(2 / 1e6), "$2");
    eq("formatPerMillion: sub-dollar (Flash input)", formatPerMillion(0.5 / 1e6), "$0.50");
    eq("formatPerMillion: large", formatPerMillion(120 / 1e6), "$120");
    {
      const cost = tokenCost({ promptTokenCount: 10, candidatesTokenCount: 100 }, "gemini-3-pro-image");
      ok("tokenCost: pro math", Math.abs(cost - (10 * 2e-6 + 100 * 120e-6)) < 1e-12, cost);
      eq("tokenCost: no rates -> 0", tokenCost({ promptTokenCount: 10 }, "nonexistent-model"), 0);
    }

    // Dice
    {
      let allLead = true, allDots = true;
      for (let face = 1; face <= 6; face++) {
        const s = genSeedWithLeadingFace(face);
        if (String(s)[0] !== String(face)) allLead = false;
        if (s > 2147483647) allLead = false;
        if ((DICE_DOTS[face] || []).length !== face) allDots = false;
      }
      ok("dice: seed leading digit == face", allLead);
      ok("dice: DICE_DOTS count == face", allDots);
    }

    // EventLogger dedup
    {
      EventLogger.log("dup-test-line");
      EventLogger.log("dup-test-line");
      const logs = EventLogger.getLogs();
      ok("EventLogger: dedup ×2", logs[logs.length - 1].includes("dup-test-line (×2)"), logs[logs.length - 1]);
    }

    // ---- Model switch preserves select values (fillSelect fix) ----
    setModelViaPopup("gemini-3-pro-image");
    $("person_generation").value = "ALLOW_NONE";
    $("prominent_people").value = "BLOCK_PROMINENT_PEOPLE";
    setModelViaPopup("gemini-3.1-flash-image");
    eq("model switch: person_generation preserved", $("person_generation").value, "ALLOW_NONE");
    eq("model switch: prominent_people preserved", $("prominent_people").value, "BLOCK_PROMINENT_PEOPLE");
    eq("flash: thinking tab visible", thinkingTab().hidden, false);
    setModelViaPopup("gemini-3-pro-image");
    eq("pro: thinking tab hidden", thinkingTab().hidden, true);
    eq("pro: person_generation still preserved", $("person_generation").value, "ALLOW_NONE");

    // ---- buildConfig per model ----
    {
      setModelViaPopup("gemini-3-pro-image");
      state.aspect = "auto"; state.imageSize = "2K";
      $("include_text").checked = true;
      $("google_search").checked = false;
      const cfg = buildConfig();
      ok("buildConfig pro: modalities IMAGE+TEXT", JSON.stringify(cfg.responseModalities) === JSON.stringify(["IMAGE", "TEXT"]));
      eq("buildConfig pro: imageSize", cfg.imageConfig.imageSize, "2K");
      ok("buildConfig pro: aspect omitted when auto", cfg.imageConfig.aspectRatio === undefined);
      ok("buildConfig pro: safety covers all harm cats", cfg.safetySettings.length === modelSpec("gemini-3-pro-image").harmCategories.length);
      ok("buildConfig pro: all safety OFF", cfg.safetySettings.every(s => s.threshold === "OFF"));
      ok("buildConfig pro: no thinkingConfig", cfg.thinkingConfig === undefined);
      ok("buildConfig pro: mediaResolution HIGH", cfg.mediaResolution === "MEDIA_RESOLUTION_HIGH");

      $("include_text").checked = false;
      state.aspect = "16:9";
      const cfg2 = buildConfig();
      ok("buildConfig pro: modalities IMAGE only", JSON.stringify(cfg2.responseModalities) === JSON.stringify(["IMAGE"]));
      eq("buildConfig pro: aspect set when non-auto", cfg2.imageConfig.aspectRatio, "16:9");

      setModelViaPopup("gemini-3.1-flash-image");
      const cfgF = buildConfig();
      ok("buildConfig flash: thinkingConfig set", cfgF.thinkingConfig && typeof cfgF.thinkingConfig.thinkingLevel === "string", JSON.stringify(cfgF.thinkingConfig));
    }

    // ---- Presets carry model + rebuild spec UI (loadPreset fix) ----
    {
      setModelViaPopup("gemini-3.1-flash-image");
      $("person_generation").value = "ALLOW_ADULT";
      const snapshot = readSettings();
      setPresets({ "t-preset": snapshot });
      // Move to a different model + value, then load the preset back.
      setModelViaPopup("gemini-3-pro-image");
      $("person_generation").value = "ALLOW_ALL";
      renderPresetList();
      $("preset-select").value = "t-preset";
      loadPreset();
      eq("preset: model restored", $("model").value, "gemini-3.1-flash-image");
      eq("preset: person_generation restored", $("person_generation").value, "ALLOW_ADULT");
      eq("preset: thinking tab shown for flash preset", thinkingTab().hidden, false);
    }

    // ---- resetDefaults rebuilds spec UI ----
    {
      setModelViaPopup("gemini-3.1-flash-image");
      resetDefaults();
      eq("reset: model -> default pro", $("model").value, "gemini-3-pro-image");
      eq("reset: thinking tab hidden after reset", thinkingTab().hidden, true);
      eq("reset: temperature default", parseFloat($("temperature").value), 1);
    }

    // ---- buildContents multi-turn image stripping ----
    {
      const chat = {
        id: "bc1", title: "t", createdAt: 1, updatedAt: 1,
        turns: [
          { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AAA" } }, { text: "first" }] },
          { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "BBB" } }, { text: "result" }] },
          { role: "user", parts: [{ text: "make it red" }] },
        ],
      };
      state.chats = [chat]; state.currentChatId = "bc1"; state.refs = [];
      const contents = buildContents("now blue");
      const imgs = inlineDatas(contents);
      ok("buildContents: keeps only latest history image", imgs.length === 1 && imgs[0] === "BBB", JSON.stringify(imgs));
      ok("buildContents: first user image stripped", !hasInline(contents[0].parts), JSON.stringify(contents[0]));
      ok("buildContents: first user text retained", contents[0].parts.some(p => p.text === "first"));
      const last = contents[contents.length - 1];
      ok("buildContents: new prompt appended as user turn", last.role === "user" && last.parts.some(p => p.text === "now blue"));

      // With fresh refs, ALL history images are dropped as stale.
      state.refs = [{ name: "r", mime: "image/png", dataB64: "CCC", dataUrl: "data:image/png;base64,CCC" }];
      const contents2 = buildContents("combine");
      const imgs2 = inlineDatas(contents2);
      ok("buildContents: fresh ref drops history images", !imgs2.includes("AAA") && !imgs2.includes("BBB"), JSON.stringify(imgs2));
      ok("buildContents: fresh ref present", imgs2.includes("CCC"));
      state.refs = [];
    }

    // ---- Reference pipeline (File -> dataURL -> dimensions) ----
    {
      state.refs = [];
      const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], "test.png", { type: "image/png" });
      await addRefFiles([file]);
      ok("addRefFiles: one ref added", state.refs.length === 1, state.refs.length);
      ok("addRefFiles: dimensions decoded", state.refs[0] && state.refs[0].width === 1 && state.refs[0].height === 1, JSON.stringify(state.refs[0] && { w: state.refs[0].width, h: state.refs[0].height }));
      state.refs = []; renderRefStrip();
    }

    // ---- buildReportPayload authMode (bug fix) ----
    eq("buildReportPayload: authMode", buildReportPayload("x").appState.authMode, "adc");

    // ---- Non-streaming generation flow ----
    {
      startNewChat();
      $("stream").checked = false;
      $("prompt").value = "a red apple";
      const before = state.session.count;
      await generate();
      const chat = currentChat();
      ok("generate(once): chat created", !!chat, chat && chat.id);
      ok("generate(once): user+assistant turns", chat && chat.turns.length === 2, chat && chat.turns.length);
      const a = chat && chat.turns[1];
      ok("generate(once): assistant has image", a && hasInline(a.parts), JSON.stringify(a && a.parts.map(p => Object.keys(p))));
      ok("generate(once): assistant has text", a && a.parts.some(p => p.text), "");
      eq("generate(once): session.count +1", state.session.count, before + 1);
      ok("generate(once): session cost > 0", state.session.cost > 0, state.session.cost);
      ok("generate(once): cost pill updated", $("session-cost").textContent !== "$0.00", $("session-cost").textContent);
      ok("generate(once): not busy after", state.busy === false);
    }

    // ---- Streaming generation flow ----
    {
      startNewChat();
      $("stream").checked = true;
      $("prompt").value = "make it blue";
      const before = state.session.count;
      await generate();
      await sleep(20);
      const chat = currentChat();
      const a = chat && chat.turns[1];
      ok("generate(stream): assistant has image", a && hasInline(a.parts));
      ok("generate(stream): assistant has streamed text", a && a.parts.some(p => p.text && p.text.includes("caption")), JSON.stringify(a && a.parts));
      eq("generate(stream): session.count +1", state.session.count, before + 1);
      ok("generate(stream): liveTurn finalized", typeof liveTurn === "undefined" || liveTurn === null);
      ok("generate(stream): api was called", window.api.__calls().generateStream >= 1, JSON.stringify(window.api.__calls()));
    }

    // ---- Busy guard ----
    {
      state.busy = true;
      const keepId = state.currentChatId;
      startNewChat(); // should be a no-op (blocked by isBusyAction)
      eq("busy guard: startNewChat no-op while busy", state.currentChatId, keepId);
      state.busy = false;
    }

  } catch (e) {
    ok("UNCAUGHT EXCEPTION", false, (e && e.stack) || String(e));
  }

  return results;
})();
