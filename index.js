const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Home route
app.get("/", (req, res) => {
  res.send("StyleFlow is running!");
});

// WhatsApp webhook verification (GET - Meta verifies your server)
app.get("/whatsapp", (req, res) => {
  console.log("Someone accessed WhatsApp endpoint");

  const VERIFY_TOKEN = "styleflow_token";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta!");
    res.status(200).send(challenge);
  } else {
    res.status(200).send("WhatsApp webhook is active!");
  }
});

// WhatsApp incoming messages (POST - receives actual messages)
app.post("/whatsapp", (req, res) => {
  const body = req.body;

  // Guard: ignore empty requests
  if (!body) {
    console.log("⚠️ Empty request received");
    return res.sendStatus(400);
  }

  console.log("📩 WhatsApp message received");
  console.log(JSON.stringify(body, null, 2)); // ✅ readable format in terminal
  res.sendStatus(200);
});

// 404 handler - unknown routes
app.use((req, res) => {
  console.log(`⚠️ Unknown route accessed: ${req.method} ${req.url}`);
  res.status(404).send("Route not found");
});

// Error handling
app.use((err, req, res, next) => {
  console.error("❌ Error:", err.stack);
  res.status(500).send("Something went wrong!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 StyleFlow server running on port ${PORT}`);
});