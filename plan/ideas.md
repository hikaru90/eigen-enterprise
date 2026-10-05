# Eigen Enterprise — Ideen

> Sammelordner für Ideen, bis es ein eigenes Repo gibt.

## 2026-09-10 · WebMCP-Integration für Eigen

**Quelle:** W3C WebMCP Spec (Draft Community Group Report, 10.09.2026, Redakteure: Microsoft + Google)
- Spec: https://webmachinelearning.github.io/webmcp/
- GitHub: https://github.com/webmachinelearning/webmcp
- Polyfill/SDKs: https://docs.mcp-b.ai/ · Typen: `webmcp-types` (npm)
- Chrome Origin Trial: https://developer.chrome.com/blog/ai-webmcp-origin-trial

### Was es ist
WebMCP macht Webseiten zu MCP-Servern im Browser: Die Seite registriert
JS-Funktionen als Tools (Name + natürlichsprachliche Beschreibung + JSON-Schema),
die Browser-Agenten (Chrome 149+ / Edge 150+ / ChatGPT Desktop) direkt aufrufen
können. Es gibt auch eine deklarative Variante: `<form>`-Elemente werden
automatisch zu Tools synthetisiert.

```js
await document.modelContext.registerTool({
  name: "capture-note",
  description: "Captures a new note in the user's Eigen memory",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async execute({ text }) { /* bestehende Client-Logik wiederverwenden */ }
});
```

### Warum es zu Eigen passt
- "The product is not a database, it's an agent" — WebMCP ist die clientseitige
  Ergänzung zur bestehenden Agent-Readiness (llms.txt, OpenAPI, JSON-Errors).
- Kein Auth/State-Duplikat: Tool-Calls laufen im eingeloggten Browser-Session-
  Kontext des Nutzers, die Eigen-UI bleibt sichtbar (human-in-the-loop).
- Ergänzt Backend-Integrationen (MCP/OpenAPI), ersetzt sie nicht.

### Implementierungsplan (Progressive Enhancement)
1. Feature-Detection (`'modelContext' in document`) + Tools registrieren:
   - `capture` (fire-and-forget, Kern-Feature)
   - `search` (ask-nature retrieval)
   - `list-projects` / `add-to-project` (GTD)
2. MCP-B-Polyfill für Browser ohne natives WebMCP.
3. OpenAPI + llms.txt parallel halten (Server-Integration, z.B. für Hermes).
4. Security-Abschnitt der Spec beachten (Prompt Injection, Tool Poisoning,
   Output Injection; Responses als `untrusted` annotierbar) — wichtig bei
   Schreib-Tools.
5. Später: Chrome Early Preview Program für Origin-Trial-Token.

### Status der Browser (Stand 10.09.2026)
- Chrome 149: Origin Trial ✅ (lokal: `about:flags#enable-webmcp-testing`)
- Edge 150: Origin Trial ✅
- ChatGPT Desktop: unterstützt ✅
- Brave (Leo AI): experimentell
- Firefox / Safari: noch offen (Standards-Positions pending)

### Ehrliche Einschränkung
Draft-Report, kein Standard. API kann sich ändern. Als Progressive Enhancement
von Tag 1 mitdenken, Kern-UX nicht davon abhängig machen.
