import { useState } from "react";
import type { CSSProperties } from "react";
import LogPlayback from "./components/LogPlayback";
import LogPasteViewer from "./components/LogPasteViewer";

const tabStyle = (active: boolean): CSSProperties => ({
  background: active ? "#444" : "#1e1e1e",
  color: active ? "#fff" : "#999",
  border: "none",
  borderBottom: active ? "2px solid #7af" : "2px solid transparent",
  padding: "5px 16px",
  cursor: "pointer",
  fontSize: 13,
});

function App() {
  const [tab, setTab] = useState<"jsonl" | "paste">("jsonl");

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#000" }}>
      <div style={{ display: "flex", background: "#111", borderBottom: "1px solid #333", flexShrink: 0 }}>
        <button style={tabStyle(tab === "jsonl")} onClick={() => setTab("jsonl")}>
          JSONL Playback
        </button>
        <button style={tabStyle(tab === "paste")} onClick={() => setTab("paste")}>
          Paste / Text Log
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {tab === "jsonl" ? <LogPlayback /> : <LogPasteViewer />}
      </div>
    </div>
  );
}

export default App;
