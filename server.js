import express from "express";
import cors from "cors";
import { createServer } from "http";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Serve static frontend
app.use(express.static(join(__dirname, "dist")));

// Proxy route — client sends { apiKey, ...anthropicPayload }
app.post("/api/chat", async (req, res) => {
  const { apiKey, ...payload } = req.body;

  if (!apiKey || !apiKey.startsWith("sk-ant-")) {
    return res.status(401).json({ error: "Invalid or missing Anthropic API key" });
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("Upstream error:", err.message);
    res.status(502).json({ error: "Failed to reach Anthropic API", detail: err.message });
  }
});

// Fallback to SPA
app.get("*", (_req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

const PORT = process.env.PORT || 3000;
createServer(app).listen(PORT, () => {
  console.log(`\n⚡ Dodge AI · SAP O2C Graph Explorer`);
  console.log(`   Server running at http://localhost:${PORT}\n`);
});
